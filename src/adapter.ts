import { CopilotAcpClient } from './client.js';
import { formatMessagesAsPrompt } from './prompt-bridge.js';
import { AcpStreamEmitter } from './stream-bridge.js';
import type {
  CopilotAcpConfig,
  DshStreamChunk,
  GenerateOptions,
  ModelDescriptor,
  ModelReasoningEffort,
  ModelReasoningInfo,
} from './types.js';

/**
 * Simple async queue for streaming chunks from callbacks to an AsyncIterator
 */
class AsyncChunkQueue {
  private queue: DshStreamChunk[] = [];
  private waiters: Array<{
    resolve: (res: IteratorResult<DshStreamChunk>) => void;
    reject: (err: any) => void;
  }> = [];
  private closed = false;
  private error: any = null;

  public push(chunk: DshStreamChunk): void {
    if (this.closed) return;
    if (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter.resolve({ value: chunk, done: false });
    } else {
      this.queue.push(chunk);
    }
  }

  public pushMany(chunks: DshStreamChunk[]): void {
    for (const c of chunks) {
      this.push(c);
    }
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter.resolve({ value: undefined as any, done: true });
    }
  }

  public fail(err: any): void {
    if (this.closed) return;
    this.closed = true;
    this.error = err;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter.reject(err);
    }
  }

  public async next(): Promise<IteratorResult<DshStreamChunk>> {
    if (this.queue.length > 0) {
      return { value: this.queue.shift()!, done: false };
    }
    if (this.closed) {
      if (this.error) throw this.error;
      return { value: undefined as any, done: true };
    }
    return new Promise<IteratorResult<DshStreamChunk>>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  public [Symbol.asyncIterator](): AsyncIterator<DshStreamChunk> {
    return {
      next: () => this.next(),
    };
  }
}

const EFFORT_DISPLAY_NAMES: Record<string, string> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
};

const EFFORT_DESCRIPTIONS: Record<string, string> = {
  off: 'Use for simple tasks that do not need reasoning.',
  minimal: 'Minimal reasoning before responding.',
  low: 'Prefer for routine or latency-sensitive tasks.',
  medium: 'Balanced reasoning and speed.',
  high: 'The default balance for most tasks.',
  xhigh: 'Extensive reasoning for the hardest problems.',
  max: 'Reserve for the hardest quality-first tasks.',
};

