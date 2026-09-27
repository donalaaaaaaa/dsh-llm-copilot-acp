import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, writeFile, realpath, lstat } from 'node:fs/promises';
const DEPRECATION_REQUIRED = ['gh-copilot'];
const DEPRECATION_MARKERS = ['has been deprecated', 'no commands will be executed'];
export function isGhCopilotDeprecation(stderr) {
    const lower = stderr.toLowerCase();
    return (DEPRECATION_REQUIRED.some((req) => lower.includes(req)) &&
        DEPRECATION_MARKERS.some((marker) => lower.includes(marker)));
}
/** Resolve `rawPath` and reject anything outside `cwd`, including another drive. */
export function resolveInsideCwd(cwd, rawPath) {
    if (!rawPath.trim())
        throw new Error('ACP file path is empty.');
    const root = resolve(cwd);
    const target = isAbsolute(rawPath) ? resolve(rawPath) : resolve(root, rawPath);
    const rel = relative(root, target);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new Error(`Access denied: path '${target}' is outside session cwd '${root}'.`);
    }
    return target;
}
async function assertNoSymlinkTraversal(root, target) {
    const rel = relative(root, target);
    if (!rel)
        return;
    const parts = rel.split(sep).filter(Boolean);
    let current = root;
    for (const part of parts) {
        current = join(current, part);
        try {
            const stat = await lstat(current);
            if (stat.isSymbolicLink()) {
                throw new Error(`Access denied: path '${target}' traverses symbolic link '${current}'.`);
            }
        }
        catch (err) {
            if (err?.code === 'ENOENT')
                return;
            throw err;
        }
    }
}
/**
 * Resolve a file bridge path and verify the canonical path remains inside cwd.
 * For writes to a new file, canonicalize the nearest existing parent directory.
 */
export async function resolveInsideCwdCanonical(cwd, rawPath, mode) {
    const lexicalTarget = resolveInsideCwd(cwd, rawPath);
    const lexicalRoot = resolve(cwd);
    const canonicalRoot = await realpath(lexicalRoot);
    await assertNoSymlinkTraversal(lexicalRoot, lexicalTarget);
    if (mode === 'read') {
        const canonicalTarget = await realpath(lexicalTarget);
        resolveInsideCwd(canonicalRoot, canonicalTarget);
        return canonicalTarget;
    }
    let probe = dirname(lexicalTarget);
    while (true) {
        try {
            const canonicalParent = await realpath(probe);
            resolveInsideCwd(canonicalRoot, canonicalParent);
            return lexicalTarget;
        }
        catch (err) {
            if (err?.code !== 'ENOENT')
                throw err;
            const parent = dirname(probe);
            if (parent === probe)
                throw err;
            probe = parent;
        }
    }
}
export async function resolveAcpFilePath(cwd, rawPath, mode) {
    if (!isAbsolute(rawPath)) {
        throw new Error(`ACP file path '${rawPath}' must be absolute.`);
    }
    return resolveInsideCwdCanonical(cwd, rawPath, mode);
}
export function sliceAcpText(content, line, limit) {
    if (line === undefined && limit === undefined)
        return content;
    if (line !== undefined && line !== null && (!Number.isInteger(line) || line < 1)) {
        throw new Error('ACP read line must be a 1-based positive integer.');
    }
    if (limit !== undefined && limit !== null && (!Number.isInteger(limit) || limit < 0)) {
        throw new Error('ACP read limit must be a non-negative integer.');
    }
    const lines = content.split(/\r?\n/);
    const start = (line ?? 1) - 1;
    const end = limit === undefined || limit === null ? undefined : start + limit;
    return lines.slice(start, end).join('\n');
}
export function windowsTaskkillArgs(pid, force) {
    return ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])];
}
function terminateProcessTree(proc, force) {
    if (proc.exitCode !== null)
        return;
    if (process.platform === 'win32' && proc.pid) {
        try {
            const result = spawnSync('taskkill', windowsTaskkillArgs(proc.pid, force), {
                windowsHide: true,
                stdio: 'ignore',
            });
            if (!result.error && result.status === 0)
                return;
        }
        catch {
            // Fall through to ChildProcess.kill().
        }
    }
    try {
        proc.kill(force ? 'SIGKILL' : 'SIGTERM');
    }
    catch {
        // The process is already gone.
    }
}
/**
 * ACP permission outcomes are only `cancelled` or `selected` plus an option id
 * the agent actually offered. There is no `accepted` outcome.
 */
