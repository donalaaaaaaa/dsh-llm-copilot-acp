import type {
  ContentBlock,
  ContentBlockType,
  FinishReason,
  GenerateOptions as DshGenerateOptions,
  LlmResolvedModelInfo,
  ModelModality,
  ReplayEnvelope,
  RequestMessage,
  StreamChunk,
  ToolCallId,
  ToolSchema,
} from '@deepseek-ai/dsh-llm';

/**
 * Provider configuration. DSH request/stream vocabulary is imported from
 * @deepseek-ai/dsh-llm rather than duplicated locally.
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
  /** Permit Copilot tool operations without interactive approval (defaults to false) */
  allowAllTools?: boolean;
  /** Whether to allow local fs reads/writes requested by Copilot (defaults to false) */
  allowFileRequests?: boolean;
  /** Custom configured models list */
  models?: Array<{
    id: string;
    name?: string;
    inputModalities?: ModelModality[];
    contextWindow?: number;
  }>;
}

export type GenerateOptions = DshGenerateOptions;
export type DshStreamChunk = StreamChunk;
export type DshMessage = RequestMessage;
export type DshToolDeclaration = ToolSchema;
export type ModelDescriptor = LlmResolvedModelInfo;
export type DshContentBlock = ContentBlock;
export type StreamChunkBlockType = ContentBlockType;
export type { FinishReason, ReplayEnvelope, ToolCallId };
