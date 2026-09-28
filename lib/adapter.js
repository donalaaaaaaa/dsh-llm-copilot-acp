import { CopilotAcpClient } from './client.js';
import { formatMessagesAsPrompt } from './prompt-bridge.js';
import { AcpStreamEmitter } from './stream-bridge.js';
/**
 * Simple async queue for streaming chunks from callbacks to an AsyncIterator
 */
class AsyncChunkQueue {
    queue = [];
    waiters = [];
    closed = false;
    error = null;
    push(chunk) {
        if (this.closed)
            return;
        if (this.waiters.length > 0) {
            const waiter = this.waiters.shift();
            waiter.resolve({ value: chunk, done: false });
        }
        else {
            this.queue.push(chunk);
        }
    }
    pushMany(chunks) {
        for (const c of chunks) {
            this.push(c);
        }
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        while (this.waiters.length > 0) {
            const waiter = this.waiters.shift();
            waiter.resolve({ value: undefined, done: true });
        }
    }
    fail(err) {
        if (this.closed)
            return;
        this.closed = true;
        this.error = err;
        while (this.waiters.length > 0) {
            const waiter = this.waiters.shift();
            waiter.reject(err);
        }
    }
    async next() {
        if (this.queue.length > 0) {
            return { value: this.queue.shift(), done: false };
        }
        if (this.closed) {
            if (this.error)
                throw this.error;
            return { value: undefined, done: true };
        }
        return new Promise((resolve, reject) => {
            this.waiters.push({ resolve, reject });
        });
    }
    [Symbol.asyncIterator]() {
        return {
            next: () => this.next(),
        };
    }
}
const EFFORT_DISPLAY_NAMES = {
    off: 'Off',
    minimal: 'Minimal',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'Extra High',
    max: 'Max',
};
const EFFORT_DESCRIPTIONS = {
    off: 'Use for simple tasks that do not need reasoning.',
    minimal: 'Minimal reasoning before responding.',
    low: 'Prefer for routine or latency-sensitive tasks.',
    medium: 'Balanced reasoning and speed.',
    high: 'The default balance for most tasks.',
    xhigh: 'Extensive reasoning for the hardest problems.',
    max: 'Reserve for the hardest quality-first tasks.',
};
const KNOWN_REASONING_LEVELS = [
    'off',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
];
export function resolveReasoningInfo(modelId, configuredEfforts, configuredDefault, providerDefault) {
    if (configuredEfforts === false) {
        return undefined;
    }
    if (configuredEfforts && typeof configuredEfforts === 'object') {
        const efforts = [];
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
        if (efforts.length === 0)
            return undefined;
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
    let defaultLevels;
    let fallbackDefault;
    if (lower.startsWith('gpt-5.6') ||
        lower.startsWith('gpt-6') ||
        lower === 'auto') {
        defaultLevels = ['off', 'low', 'medium', 'high', 'xhigh', 'max'];
        fallbackDefault = 'medium';
    }
    else if (lower.includes('claude') &&
        (lower.includes('sonnet-4.6') ||
            lower.includes('sonnet-5') ||
            lower.includes('opus') ||
            lower.includes('thinking'))) {
        defaultLevels = ['off', 'low', 'medium', 'high', 'max'];
        fallbackDefault = 'high';
    }
    else if (lower === 'o4-mini' ||
        lower === 'o3-mini' ||
        lower === 'o3' ||
        lower === 'o1' ||
        lower === 'o1-mini' ||
        lower === 'o1-preview') {
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
    config;
    constructor(config = {}) {
        this.config = config;
    }
    updateConfig(newConfig) {
        this.config = { ...this.config, ...newConfig };
    }
    providerInfo(provider) {
        return {
            id: provider,
            name: 'GitHub Copilot (ACP)',
        };
    }
    /** `dsh-llm` calls this unconditionally while registering routes. */
    providerRetryPolicy(_provider) {
        return undefined;
    }
    /** `dsh-llm` calls this when pricing a route. This provider declares none. */
    imageRequestPricing(_provider, _model) {
        return undefined;
    }
    async listModels(provider, signal) {
        if (signal?.aborted)
            throw new Error('ACP model discovery was aborted.');
        if (this.config.models && this.config.models.length > 0) {
            return this.config.models.map((model) => this.describe(provider, model.id));
        }
        try {
            const client = new CopilotAcpClient(this.config);
            const timeout = this.config.modelDiscoveryTimeoutMs ?? 15000;
            const discovered = await client.listModels(timeout, signal);
            return discovered.map((id) => this.describe(provider, id));
        }
        catch (err) {
            if (signal?.aborted)
                throw err;
            return [];
        }
    }
    resolveModel(provider, model, signal) {
        if (signal?.aborted)
            return Promise.reject(new Error('ACP model resolution was aborted.'));
        return Promise.resolve(this.describe(provider, model));
    }
    describe(provider, model) {
        const configured = this.config.models?.find((entry) => entry.id === model);
        const contextWindow = configured?.contextWindow;
        const reasoning = resolveReasoningInfo(model, configured?.reasoningEfforts, configured?.defaultEffort, this.config.reasoning);
        return {
            provider,
            id: model,
            name: configured?.name || this.defaultDisplayName(model),
            inputModalities: configured?.inputModalities || ['text'],
            ...(contextWindow === undefined ? {} : { context: { contextWindow } }),
            ...(reasoning === undefined ? {} : { reasoning }),
        };
    }
    defaultDisplayName(model) {
        return model;
    }
    async prepareCall(provider, model, signal) {
        const resolvedModel = await this.resolveModel(provider, model, signal);
        return {
            model: resolvedModel,
            stream: (options) => this.stream(options),
        };
    }
    async *stream(options) {
        if (options.signal?.aborted) {
            yield* new AcpStreamEmitter().finish(options.signal);
            return;
        }
        const client = new CopilotAcpClient({
            ...this.config,
            ...(options.tools?.length && this.config.permissionMode === undefined
                ? { permissionMode: 'deny' }
                : {}),
        });
        const emitter = new AcpStreamEmitter();
        const queue = new AsyncChunkQueue();
        const task = this.runPrompt(client, emitter, queue, options);
        try {
            for await (const chunk of queue)
                yield chunk;
        }
        finally {
            client.close();
            queue.close();
            await task.catch(() => undefined);
        }
    }
    async runPrompt(client, emitter, queue, options) {
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
            const promptResult = await client.prompt(session.sessionId, formatMessagesAsPrompt(promptOptions), (update) => {
                queue.pushMany(emitter.handleSessionUpdate(update));
            }, options.signal);
            queue.pushMany(emitter.finish(options.signal, undefined, promptResult?.stopReason));
            queue.close();
        }
        catch (err) {
            queue.pushMany(emitter.finish(options.signal, options.signal?.aborted ? undefined : err));
            queue.close();
        }
        finally {
            options.signal?.removeEventListener('abort', onAbort);
        }
    }
}
