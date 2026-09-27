import type { DshToolDeclaration, GenerateOptions } from './types.js';
/**
 * Render tool declarations for prompt bridge
 */
export declare function renderToolBridge(tools?: DshToolDeclaration[]): string[];
/**
 * Render message content blocks to readable text
 */
export declare function renderContent(content: any): string;
/**
 * Format full conversation messages and tools into an ACP prompt
 */
export declare function formatMessagesAsPrompt(options: GenerateOptions): string;
export interface ExtractedToolCall {
    id: string;
    name: string;
    arguments: Record<string, any>;
    rawArguments: string;
}
/**
 * Extract <tool_call>{...}</tool_call> blocks from text (Hermes Agent compatible)
 */
export declare function extractToolCallsFromText(text: string): {
    toolCalls: ExtractedToolCall[];
    cleanedText: string;
};
