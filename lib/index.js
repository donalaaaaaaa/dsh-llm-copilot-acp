import { CopilotAcpAdapter } from './adapter.js';
export const name = 'github-copilot-acp';
export const inject = ['llm'];
const ROUTES = ['github-copilot-acp'];
/** Directory entries accepted by `llm.registerConfigurableProviders`. */
export function providerDirectoryEntries(settingsNs = 'github-copilot-acp') {
    return ROUTES.map((provider) => ({
        provider,
        displayName: 'GitHub Copilot (ACP)',
        settingsNs,
        settingsPath: [],
    }));
}
async function loadConfigSchema() {
    let zModule;
    try {
        zModule = await import('@deepseek-ai/schemastery');
    }
    catch (error) {
        if (error?.code === 'ERR_MODULE_NOT_FOUND')
            return undefined;
        throw error;
    }
    const z = zModule.default || zModule;
    // Schemastery fields are optional unless `.required()`. There is no `.optional()`.
    return z.object({
        command: z.string().default('copilot').description('GitHub Copilot CLI command or path'),
        args: z.array(z.string()).default(['--acp']).description('Arguments passed to the Copilot CLI'),
        cwd: z.string().description('Working directory for the Copilot CLI subprocess'),
        timeoutMs: z.number().default(900000).description('ACP operation timeout in milliseconds'),
        modelDiscoveryTimeoutMs: z.number().default(10000).description('Model discovery timeout in milliseconds'),
        allowAllTools: z.boolean().default(false).description('Append --allow-all-tools when args are not explicitly configured'),
        permissionMode: z.string().description('ACP permission policy: deny, allow-once, or allow-always'),
        allowFileRequests: z.boolean().default(true).description('Allow ACP read/write requests inside the session directory'),
        models: z.array(z.object({
            id: z.string().required(),
            name: z.string(),
            contextWindow: z.number(),
            inputModalities: z.array(z.string()),
        })).description('Optional explicit model catalog. Omit to discover models from the CLI.'),
    });
}
export const Config = await loadConfigSchema();
export function apply(ctx, config = {}) {
    if (typeof ctx.llm?.registerAdapter !== 'function') {
        throw new Error('github-copilot-acp requires the llm service');
    }
    const settingsNs = ctx.fiber?.entry?.options?.id || 'github-copilot-acp';
    const adapter = new CopilotAcpAdapter(config);
    const registration = ctx.llm.registerAdapter([...ROUTES], adapter);
    const directory = ctx.llm.registerConfigurableProviders(providerDirectoryEntries(settingsNs));
    const discovery = ctx.llm.registerModelDiscovery(settingsNs, async (request, signal) => {
        const provider = request?.provider || 'github-copilot-acp';
        const models = await adapter.listModels(provider, signal);
        return models.map((model) => ({
            id: model.id,
            name: model.name,
            ...(model.context ? { contextWindow: model.context.contextWindow } : {}),
            ...(model.inputModalities ? { inputModalities: [...model.inputModalities] } : {}),
        }));
    });
    return { adapter, registration, directory, discovery };
}
export { CopilotAcpAdapter } from './adapter.js';
export { CopilotAcpClient } from './client.js';
export * from './types.js';
export * from './prompt-bridge.js';
export * from './stream-bridge.js';
