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
        return {
            provider,
            id: model,
            name: configured?.name || this.defaultDisplayName(model),
            inputModalities: configured?.inputModalities || ['text'],
            ...(contextWindow === undefined ? {} : { context: { contextWindow } }),
        };
    }
    defaultDisplayName(model) {
        const names = {
            'auto': 'Copilot Auto (GPT-5.6 Luna)',
            'gpt-5.6-luna': 'GPT-5.6 Luna (Copilot)',
            'claude-sonnet-4.6': 'Claude Sonnet 4.6 (Copilot)',
            'gpt-5.4': 'GPT-5.4 (Copilot)',
            'gemini-3.8-flash': 'Gemini 3.8 Flash (Copilot)',
            'o4-mini': 'OpenAI o4-mini (Copilot)',
            'mai-code-1.1-flash': 'MAI-Code 1.1 Flash (Copilot)',
            'gpt-6-luna': 'GPT-6 Luna (Copilot)',
        };
        return names[model] || model;
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
