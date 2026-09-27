import { createHash } from 'node:crypto';
import { formatMessagesAsPrompt } from './prompt-bridge.js';
import type {
  DshContentBlock,
  DshMessage,
  GenerateOptions,
  ReplayEnvelope,
} from './types.js';

interface CopilotReplayResponse {
  kind: 'copilot-acp';
  version: 1;
  provider: string;
  model: string;
  sessionId: string;
  historyHash: string;
}

interface CopilotReplayBlock {
  type: string;
}

export interface CopilotReplayAnchor {
  sessionId: string;
  messageIndex: number;
  suffix: DshMessage[];
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function promptForHistory(options: GenerateOptions, messages: readonly DshMessage[]): string {
  return formatMessagesAsPrompt({
    ...options,
    messages: [...messages],
  });
}

function historyHash(options: GenerateOptions, messages: readonly DshMessage[]): string {
  return sha256(promptForHistory(options, messages));
}

function syntheticAssistant(content: readonly DshContentBlock[]): DshMessage {
  // Prompt serialization only consumes role/content. Durable message identity
  // and source are added by DSH after the stream finishes.
  return {
    role: 'assistant',
    content: [...content],
  } as DshMessage;
}

function replayObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseReplay(
  message: DshMessage,
  provider: string,
  model: string
): CopilotReplayResponse | undefined {
  if (message.role !== 'assistant') return undefined;
  const source = 'source' in message ? message.source : undefined;
  if (!source || source.kind !== 'model' || source.provider !== provider || source.model !== model) {
    return undefined;
  }

  const envelope = replayObject(source.replayState);
  const response = replayObject(envelope?.response);
  if (
    response?.kind !== 'copilot-acp'
    || response.version !== 1
    || response.provider !== provider
    || response.model !== model
    || typeof response.sessionId !== 'string'
    || response.sessionId.length === 0
    || typeof response.historyHash !== 'string'
    || !/^[a-f0-9]{64}$/.test(response.historyHash)
  ) {
    return undefined;
  }

  const blocks = envelope?.blocks;
  if (!Array.isArray(blocks) || blocks.length !== message.content.length) return undefined;
  for (let index = 0; index < blocks.length; index++) {
    const replay = replayObject(blocks[index]);
    if (replay?.type !== message.content[index]?.type) return undefined;
  }

  return response as unknown as CopilotReplayResponse;
}

/**
 * Persist only the ACP identity plus a digest of the exact prompt that a fresh
 * session would receive through this assistant response. Durable DSH content
 * stays authoritative; the state is merely a verified optimization token.
 */
export function createCopilotReplayState(
  options: GenerateOptions,
  sessionId: string,
  assistantContent: readonly DshContentBlock[]
): ReplayEnvelope {
  const messages = [...options.messages, syntheticAssistant(assistantContent)];
  const response: CopilotReplayResponse = {
    kind: 'copilot-acp',
    version: 1,
    provider: options.provider,
    model: options.model,
    sessionId,
    historyHash: historyHash(options, messages),
  };
  const blocks: CopilotReplayBlock[] = assistantContent.map((block) => ({ type: block.type }));
  return { response, blocks };
}

/**
 * Find the newest assistant message whose ACP replay state exactly matches the
 * current provider-visible prefix. Any compaction, rewrite, model/tool/system
 * change, malformed state or block mismatch naturally falls back to a fresh
 * ACP session.
 */
export function findCopilotReplayAnchor(options: GenerateOptions): CopilotReplayAnchor | undefined {
  for (let index = options.messages.length - 1; index >= 0; index--) {
    const message = options.messages[index];
    if (!message) continue;
    const replay = parseReplay(message, options.provider, options.model);
    if (!replay) continue;

    const prefix = options.messages.slice(0, index + 1);
    if (historyHash(options, prefix) !== replay.historyHash) continue;

    const suffix = options.messages.slice(index + 1);
    if (suffix.length === 0) continue;
    return {
      sessionId: replay.sessionId,
      messageIndex: index,
      suffix,
    };
  }
  return undefined;
}
