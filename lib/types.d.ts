/**
 * Type definitions for github-copilot-acp Provider
 */
export interface CopilotAcpConfig {
    /** Copilot CLI executable path (defaults to "copilot") */
    command?: string;
    /** Command line arguments (defaults to ["--acp"]) */
    args?: string[];
    /** Working directory for child process (defaults to process.cwd()) */
    cwd?: string;
    /** Timeout for ACP calls in milliseconds (defaults to 900,000 = 15m) */
    timeoutMs?: number;
    /** Timeout for model discovery in milliseconds (defaults to 10,000) */
    modelDiscoveryTimeoutMs?: number;
    /** Pass --allow-all-tools or permit tool operations (defaults to true) */
    allowAllTools?: boolean;
    /** Whether to allow local fs reads/writes requested by Copilot (defaults to true) */
    allowFileRequests?: boolean;
    /** Specific model to pass to Copilot CLI (e.g. via --model) */
    model?: string;
    /** Custom configured models list */
    models?: Array<{
        id: string;
        name?: string;
        inputModalities?: string[];
        contextWindow?: number;
    }>;
}
export type DshRole = 'system' | 'user' | 'assistant' | 'tool' | 'developer';
export interface DshTextBlock {
    type: 'text';
    text: string;
}
export interface DshReasoningBlock {
    type: 'reasoning';
    text: string;
}
export interface DshToolCallBlock {
    type: 'tool-call';
    id: string;
    name: string;
    arguments: string;
}
export type DshContentBlock = DshTextBlock | DshReasoningBlock | DshToolCallBlock | {
    type: string;
    [key: string]: any;
};
export interface DshMessage {
    role: DshRole;
    content: DshContentBlock[];
    id?: string;
    toolCallId?: string;
    isError?: boolean;
}
export interface DshToolDeclaration {
    name: string;
    description?: string;
    parameters?: Record<string, any>;
    deferLoading?: boolean;
}
export interface GenerateOptions {
    provider: string;
    model: string;
    messages: DshMessage[];
    system?: string;
    tools?: DshToolDeclaration[];
    toolChoice?: any;
    signal?: AbortSignal;
    temperature?: number;
    maxTokens?: number;
    sessionId?: string;
    reasoningEffort?: string;
    stop?: any;
    cwd?: string;
}
export type StreamChunkBlockType = 'text' | 'reasoning' | 'tool-call';
export interface BlockStartChunk {
    type: 'block-start';
    index: number;
    blockType: StreamChunkBlockType;
}
export interface TextDeltaChunk {
    type: 'text-delta';
    index: number;
    text: string;
}
export interface ReasoningDeltaChunk {
    type: 'reasoning-delta';
    index: number;
    text: string;
}
export interface ToolCallDeltaChunk {
    type: 'tool-call-delta';
    index: number;
    id: string;
    name?: string;
    argumentsDelta: string;
}
export interface BlockEndChunk {
    type: 'block-end';
    index: number;
    block: DshContentBlock;
}
export interface UsageChunk {
    type: 'usage';
    usage: {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
    };
}
export interface FinishReason {
    kind: 'stop' | 'tool-calls' | 'aborted' | 'error' | 'max-tokens';
    failure?: {
        message: string;
        code: string;
    };
}
export interface FinishChunk {
    type: 'finish';
    reason: FinishReason;
}
export type DshStreamChunk = BlockStartChunk | TextDeltaChunk | ReasoningDeltaChunk | ToolCallDeltaChunk | BlockEndChunk | UsageChunk | FinishChunk;
export interface ModelDescriptor {
    provider: string;
    id: string;
    name: string;
    inputModalities?: string[];
    context?: {
        contextWindow: number;
    };
}
