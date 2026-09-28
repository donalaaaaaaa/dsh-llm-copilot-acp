import { randomUUID } from 'node:crypto';
import type { DshMessage, DshToolDeclaration, GenerateOptions } from './types.js';

const PROMPT_PREAMBLE = [
  'You are being used as the active ACP agent backend for DeepSeek Harness.',
  'Use the conversation context to complete the user request.',
];

const ROLE_LABELS: Record<string, string> = {
  system: 'System',
  user: 'User',
  assistant: 'Assistant',
  tool: 'Tool',
  developer: 'System',
};

/**
 * Render tool declarations for prompt bridge
 */
export function renderToolBridge(tools?: DshToolDeclaration[]): string[] {
  if (!tools || tools.length === 0) return [];
  const definitions = tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.parameters || { type: 'object', properties: {} },
    },
  }));

  return [
    '# Available Tools',
    'You have access to the following tools:',
    '```json',
    JSON.stringify(definitions, null, 2),
    '```',
  ];
}

/**
 * Render message content blocks to readable text
 */
export function renderContent(content: any): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item === 'string') {
        parts.push(item);
      } else if (item && typeof item === 'object') {
        if (item.type === 'text' && typeof item.text === 'string') {
          parts.push(item.text);
        } else if (item.type === 'reasoning' && typeof item.text === 'string') {
          parts.push(`[Thinking: ${item.text}]`);
        } else if (item.type === 'tool-call') {
          const name = item.name || 'tool';
          let args: unknown = item.arguments ?? {};
          if (typeof args === 'string') {
            try {
              args = JSON.parse(args);
            } catch {
              args = { raw: args };
            }
          }
          parts.push(`<tool_call>${JSON.stringify({ name, arguments: args })}</tool_call>`);
        } else if (item.type === 'image' || item.type === 'file') {
          parts.push(`[${item.type} omitted; this ACP bridge sends text only]`);
        } else if (typeof item.content === 'string') {
          parts.push(item.content);
        } else {
          parts.push(JSON.stringify(item));
        }
      }
    }
    return parts.join('\n').trim();
  }
  if (typeof content === 'object') {
    if (content.text && typeof content.text === 'string') return content.text.trim();
    if (content.content && typeof content.content === 'string') return content.content.trim();
    return JSON.stringify(content);
  }
  return String(content).trim();
}

/**
 * Format full conversation messages and tools into an ACP prompt
 */
export function formatMessagesAsPrompt(options: GenerateOptions): string {
  const sections: string[] = [...PROMPT_PREAMBLE];

  if (options.system && options.system.trim()) {
    sections.push(`System Instructions:\n${options.system.trim()}`);
  }

  if (options.tools && options.tools.length > 0) {
    sections.push(
      'DeepSeek Harness owns execution of the tools listed below. Do not execute an equivalent Copilot-native tool for the same action. Instead, request the DSH tool by emitting exactly <tool_call>{"name":"...","arguments":{...}}</tool_call>. Do not wrap the block in Markdown.'
    );
  }

  const toolSections = renderToolBridge(options.tools);
  if (toolSections.length > 0) {
    sections.push(...toolSections);
  }

  const transcript: string[] = [];
  for (const message of options.messages || []) {
    if (!message || typeof message !== 'object') continue;
    const role = (message.role || 'user').toLowerCase();
    const roleLabel = ROLE_LABELS[role] || 'Context';
    let rendered = renderContent(message.content);

    if (role === 'tool') {
      const toolId = message.toolCallId ? ` (call_id: ${message.toolCallId})` : '';
      const prefix = message.isError ? `[Error] ` : '';
      transcript.push(`${roleLabel}${toolId}:\n${prefix}${rendered || '(no output)'}`);
    } else if (rendered) {
      transcript.push(`${roleLabel}:\n${rendered}`);
    }
  }

  if (transcript.length > 0) {
    sections.push('Conversation transcript:\n\n' + transcript.join('\n\n'));
  }

  sections.push('Continue the conversation from the latest user request.');
  return sections.filter((s) => s && s.trim().length > 0).join('\n\n');
}

export interface ExtractedToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
  rawArguments: string;
}

/**
 * Extract <tool_call>{...}</tool_call> blocks from text (Hermes Agent compatible)
 */
export function extractToolCallsFromText(text: string): {
  toolCalls: ExtractedToolCall[];
  cleanedText: string;
} {
  const toolCalls: ExtractedToolCall[] = [];
  const regex = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const rawJson = match[1].trim();
    try {
      const parsed = JSON.parse(rawJson);
      let name = '';
      let args: any = {};
      let id = parsed.id || `call_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

      if (parsed.function && typeof parsed.function === 'object') {
        name = parsed.function.name || '';
        args = parsed.function.arguments || {};
      } else {
        name = parsed.name || '';
        args = parsed.arguments || parsed.parameters || {};
      }

      const argsObj = typeof args === 'string' ? JSON.parse(args) : args;
      const rawArgs = typeof args === 'string' ? args : JSON.stringify(args);

      if (name) {
        toolCalls.push({
          id,
          name,
          arguments: argsObj,
          rawArguments: rawArgs,
        });
      }
    } catch {
      // If parsing fails, ignore non-JSON blocks
    }
  }

  const cleanedText = text.replace(regex, '').trim();
  return { toolCalls, cleanedText };
}
