import { CopilotAcpAdapter } from './adapter.js';
import type { CopilotAcpConfig } from './types.js';
export declare const name = "github-copilot-acp";
export declare const inject: string[];
/** Directory entries accepted by `llm.registerConfigurableProviders`. */
export declare function providerDirectoryEntries(settingsNs?: string): {
    provider: "copilot-acp" | "github-copilot-acp";
    displayName: string;
    settingsNs: string;
    settingsPath: string[];
}[];
export declare const Config: any;
export declare function apply(ctx: any, config?: CopilotAcpConfig): {
    adapter: CopilotAcpAdapter;
    registration: any;
    directory: any;
    discovery: any;
};
export { CopilotAcpAdapter } from './adapter.js';
export { CopilotAcpClient } from './client.js';
export * from './types.js';
export * from './prompt-bridge.js';
export * from './stream-bridge.js';