const KNOWN_REASONING_LEVELS: readonly string[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export function resolveReasoningInfo(
  modelId: string,
  configuredEfforts?: Record<string, string | null> | false,
  configuredDefault?: string,
  providerDefault?: string
): ModelReasoningInfo | undefined {
  if (configuredEfforts === false) {
    return undefined;
  }

  if (configuredEfforts && typeof configuredEfforts === 'object') {
    const efforts: ModelReasoningEffort[] = [];
    for (const key of KNOWN_REASONING_LEVELS) {
      if (Object.prototype.hasOwnProperty.call(configuredEfforts, key)) {
        const val = configuredEfforts[key];
        if (key === 'off' || (typeof val === 'string' && val.length > 0)) {
          efforts.push({
            id: key,
            name: EFFORT_DISPLAY_NAMES[key] || (key.charAt(0).toUpperCase() + key.slice(1)),
            description: EFFORT_DESCRIPTIONS[key],
          });
        }
      }
    }

    if (efforts.length === 0) return undefined;

    const defaultCandidate = configuredDefault || providerDefault;
    const defaultEffort = defaultCandidate && efforts.some((e) => e.id === defaultCandidate)
      ? defaultCandidate
      : undefined;

    return {
      efforts,
      ...(defaultEffort ? { defaultEffort } : {}),
    };
  }

  // Fallback defaults for known reasoning models if not explicitly configured
  const lower = modelId.toLowerCase();
  let defaultLevels: string[] | undefined;
  let fallbackDefault: string | undefined;

  if (
    lower.startsWith('gpt-5.6') ||
    lower.startsWith('gpt-6') ||
    lower === 'auto'
  ) {
    defaultLevels = ['off', 'low', 'medium', 'high', 'xhigh', 'max'];
    fallbackDefault = 'medium';
  } else if (
    lower.includes('claude') &&
    (lower.includes('sonnet-4.6') ||
      lower.includes('sonnet-5') ||
      lower.includes('opus') ||
      lower.includes('thinking'))
  ) {
    defaultLevels = ['off', 'low', 'medium', 'high', 'max'];
    fallbackDefault = 'high';
  } else if (
    lower === 'o4-mini' ||
    lower === 'o3-mini' ||
    lower === 'o3' ||
    lower === 'o1' ||
    lower === 'o1-mini' ||
    lower === 'o1-preview'
  ) {
    defaultLevels = ['off', 'low', 'medium', 'high'];
    fallbackDefault = 'medium';
  }

  if (defaultLevels) {
    const efforts = defaultLevels.map((lvl) => ({
      id: lvl,
      name: EFFORT_DISPLAY_NAMES[lvl] || (lvl.charAt(0).toUpperCase() + lvl.slice(1)),
      description: EFFORT_DESCRIPTIONS[lvl],
    }));
    const defaultCandidate = configuredDefault || providerDefault || fallbackDefault;
    const defaultEffort = defaultCandidate && efforts.some((e) => e.id === defaultCandidate)
      ? defaultCandidate
      : undefined;

    return {
      efforts,
      ...(defaultEffort ? { defaultEffort } : {}),
    };
  }

  return undefined;
}

/**
 * GitHub Copilot ACP Provider Adapter
 * Implements DeepSeek Harness LlmAdapter
 */
export class CopilotAcpAdapter {
  private config: CopilotAcpConfig;

  constructor(config: CopilotAcpConfig = {}) {
    this.config = config;
  }

  public updateConfig(newConfig: CopilotAcpConfig): void {
    this.config = { ...this.config, ...newConfig };
  }

  public providerInfo(provider: string): { id: string; name: string } {
    return {
      id: provider,
      name: 'GitHub Copilot (ACP)',
    };
  }

  /** `dsh-llm` calls this unconditionally while registering routes. */
  public providerRetryPolicy(_provider: string): undefined {
    return undefined;
  }

  /** `dsh-llm` calls this when pricing a route. This provider declares none. */
  public imageRequestPricing(_provider: string, _model: string): undefined {
    return undefined;
  }

  public async listModels(provider: string, signal?: AbortSignal): Promise<ModelDescriptor[]> {
    if (signal?.aborted) throw new Error('ACP model discovery was aborted.');
    if (this.config.models && this.config.models.length > 0) {
      return this.config.models.map((model) => this.describe(provider, model.id));
    }

    try {
      const client = new CopilotAcpClient(this.config);
      const timeout = this.config.modelDiscoveryTimeoutMs ?? 15000;
      const discovered = await client.listModels(timeout, signal);
      return discovered.map((id) => this.describe(provider, id));
    } catch (err) {
      if (signal?.aborted) throw err;
      return [];
    }
  }

  public resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal
  ): Promise<ModelDescriptor> {
    if (signal?.aborted) return Promise.reject(new Error('ACP model resolution was aborted.'));
    return Promise.resolve(this.describe(provider, model));
  }

  private describe(provider: string, model: string): ModelDescriptor {
    const configured = this.config.models?.find((entry) => entry.id === model);
    const contextWindow = configured?.contextWindow;
    const reasoning = resolveReasoningInfo(
      model,
      configured?.reasoningEfforts,
      configured?.defaultEffort,
      this.config.reasoning
    );
    return {
      provider,
      id: model,
      name: configured?.name || this.defaultDisplayName(model),
      inputModalities: configured?.inputModalities || ['text'],
      ...(contextWindow === undefined ? {} : { context: { contextWindow } }),
      ...(reasoning === undefined ? {} : { reasoning }),
    };
  }

  private defaultDisplayName(model: string): string {
    return model;
  }

  public async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal
  ): Promise<{
    model: ModelDescriptor;
    stream: (options: GenerateOptions) => AsyncIterable<DshStreamChunk>;
  }> {
    const resolvedModel = await this.resolveModel(provider, model, signal);
    return {
      model: resolvedModel,
      stream: (options: GenerateOptions) => this.stream(options),
    };
  }

  public async *stream(options: GenerateOptions): AsyncGenerator<DshStreamChunk, void, unknown> {
    if (options.signal?.aborted) {
      yield* new AcpStreamEmitter().finish(options.signal);
      return;
    }

    const client = new CopilotAcpClient({
      ...this.config,
      ...(options.tools?.length && this.config.permissionMode === undefined
        ? { permissionMode: 'deny' as const }
        : {}),
    });
    const emitter = new AcpStreamEmitter();
    const queue = new AsyncChunkQueue();
    const task = this.runPrompt(client, emitter, queue, options);
    try {
      for await (const chunk of queue) yield chunk;
    } finally {
      client.close();
      queue.close();
      await task.catch(() => undefined);
    }
  }

  private async runPrompt(
    client: CopilotAcpClient,
    emitter: AcpStreamEmitter,
    queue: AsyncChunkQueue,
    options: GenerateOptions
  ): Promise<void> {
    const onAbort = () => {
      client.cancel();
      client.close();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await client.initialize(undefined, options.signal);
      const session = await client.newSession(options.cwd, undefined, options.signal);
      const applied = await client.setModel(session.sessionId, options.model, session);
      if (options.reasoningEffort) {
        await client.setReasoningEffort(session.sessionId, options.reasoningEffort, session);
      }
      const promptOptions = applied || !options.model ? options : {
        ...options,
        system: `${options.system ? `${options.system}\n\n` : ''}The requested model "${options.model}" is not offered by this Copilot session. Continue with the session default.`,
      };
      const promptResult = await client.prompt(
        session.sessionId,
        formatMessagesAsPrompt(promptOptions),
        (update) => {
          queue.pushMany(emitter.handleSessionUpdate(update));
        },
        options.signal
      );
      queue.pushMany(emitter.finish(options.signal, undefined, promptResult?.stopReason));
      queue.close();
    } catch (err) {
      queue.pushMany(emitter.finish(options.signal, options.signal?.aborted ? undefined : err));
      queue.close();
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
    }
  }
}
