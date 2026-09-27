import type {
  DshStreamChunk,
  FinishReason,
  StreamChunkBlockType,
} from './types.js';
import { extractToolCallsFromText } from './prompt-bridge.js';

export class AcpStreamEmitter {
  private blockIndex = 0;
  private currentBlockType: Extract<StreamChunkBlockType, 'text' | 'reasoning'> | null = null;
  private currentBlockText = '';
  private hasEmittedToolCall = false;
  private fullMessageText = '';
  private fullReasoningText = '';
  private messageParseBuffer = '';
  private insideToolCallTag = false;
  private settled = false;

  /**
   * Close the currently open block if any
   */
  public closeCurrentBlock(): DshStreamChunk[] {
    const chunks: DshStreamChunk[] = [];
    if (!this.currentBlockType) return chunks;

    if (this.currentBlockType === 'text') {
      chunks.push({
        type: 'block-end',
        index: this.blockIndex,
        block: {
          type: 'text',
          text: this.currentBlockText,
        },
      });
    } else if (this.currentBlockType === 'reasoning') {
      chunks.push({
        type: 'block-end',
        index: this.blockIndex,
        block: {
          type: 'reasoning',
          text: this.currentBlockText,
        },
      });
    }

    this.currentBlockType = null;
    this.currentBlockText = '';
    this.blockIndex++;
    return chunks;
  }

  private openTextBlockIfNeeded(chunks: DshStreamChunk[]): void {
    if (this.currentBlockType === 'text') return;
    chunks.push(...this.closeCurrentBlock());
    this.currentBlockType = 'text';
    this.currentBlockText = '';
    chunks.push({
      type: 'block-start',
      index: this.blockIndex,
      blockType: 'text',
    });
  }

  private emitVisibleText(text: string, chunks: DshStreamChunk[]): void {
    if (!text) return;
    this.openTextBlockIfNeeded(chunks);
    this.currentBlockText += text;
    chunks.push({
      type: 'text-delta',
      index: this.blockIndex,
      text,
    });
  }

  /**
   * Stream visible assistant text while withholding <tool_call> blocks.
   * The parser keeps a possible partial tag suffix across ACP chunks.
   */
  private consumeMessageText(text: string): DshStreamChunk[] {
    const chunks: DshStreamChunk[] = [];
    const openTag = '<tool_call>';
    const closeTag = '</tool_call>';
    this.fullMessageText += text;
    this.messageParseBuffer += text;

    while (this.messageParseBuffer.length > 0) {
      const lower = this.messageParseBuffer.toLowerCase();

      if (this.insideToolCallTag) {
        const closeIndex = lower.indexOf(closeTag);
        if (closeIndex < 0) break;
        this.messageParseBuffer = this.messageParseBuffer.slice(closeIndex + closeTag.length);
        this.insideToolCallTag = false;
        continue;
      }

      const openIndex = lower.indexOf(openTag);
      if (openIndex >= 0) {
        this.emitVisibleText(this.messageParseBuffer.slice(0, openIndex), chunks);
        this.messageParseBuffer = this.messageParseBuffer.slice(openIndex + openTag.length);
        this.insideToolCallTag = true;
        continue;
      }

      let partialLength = 0;
      const max = Math.min(openTag.length - 1, this.messageParseBuffer.length);
      for (let length = max; length > 0; length--) {
        if (lower.endsWith(openTag.slice(0, length))) {
          partialLength = length;
          break;
        }
      }
      const safeLength = this.messageParseBuffer.length - partialLength;
      this.emitVisibleText(this.messageParseBuffer.slice(0, safeLength), chunks);
      this.messageParseBuffer = this.messageParseBuffer.slice(safeLength);
      break;
    }

    return chunks;
  }

  private flushMessageParser(chunks: DshStreamChunk[]): void {
    if (!this.messageParseBuffer) return;
    // An unclosed tag is not a valid tool call, so preserve it as assistant text.
    const prefix = this.insideToolCallTag ? '<tool_call>' : '';
    this.emitVisibleText(prefix + this.messageParseBuffer, chunks);
    this.messageParseBuffer = '';
    this.insideToolCallTag = false;
  }

  /**
   * Handle an ACP session/update notification and convert to DSH stream chunks
   */
  public handleSessionUpdate(update: any): DshStreamChunk[] {
    const chunks: DshStreamChunk[] = [];
    if (!update || typeof update !== 'object') return chunks;

    const kind = String(update.sessionUpdate || '').trim();

    if (kind === 'agent_thought_chunk') {
      const text = typeof update.content === 'object' ? update.content?.text || '' : String(update.content || '');
      if (!text) return chunks;

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
      this.fullReasoningText += text;
      chunks.push({
        type: 'reasoning-delta',
        index: this.blockIndex,
        text,
      });
    } else if (kind === 'agent_message_chunk') {
      const text = typeof update.content === 'object' ? update.content?.text || '' : String(update.content || '');
      if (!text) return chunks;
      chunks.push(...this.consumeMessageText(text));
    } else if (kind === 'tool_call' || kind === 'tool_call_update' || kind === 'usage_update') {
      // Copilot executes its own tools and reports them here. Those events are not
      // DSH tool requests: emitting tool-call chunks would make the agent loop run
      // them again. usage_update is context occupancy, not prompt/completion tokens.
      return chunks;
    }

    return chunks;
  }

  /**
   * Finalize the stream and produce finish chunk
   */
  public finish(signal?: AbortSignal, error?: any): DshStreamChunk[] {
    if (this.settled) return [];
    this.settled = true;
    const chunks: DshStreamChunk[] = [];

    this.flushMessageParser(chunks);
    const { toolCalls } = extractToolCallsFromText(this.fullMessageText);
    chunks.push(...this.closeCurrentBlock());

    if (!signal?.aborted && !error) {
      for (const tc of toolCalls) {
        this.hasEmittedToolCall = true;
        chunks.push({
          type: 'block-start',
          index: this.blockIndex,
          blockType: 'tool-call',
        });
        chunks.push({
          type: 'tool-call-delta',
          index: this.blockIndex,
          id: tc.id,
          name: tc.name,
          argumentsDelta: tc.rawArguments,
        });
        chunks.push({
          type: 'block-end',
          index: this.blockIndex,
          block: {
            type: 'tool-call',
            id: tc.id,
            name: tc.name,
            arguments: tc.rawArguments,
          },
        });
        this.blockIndex++;
      }
    }

    let finishReason: FinishReason;
    if (signal?.aborted) {
      finishReason = {
        kind: 'aborted',
        failure: {
          message: 'Copilot ACP request was aborted.',
          code: 'ABORTED',
        },
      };
    } else if (error) {
      finishReason = {
        kind: 'error',
        failure: {
          message: error.message || String(error),
          code: error.code || 'ACP_ERROR',
        },
      };
    } else if (this.hasEmittedToolCall) {
      finishReason = { kind: 'tool-calls' };
    } else {
      finishReason = { kind: 'stop' };
    }

    chunks.push({
      type: 'finish',
      reason: finishReason,
    });

    return chunks;
  }
}
