import { extractToolCallsFromText } from './prompt-bridge.js';
const TOOL_OPEN = '<tool_call>';
const TOOL_CLOSE = '</tool_call>';
export class AcpStreamEmitter {
    blockIndex = 0;
    currentBlockType = null;
    currentBlockText = '';
    currentToolCall = null;
    hasEmittedToolCall = false;
    pendingMessageText = '';
    settled = false;
    /** Close the currently open block if any. */
    closeCurrentBlock() {
        const chunks = [];
        if (!this.currentBlockType)
            return chunks;
        if (this.currentBlockType === 'text') {
            chunks.push({
                type: 'block-end',
                index: this.blockIndex,
                block: {
                    type: 'text',
                    text: this.currentBlockText,
                },
            });
        }
        else if (this.currentBlockType === 'reasoning') {
            chunks.push({
                type: 'block-end',
                index: this.blockIndex,
                block: {
                    type: 'reasoning',
                    text: this.currentBlockText,
                },
            });
        }
        else if (this.currentBlockType === 'tool-call' && this.currentToolCall) {
            chunks.push({
                type: 'block-end',
                index: this.blockIndex,
                block: {
                    type: 'tool-call',
                    id: this.currentToolCall.id,
                    name: this.currentToolCall.name,
                    arguments: this.currentToolCall.rawArgs,
                },
            });
            this.currentToolCall = null;
        }
        this.currentBlockType = null;
        this.currentBlockText = '';
        this.blockIndex++;
        return chunks;
    }
    appendText(text, chunks) {
        if (!text)
            return;
        if (this.currentBlockType !== 'text') {
            chunks.push(...this.closeCurrentBlock());
            this.currentBlockType = 'text';
            this.currentBlockText = '';
            chunks.push({
                type: 'block-start',
                index: this.blockIndex,
                blockType: 'text',
            });
        }
        this.currentBlockText += text;
        chunks.push({
            type: 'text-delta',
            index: this.blockIndex,
            text,
        });
    }
    emitToolCall(call, chunks) {
        chunks.push(...this.closeCurrentBlock());
        this.hasEmittedToolCall = true;
        chunks.push({
            type: 'block-start',
            index: this.blockIndex,
            blockType: 'tool-call',
        });
        chunks.push({
            type: 'tool-call-delta',
            index: this.blockIndex,
            id: call.id,
            name: call.name,
            argumentsDelta: call.rawArguments,
        });
        chunks.push({
            type: 'block-end',
            index: this.blockIndex,
            block: {
                type: 'tool-call',
                id: call.id,
                name: call.name,
                arguments: call.rawArguments,
            },
        });
        this.blockIndex++;
    }
    trailingToolPrefixLength(text) {
        const lower = text.toLowerCase();
        const marker = TOOL_OPEN.toLowerCase();
        const max = Math.min(lower.length, marker.length - 1);
        for (let len = max; len > 0; len--) {
            if (lower.endsWith(marker.slice(0, len)))
                return len;
        }
        return 0;
    }
    /**
     * Drain assistant text without ever exposing complete or partial tool tags as
     * text deltas. Incomplete tag prefixes are retained until the next update.
     */
    drainMessageBuffer(final) {
        const chunks = [];
        while (this.pendingMessageText.length > 0) {
            const lower = this.pendingMessageText.toLowerCase();
            const start = lower.indexOf(TOOL_OPEN);
            if (start < 0) {
                if (final) {
                    this.appendText(this.pendingMessageText, chunks);
                    this.pendingMessageText = '';
                    break;
                }
                const keep = this.trailingToolPrefixLength(this.pendingMessageText);
                const emitLength = this.pendingMessageText.length - keep;
                if (emitLength > 0) {
                    this.appendText(this.pendingMessageText.slice(0, emitLength), chunks);
                    this.pendingMessageText = this.pendingMessageText.slice(emitLength);
                }
                break;
            }
            if (start > 0) {
                this.appendText(this.pendingMessageText.slice(0, start), chunks);
                this.pendingMessageText = this.pendingMessageText.slice(start);
                continue;
            }
            const closeIndex = lower.indexOf(TOOL_CLOSE, TOOL_OPEN.length);
            if (closeIndex < 0) {
                if (final) {
                    this.appendText(this.pendingMessageText, chunks);
                    this.pendingMessageText = '';
                }
                break;
            }
            const end = closeIndex + TOOL_CLOSE.length;
            const block = this.pendingMessageText.slice(0, end);
            const parsed = extractToolCallsFromText(block).toolCalls;
            if (parsed.length === 0) {
                this.appendText(block, chunks);
            }
            else {
                for (const call of parsed)
                    this.emitToolCall(call, chunks);
            }
            this.pendingMessageText = this.pendingMessageText.slice(end);
        }
        return chunks;
    }
    /** Handle an ACP session/update notification and convert to DSH stream chunks. */
    handleSessionUpdate(update) {
        const chunks = [];
        if (!update || typeof update !== 'object')
            return chunks;
        const kind = String(update.sessionUpdate || '').trim();
        if (kind === 'agent_thought_chunk') {
            const text = typeof update.content === 'object' ? update.content?.text || '' : String(update.content || '');
            if (!text)
                return chunks;
            if (this.currentBlockType !== 'reasoning') {
                chunks.push(...this.closeCurrentBlock());
                this.currentBlockType = 'reasoning';
                this.currentBlockText = '';
                chunks.push({
                    type: 'block-start',
                    index: this.blockIndex,
                    blockType: 'reasoning',
                });
            }
            this.currentBlockText += text;
            chunks.push({
                type: 'reasoning-delta',
                index: this.blockIndex,
                text,
            });
        }
        else if (kind === 'agent_message_chunk') {
            const text = typeof update.content === 'object' ? update.content?.text || '' : String(update.content || '');
            if (!text)
                return chunks;
            this.pendingMessageText += text;
            chunks.push(...this.drainMessageBuffer(false));
        }
        else if (kind === 'tool_call' || kind === 'tool_call_update' || kind === 'usage_update') {
            // Copilot-native tools are executed by Copilot itself. Re-emitting them as
            // DSH tool calls would duplicate side effects. usage_update is context
            // occupancy rather than prompt/completion token accounting.
            return chunks;
        }
        return chunks;
    }
    /** Finalize the stream and produce the DSH finish chunk. */
    finish(signal, error, stopReason) {
        if (this.settled)
            return [];
        this.settled = true;
        const chunks = [];
        chunks.push(...this.drainMessageBuffer(true));
        chunks.push(...this.closeCurrentBlock());
        let finishReason;
        if (signal?.aborted || stopReason === 'cancelled') {
            finishReason = { kind: 'aborted' };
        }
        else if (error) {
            finishReason = {
                kind: 'error',
                failure: {
                    message: error.message || String(error),
                    code: error.code || 'ACP_ERROR',
                },
            };
        }
        else if (this.hasEmittedToolCall) {
            finishReason = { kind: 'tool-calls' };
        }
        else if (stopReason === 'max_tokens') {
            finishReason = { kind: 'max-tokens' };
        }
        else if (stopReason === 'refusal') {
            finishReason = {
                kind: 'error',
                failure: {
                    message: 'Copilot ACP refused the prompt.',
                    code: 'ACP_REFUSAL',
                },
            };
        }
        else if (stopReason === 'max_turn_requests') {
            finishReason = {
                kind: 'error',
                failure: {
                    message: 'Copilot ACP reached its maximum turn request limit.',
                    code: 'ACP_MAX_TURN_REQUESTS',
                },
            };
        }
        else {
            finishReason = { kind: 'stop' };
        }
        chunks.push({
            type: 'finish',
            reason: finishReason,
        });
        return chunks;
    }
}
