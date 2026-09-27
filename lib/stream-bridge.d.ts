import type { DshStreamChunk } from './types.js';
export declare class AcpStreamEmitter {
    private blockIndex;
    private currentBlockType;
    private currentBlockText;
    private currentToolCall;
    private hasEmittedToolCall;
    private fullMessageText;
    private fullReasoningText;
    private messageParseBuffer;
    private insideToolCallTag;
    private settled;
    /**
     * Close the currently open block if any
     */
    closeCurrentBlock(): DshStreamChunk[];
    private openTextBlockIfNeeded;
    private emitVisibleText;
    /**
     * Stream visible assistant text while withholding <tool_call> blocks.
     * The parser keeps a possible partial tag suffix across ACP chunks.
     */
    private consumeMessageText;
    private flushMessageParser;
    /**
     * Handle an ACP session/update notification and convert to DSH stream chunks
     */
    handleSessionUpdate(update: any): DshStreamChunk[];
    /**
     * Finalize the stream and produce finish chunk
     */
    finish(signal?: AbortSignal, error?: any): DshStreamChunk[];
}
