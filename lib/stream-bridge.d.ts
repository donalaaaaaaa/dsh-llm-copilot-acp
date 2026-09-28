import type { DshStreamChunk } from './types.js';
export declare class AcpStreamEmitter {
    private blockIndex;
    private currentBlockType;
    private currentBlockText;
    private currentToolCall;
    private hasEmittedToolCall;
    private pendingMessageText;
    private settled;
    /** Close the currently open block if any. */
    closeCurrentBlock(): DshStreamChunk[];
    private appendText;
    private emitToolCall;
    private trailingToolPrefixLength;
    /**
     * Drain assistant text without ever exposing complete or partial tool tags as
     * text deltas. Incomplete tag prefixes are retained until the next update.
     */
    private drainMessageBuffer;
    /** Handle an ACP session/update notification and convert to DSH stream chunks. */
    handleSessionUpdate(update: any): DshStreamChunk[];
    /** Finalize the stream and produce the DSH finish chunk. */
    finish(signal?: AbortSignal, error?: any, stopReason?: string): DshStreamChunk[];
}
