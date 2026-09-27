import type {
  DshStreamChunk,
  FinishReason,
  StreamChunkBlockType,
} from './types.js';
import { extractToolCallsFromText } from './prompt-bridge.js';

export class AcpStreamEmitter {
  private blockIndex = 0;
  private currentBlockType: StreamChunkBlockType | null = null;
  private currentBlockText = '';
  private currentToolCall: { id: string; name: string; rawArgs: string } | null = null;
  private hasEmittedToolCall = false;
  private fullMessageText = '';
  private fullReasoningText = '';
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
    } else if (this.currentBlockType === 'tool-call' && this.currentToolCall) {
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
      this.fullMessageText += text;
      chunks.push({
        type: 'text-delta',
        index: this.blockIndex,
        text,
      });
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

    // Check if any tool calls were embedded in text as <tool_call>
    if (!this.hasEmittedToolCall && this.fullMessageText.includes('<tool_call>')) {
      const { toolCalls, cleanedText } = extractToolCallsFromText(this.fullMessageText);
      if (toolCalls.length > 0) {
        // If current block is text, replace content with cleanedText
        if (this.currentBlockType === 'text') {
          this.currentBlockText = cleanedText;
        }
        chunks.push(...this.closeCurrentBlock());

        // Emit extracted tool calls
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
      } else {
        chunks.push(...this.closeCurrentBlock());
      }
    } else {
      chunks.push(...this.closeCurrentBlock());
    }

    let finishReason: FinishReason;
    if (signal?.aborted) {
      finishReason = { kind: 'aborted' };
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
