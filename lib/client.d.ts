import { type ChildProcess } from 'node:child_process';
import type { CopilotAcpConfig } from './types.js';
export interface AcpSessionInfo {
    sessionId: string;
    configOptions?: any[];
    models?: {
        availableModels?: Array<{
            modelId: string;
            name?: string;
            [key: string]: any;
        }>;
        currentModelId?: string;
    };
    [key: string]: any;
}
export declare function isGhCopilotDeprecation(stderr: string): boolean;
/** Resolve `rawPath` and reject anything outside `cwd`, including another drive. */
export declare function resolveInsideCwd(cwd: string, rawPath: string): string;
/**
 * Resolve a file bridge path and verify the canonical path remains inside cwd.
 * For writes to a new file, canonicalize the nearest existing parent directory.
 */
export declare function resolveInsideCwdCanonical(cwd: string, rawPath: string, mode: 'read' | 'write'): Promise<string>;
export declare function resolveAcpFilePath(cwd: string, rawPath: string, mode: 'read' | 'write'): Promise<string>;
export declare function sliceAcpText(content: string, line?: number | null, limit?: number | null): string;
export declare function windowsTaskkillArgs(pid: number, force: boolean): string[];
/**
 * ACP permission outcomes are only `cancelled` or `selected` plus an option id
 * the agent actually offered. There is no `accepted` outcome.
 */
export declare function permissionOutcome(params: any, allowAllTools: boolean): {
    outcome: {
        outcome: 'cancelled';
    };
} | {
    outcome: {
        outcome: 'selected';
        optionId: string;
    };
};
export declare class CopilotAcpClient {
    private config;
    private child;
    private nextRequestId;
    private pendingRequests;
    private stderrTail;
    private updateHandlers;
    private sessionCwds;
    private initializeResult;
    private isClosed;
    private childFailed;
    private generation;
    private activeSessionId;
    private sessionCwd;
    constructor(config?: CopilotAcpConfig);
    get cwd(): string;
    get closed(): boolean;
    private resolveExecution;
    private resolveArgs;
    /**
     * Spawn child process and setup stdio JSON-RPC channels
     */
    spawn(): ChildProcess;
    private failAllPending;
    /**
     * Handle server -> client message
     */
    private handleIncomingMessage;
    /**
     * Handle server-initiated request (fs, permissions, etc.)
     */
    private handleServerRequest;
    private send;
    /**
     * Send JSON-RPC request and await result
     */
    request<T = any>(method: string, params?: Record<string, any>, timeoutMs?: number, signal?: AbortSignal): Promise<T>;
    /**
     * Send JSON-RPC notification
     */
    notify(method: string, params?: Record<string, any>): void;
    /**
     * ACP initialize handshake
     */
    initialize(timeoutMs?: number, signal?: AbortSignal): Promise<any>;
    /**
     * Create an ACP session
     */
    newSession(cwd?: string, timeoutMs?: number, signal?: AbortSignal): Promise<AcpSessionInfo>;
    loadSession(sessionId: string, cwd?: string, timeoutMs?: number, signal?: AbortSignal, onUpdate?: (update: any) => void): Promise<AcpSessionInfo>;
    /**
     * Set model option on active session
     */
    setModel(sessionId: string, requestedModel: string, sessionInfo?: AcpSessionInfo): Promise<boolean>;
    /**
     * Send prompt and stream updates
     */
    prompt(sessionId: string, promptText: string, onUpdate: (update: any) => void, signal?: AbortSignal): Promise<any>;
    /**
     * Cancel an ongoing session prompt
     */
    cancel(sessionId?: string): void;
    /**
     * List available models by starting a short-lived discovery session.
     * `timeoutMs` bounds the whole probe, not each nested call.
     */
    listModels(timeoutMs?: number, signal?: AbortSignal): Promise<string[]>;
    extractModelsFromSession(session: AcpSessionInfo): string[];
    /**
     * Terminate child process and release resources.
     * This starts shutdown immediately but does not wait for OS handles to close.
     */
    close(): void;
    /**
     * Close the ACP process and wait until Node observes the child/stdio close.
     * Use this when subsequent work depends on released cwd/file handles.
     */
    closeAndWait(timeoutMs?: number): Promise<void>;
}
