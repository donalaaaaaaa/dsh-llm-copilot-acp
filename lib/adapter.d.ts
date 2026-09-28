import type { CopilotAcpConfig, DshStreamChunk, GenerateOptions, ModelDescriptor, ModelReasoningInfo } from './types.js';
export declare function resolveReasoningInfo(modelId: string, configuredEfforts?: Record<string, string | null> | false, configuredDefault?: string, providerDefault?: string): ModelReasoningInfo | undefined;
/**
 * GitHub Copilot ACP Provider Adapter
 * Implements DeepSeek Harness LlmAdapter
 */
export declare class CopilotAcpAdapter {
    private config;
    constructor(config?: CopilotAcpConfig);
    updateConfig(newConfig: CopilotAcpConfig): void;
    providerInfo(provider: string): {
        id: string;
        name: string;
    };
    /** `dsh-llm` calls this unconditionally while registering routes. */
    providerRetryPolicy(_provider: string): undefined;
    /** `dsh-llm` calls this when pricing a route. This provider declares none. */
    imageRequestPricing(_provider: string, _model: string): undefined;
    listModels(provider: string, signal?: AbortSignal): Promise<ModelDescriptor[]>;
    resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<ModelDescriptor>;
    private describe;
    private defaultDisplayName;
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
        model: ModelDescriptor;
        stream: (options: GenerateOptions) => AsyncIterable<DshStreamChunk>;
    }>;
    stream(options: GenerateOptions): AsyncGenerator<DshStreamChunk, void, unknown>;
    private runPrompt;
}