export function permissionOutcome(params, allowAllTools) {
    if (!allowAllTools)
        return { outcome: { outcome: 'cancelled' } };
    const options = Array.isArray(params?.options) ? params.options : [];
    for (const kind of ['allow_always', 'allow_once']) {
        const match = options.find((option) => option?.kind === kind && typeof option.optionId === 'string' && option.optionId.length > 0);
        if (match)
            return { outcome: { outcome: 'selected', optionId: match.optionId } };
    }
    return { outcome: { outcome: 'cancelled' } };
}
export class CopilotAcpClient {
    config;
    child = null;
    nextRequestId = 1;
    pendingRequests = new Map();
    stderrTail = [];
    updateHandlers = new Map();
    sessionCwds = new Map();
    initializeResult = null;
    isClosed = false;
    childFailed = false;
    generation = 0;
    activeSessionId = null;
    sessionCwd;
    constructor(config = {}) {
        this.config = config;
        this.sessionCwd = resolve(config.cwd || process.cwd());
    }
    get cwd() {
        return this.sessionCwd;
    }
    get closed() {
        return this.isClosed;
    }
    resolveExecution() {
        const raw = this.config.command?.trim() ||
            process.env.COPILOT_ACP_COMMAND?.trim() ||
            process.env.COPILOT_CLI_PATH?.trim() ||
            'copilot';
        if (process.platform !== 'win32') {
            return { command: raw, shell: false };
        }
        if (raw.toLowerCase().endsWith('.exe') && existsSync(raw)) {
            return { command: raw, shell: false };
        }
        if (raw.toLowerCase().endsWith('.cmd') || raw.toLowerCase().endsWith('.bat')) {
            return { command: raw, shell: true };
        }
        if (raw === 'copilot') {
            const appData = process.env.APPDATA || '';
            if (appData) {
                const nativeNpmPath = join(appData, 'npm', 'node_modules', '@github', 'copilot', 'node_modules', '@github', 'copilot-win32-x64', 'copilot.exe');
                if (existsSync(nativeNpmPath)) {
                    return { command: nativeNpmPath, shell: false };
                }
                const npmCmd = join(appData, 'npm', 'copilot.cmd');
                if (existsSync(npmCmd)) {
                    return { command: npmCmd, shell: true };
                }
            }
            const localAppData = process.env.LOCALAPPDATA || '';
            if (localAppData) {
                const nativeLocalPath = join(localAppData, 'Programs', 'copilot', 'copilot.exe');
                if (existsSync(nativeLocalPath)) {
                    return { command: nativeLocalPath, shell: false };
                }
            }
            return { command: raw, shell: true };
        }
        return { command: raw, shell: false };
    }
    resolveArgs() {
        let args;
        if (this.config.args && this.config.args.length > 0) {
            args = [...this.config.args];
        }
        else {
            const envArgs = process.env.COPILOT_ACP_ARGS?.trim();
            if (envArgs) {
                args = envArgs.split(/\s+/);
            }
            else {
                args = ['--acp'];
                if (this.config.allowAllTools === true) {
                    args.push('--allow-all-tools');
                }
            }
        }
        if (this.config.allowAllTools === true) {
            if (!args.includes('--allow-all-tools'))
                args.push('--allow-all-tools');
        }
        else {
            args = args.filter((arg) => arg !== '--allow-all-tools');
        }
        return args;
    }
    /**
     * Spawn child process and setup stdio JSON-RPC channels
     */
    spawn() {
        if (this.child && !this.childFailed && !this.child.killed && this.child.exitCode === null) {
            return this.child;
        }
        if (this.child) {
            try {
                this.child.kill();
            }
            catch {
                // The previous child already failed.
            }
            this.child = null;
        }
        const { command, shell } = this.resolveExecution();
        const args = this.resolveArgs();
        const generation = ++this.generation;
        const env = { ...process.env };
        if (!env.HOME && process.platform === 'win32' && env.USERPROFILE) {
            env.HOME = env.USERPROFILE;
        }
        let child;
        try {
            child = spawn(command, args, {
                cwd: this.sessionCwd,
                env,
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true,
                shell,
            });
        }
        catch (err) {
            this.childFailed = true;
            throw new Error(`Could not start Copilot ACP command '${command}'. Install GitHub Copilot CLI (\`npm install -g @github/copilot\`) or set COPILOT_ACP_COMMAND. ${err.message}`);
        }
        const stdin = child.stdin;
        const stdout = child.stdout;
        const stderr = child.stderr;
        if (!stdin || !stdout || !stderr) {
            child.kill();
            this.childFailed = true;
            throw new Error('Copilot ACP process was spawned without stdio pipes.');
        }
        this.child = child;
        this.childFailed = false;
        this.isClosed = false;
        this.stderrTail = [];
        stdin.on('error', () => undefined);
        stdout.on('error', () => undefined);
        stderr.on('error', () => undefined);
        // Setup stdout line reader
        const rl = createInterface({
            input: stdout,
            crlfDelay: Infinity,
        });
        rl.on('line', (line) => {
            const trimmed = line.trim();
            if (!trimmed)
                return;
            try {
                const msg = JSON.parse(trimmed);
                this.handleIncomingMessage(msg);
            }
            catch {
                // non-JSON stdout ignored
            }
        });
        // Setup stderr line reader
        const rerr = createInterface({
            input: stderr,
            crlfDelay: Infinity,
        });
        rerr.on('line', (line) => {
            this.stderrTail.push(line);
            if (this.stderrTail.length > 50) {
                this.stderrTail.shift();
            }
        });
        const failIfCurrent = (err) => {
            if (generation !== this.generation)
                return;
            this.childFailed = true;
            this.failAllPending(err);
        };
        child.on('error', (err) => {
            const tail = this.stderrTail.join('\n').trim();
            const detail = err.code === 'ENOENT'
                ? `Could not start Copilot ACP command '${command}'. Install GitHub Copilot CLI (\`npm install -g @github/copilot\`) or set COPILOT_ACP_COMMAND.`
                : `Copilot ACP process error: ${err.message}`;
            failIfCurrent(new Error(`${detail}${tail ? `\nStderr:\n${tail}` : ''}`));
        });
        child.on('exit', (code, signal) => {
            if (generation !== this.generation)
                return;
            this.childFailed = true;
            const tail = this.stderrTail.join('\n').trim();
            if (isGhCopilotDeprecation(tail)) {
                this.failAllPending(new Error(`DeepSeek Harness Copilot ACP requires the NEW GitHub Copilot CLI (@github/copilot), but spawned the deprecated gh-copilot extension.\n` +
                    `Please install the new CLI:\n  npm install -g @github/copilot\n\nOriginal stderr:\n${tail}`));
                return;
            }
            if (code !== 0 && code !== null) {
                this.failAllPending(new Error(`Copilot ACP process exited unexpectedly with code ${code}${signal ? ` (signal ${signal})` : ''}.${tail ? `\nStderr:\n${tail}` : ''}`));
            }
            else {
                this.failAllPending(new Error('Copilot ACP process closed.'));
            }
        });
        return child;
    }
    failAllPending(err) {
        for (const [id, req] of this.pendingRequests.entries()) {
            req.reject(err);
            this.pendingRequests.delete(id);
        }
    }
    /**
     * Handle server -> client message
     */
    handleIncomingMessage(msg) {
        if (!msg || typeof msg !== 'object')
            return;
        // A response has an id and no method. A server request also has an id, so the
        // method check is what stops a colliding server id from resolving our call.
        if (msg.id !== undefined && msg.method === undefined && this.pendingRequests.has(Number(msg.id))) {
            const id = Number(msg.id);
            const req = this.pendingRequests.get(id);
            this.pendingRequests.delete(id);
            if (msg.error) {
                const errorMsg = typeof msg.error === 'string'
                    ? msg.error
                    : msg.error?.message || JSON.stringify(msg.error);
                req.reject(new Error(`ACP ${req.method} failed: ${errorMsg}`));
            }
            else {
                req.resolve(msg.result);
            }
            return;
        }
        // Server-initiated notification
        if (msg.method === 'session/update') {
            const update = msg.params?.update;
            const sessionId = typeof msg.params?.sessionId === 'string' ? msg.params.sessionId : '';
            const handler = sessionId ? this.updateHandlers.get(sessionId) : undefined;
            if (handler) {
                try {
                    handler(update);
                }
                catch {
                    // Update handler error shouldn't crash client
                }
            }
            return;
        }
        // Server-initiated request requiring response
        if (msg.id !== undefined && typeof msg.method === 'string') {
            this.handleServerRequest(msg.id, msg.method, msg.params);
        }
    }
    /**
     * Handle server-initiated request (fs, permissions, etc.)
     */
    async handleServerRequest(messageId, method, params) {
        const respondResult = (result) => {
            try {
                this.send({ jsonrpc: '2.0', id: messageId, result });
            }
            catch {
                // The peer is already gone.
            }
        };
        const respondError = (code, message) => {
            try {
                this.send({ jsonrpc: '2.0', id: messageId, error: { code, message } });
            }
            catch {
                // The peer is already gone.
            }
        };
        if (method === 'session/request_permission') {
            respondResult(permissionOutcome(params, this.config.allowAllTools === true));
            return;
        }
        if (method === 'fs/read_text_file') {
            if (this.config.allowFileRequests !== true) {
                respondError(-32601, 'File read access is disabled.');
                return;
            }
            try {
                const sessionId = String(params?.sessionId || '');
                const root = this.sessionCwds.get(sessionId);
                if (!root)
                    throw new Error(`Unknown ACP session '${sessionId}'.`);
                const filePath = await resolveAcpFilePath(root, String(params?.path || ''), 'read');
                const content = await readFile(filePath, 'utf8');
                respondResult({ content: sliceAcpText(content, params?.line, params?.limit) });
            }
            catch (err) {
                respondError(-32602, `Failed to read file: ${err.message}`);
            }
            return;
        }
        if (method === 'fs/write_text_file') {
            if (this.config.allowFileRequests !== true) {
                respondError(-32601, 'File write access is disabled.');
                return;
            }
            try {
                const sessionId = String(params?.sessionId || '');
                const root = this.sessionCwds.get(sessionId);
                if (!root)
                    throw new Error(`Unknown ACP session '${sessionId}'.`);
                const filePath = await resolveAcpFilePath(root, String(params?.path || ''), 'write');
                await writeFile(filePath, String(params?.content ?? ''), 'utf8');
                respondResult(null);
            }
            catch (err) {
                respondError(-32602, `Failed to write file: ${err.message}`);
            }
            return;
        }
        // Unsupported method
        respondError(-32601, `ACP client method '${method}' is not supported.`);
    }
    send(obj) {
        if (!this.child || !this.child.stdin || this.child.killed) {
            throw new Error('Cannot send message: Copilot ACP process is not running.');
        }
        this.child.stdin.write(JSON.stringify(obj) + '\n');
    }
    /**
     * Send JSON-RPC request and await result
     */
    request(method, params = {}, timeoutMs = this.config.timeoutMs || 900000, signal) {
        this.spawn();
        const id = this.nextRequestId++;
        return new Promise((resolvePromise, rejectPromise) => {
            let timer = null;
            let abortHandler = null;
            const cleanup = () => {
                if (timer)
                    clearTimeout(timer);
                if (signal && abortHandler)
                    signal.removeEventListener('abort', abortHandler);
                abortHandler = null;
                this.pendingRequests.delete(id);
            };
            if (timeoutMs > 0) {
                timer = setTimeout(() => {
                    cleanup();
                    const tail = this.stderrTail.join('\n').trim();
                    rejectPromise(new Error(`Timed out after ${timeoutMs}ms waiting for Copilot ACP response to '${method}'.${tail ? `\nStderr:\n${tail}` : ''}`));
                }, timeoutMs);
            }
            if (signal) {
                if (signal.aborted) {
                    cleanup();
                    rejectPromise(new Error(`ACP request '${method}' was aborted.`));
                    return;
                }
                abortHandler = () => {
                    cleanup();
                    rejectPromise(new Error(`ACP request '${method}' was aborted.`));
                };
                signal.addEventListener('abort', abortHandler, { once: true });
            }
            this.pendingRequests.set(id, {
                method,
                resolve: (val) => {
                    cleanup();
                    resolvePromise(val);
                },
                reject: (err) => {
                    cleanup();
                    rejectPromise(err);
                },
            });
            try {
                this.send({
                    jsonrpc: '2.0',
                    id,
                    method,
                    params,
                });
            }
            catch (err) {
                cleanup();
                rejectPromise(err);
            }
        });
    }
    /**
     * Send JSON-RPC notification
     */
    notify(method, params = {}) {
        this.spawn();
        this.send({
            jsonrpc: '2.0',
            method,
            params,
        });
    }
    /**
     * ACP initialize handshake
     */
    async initialize(timeoutMs, signal) {
        const result = await this.request('initialize', {
            protocolVersion: 1,
            clientCapabilities: {
                ...(this.config.allowFileRequests === true
                    ? { fs: { readTextFile: true, writeTextFile: true } }
                    : {}),
            },
            clientInfo: {
                name: 'deepseek-harness',
                title: 'DeepSeek Harness',
                version: '0.1.7-rc.4',
            },
        }, timeoutMs, signal);
        this.initializeResult = result;
        return result;
    }
    /**
     * Create an ACP session
     */
    async newSession(cwd, timeoutMs, signal) {
        const sessionCwd = cwd ? resolve(cwd) : this.sessionCwd;
        const res = await this.request('session/new', {
            cwd: sessionCwd,
            mcpServers: [],
        }, timeoutMs, signal);
        if (!res || !res.sessionId) {
            throw new Error('Copilot ACP did not return a sessionId from session/new.');
        }
        this.activeSessionId = String(res.sessionId);
        this.sessionCwds.set(this.activeSessionId, sessionCwd);
        return res;
    }
    async loadSession(sessionId, cwd, timeoutMs, signal, onUpdate) {
        if (this.initializeResult?.agentCapabilities?.loadSession !== true) {
            throw new Error('Copilot ACP agent did not advertise loadSession capability.');
        }
        const sessionCwd = cwd ? resolve(cwd) : this.sessionCwd;
        if (onUpdate)
            this.updateHandlers.set(sessionId, onUpdate);
        try {
            const result = await this.request('session/load', { sessionId, cwd: sessionCwd, mcpServers: [] }, timeoutMs, signal);
            this.activeSessionId = sessionId;
            this.sessionCwds.set(sessionId, sessionCwd);
            return { sessionId, ...(result || {}) };
        }
        finally {
            if (onUpdate)
                this.updateHandlers.delete(sessionId);
        }
    }
    /**
     * Set model option on active session
     */
    async setModel(sessionId, requestedModel, sessionInfo) {
        if (!requestedModel || requestedModel === 'copilot-acp' || requestedModel === 'github-copilot-acp') {
            return false;
        }
        // Check if configOptions has a model config option (ACP v1)
        const configOptions = sessionInfo?.configOptions || [];
        const modelOption = configOptions.find((opt) => opt && typeof opt === 'object' && (opt.category === 'model' || opt.id === 'model'));
        if (modelOption) {
            const allowed = (modelOption.options || [])
                .map((o) => (typeof o === 'string' ? o : o.value))
                .filter(Boolean);
            if (!allowed.includes(requestedModel))
                return false;
            await this.request('session/set_config_option', {
                sessionId,
                configId: modelOption.id || 'model',
                value: requestedModel,
            });
            return true;
        }
        const legacyModels = sessionInfo?.models?.availableModels || [];
        const legacyIds = legacyModels
            .filter((entry) => entry?._meta?.copilotEnablement !== 'disabled' && entry?.enabled !== false)
            .map((entry) => entry?.modelId || entry?.id)
            .filter(Boolean);
        if (!legacyIds.includes(requestedModel))
            return false;
        try {
            await this.request('session/set_model', {
                sessionId,
                modelId: requestedModel,
            });
            return true;
        }
        catch {
            return false;
        }
    }
    /**
     * Send prompt and stream updates
     */
    async prompt(sessionId, promptText, onUpdate, signal) {
        this.updateHandlers.set(sessionId, onUpdate);
        try {
            const res = await this.request('session/prompt', {
                sessionId,
                prompt: [{ type: 'text', text: promptText }],
            }, this.config.timeoutMs || 900000, signal);
            return res;
        }
        finally {
            this.updateHandlers.delete(sessionId);
        }
    }
    /**
     * Cancel an ongoing session prompt
     */
    cancel(sessionId) {
        const id = sessionId || this.activeSessionId;
        if (!id || !this.child?.stdin || this.childFailed || this.child.killed || this.child.exitCode !== null)
            return;
        try {
            this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: id } }) + '\n');
        }
        catch {
            // The process is already gone.
        }
    }
    /**
     * List available models by starting a short-lived discovery session.
     * `timeoutMs` bounds the whole probe, not each nested call.
     */
    async listModels(timeoutMs = 15000, signal) {
        const deadline = Date.now() + timeoutMs;
        const remaining = () => Math.max(1, deadline - Date.now());
        try {
            await this.initialize(remaining(), signal);
            const session = await this.newSession(undefined, remaining(), signal);
            const discovered = this.extractModelsFromSession(session);
            if (discovered.length > 0) {
                return discovered;
            }
            return [];
        }
        finally {
            this.close();
        }
    }
    extractModelsFromSession(session) {
        const results = [];
        // 1. From configOptions
        if (session.configOptions && Array.isArray(session.configOptions)) {
            for (const opt of session.configOptions) {
                if (opt.id === 'model' || opt.category === 'model') {
                    for (const choice of opt.options || []) {
                        const val = typeof choice === 'string' ? choice : choice.value;
                        const disabled = choice?._meta?.copilotEnablement === 'disabled' || choice?.enabled === false;
                        if (val && !disabled && !results.includes(val)) {
                            results.push(val);
                        }
                    }
                }
            }
        }
        // 2. From legacy models
        if (session.models?.availableModels && Array.isArray(session.models.availableModels)) {
            for (const m of session.models.availableModels) {
                const id = m.modelId || m.id;
                const disabled = m._meta?.copilotEnablement === 'disabled' || m.enabled === false;
                if (id && !disabled && !results.includes(id)) {
                    results.push(id);
                }
            }
        }
        return results;
    }
    /**
     * Terminate child process and release resources
     */
    close() {
        if (this.isClosed && !this.child)
            return;
        this.cancel();
        this.isClosed = true;
        this.generation += 1;
        this.activeSessionId = null;
        this.updateHandlers.clear();
        this.sessionCwds.clear();
        this.initializeResult = null;
        const proc = this.child;
        this.child = null;
        this.failAllPending(new Error('Copilot ACP process closed.'));
        if (!proc)
            return;
        terminateProcessTree(proc, false);
        const timer = setTimeout(() => {
            terminateProcessTree(proc, true);
        }, 2000);
        timer.unref?.();
    }
}
