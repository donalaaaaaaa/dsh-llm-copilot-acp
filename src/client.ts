import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
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

const DEPRECATION_REQUIRED = ['gh-copilot'];
const DEPRECATION_MARKERS = ['has been deprecated', 'no commands will be executed'];

export function isGhCopilotDeprecation(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return (
    DEPRECATION_REQUIRED.some((req) => lower.includes(req)) &&
    DEPRECATION_MARKERS.some((marker) => lower.includes(marker))
  );
}

/** Resolve `rawPath` and reject anything outside `cwd`, including another drive. */
export function resolveInsideCwd(cwd: string, rawPath: string): string {
  if (!rawPath.trim()) throw new Error('ACP file path is empty.');
  const root = resolve(cwd);
  const target = isAbsolute(rawPath) ? resolve(rawPath) : resolve(root, rawPath);
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Access denied: path '${target}' is outside session cwd '${root}'.`);
  }
  return target;
}

function assertInsideCanonicalRoot(root: string, target: string): void {
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Access denied: real path '${target}' is outside session cwd '${root}'.`);
  }
}

/** Resolve an existing path and reject symlink/junction escapes outside cwd. */
export async function resolveReadableInsideCwd(cwd: string, rawPath: string): Promise<string> {
  const lexical = resolveInsideCwd(cwd, rawPath);
  const [root, target] = await Promise.all([realpath(resolve(cwd)), realpath(lexical)]);
  assertInsideCanonicalRoot(root, target);
  return target;
}

/** Resolve a write target and reject existing symlink/junction ancestors that escape cwd. */
export async function resolveWritableInsideCwd(cwd: string, rawPath: string): Promise<string> {
  const lexical = resolveInsideCwd(cwd, rawPath);
  const root = await realpath(resolve(cwd));

  if (existsSync(lexical)) {
    const target = await realpath(lexical);
    assertInsideCanonicalRoot(root, target);
    return target;
  }

  let existingParent = dirname(lexical);
  while (!existsSync(existingParent)) {
    const next = dirname(existingParent);
    if (next === existingParent) break;
    existingParent = next;
  }
  const canonicalParent = await realpath(existingParent);
  assertInsideCanonicalRoot(root, canonicalParent);
  return lexical;
}

function selectOptionValues(option: any): string[] {
  const raw = Array.isArray(option?.options) ? option.options : [];
  const flattened = raw.flatMap((entry: any) =>
    entry && Array.isArray(entry.options) ? entry.options : [entry]
  );
  return flattened
    .filter((entry: any) => entry?._meta?.copilotEnablement !== 'disabled' && entry?.enabled !== false)
    .map((entry: any) => (typeof entry === 'string' ? entry : entry?.value))
    .filter((value: any): value is string => typeof value === 'string' && value.length > 0);
}

/**
 * ACP permission outcomes are only `cancelled` or `selected` plus an option id
 * the agent actually offered. There is no `accepted` outcome.
 */
export function permissionOutcome(
  params: any,
  mode: boolean | 'deny' | 'allow-once' | 'allow-always'
): { outcome: { outcome: 'cancelled' } } | { outcome: { outcome: 'selected'; optionId: string } } {
  const effectiveMode = typeof mode === 'boolean' ? (mode ? 'allow-always' : 'deny') : mode;
  if (effectiveMode === 'deny') return { outcome: { outcome: 'cancelled' } };
  const options = Array.isArray(params?.options) ? params.options : [];
  const preferredKinds = effectiveMode === 'allow-always'
    ? ['allow_always', 'allow_once']
    : ['allow_once'];
  for (const kind of preferredKinds) {
    const match = options.find(
      (option: any) => option?.kind === kind && typeof option.optionId === 'string' && option.optionId.length > 0
    );
    if (match) return { outcome: { outcome: 'selected', optionId: match.optionId } };
  }
  return { outcome: { outcome: 'cancelled' } };
}

export class CopilotAcpClient {
  private config: CopilotAcpConfig;
  private child: ChildProcess | null = null;
  private nextRequestId = 1;
  private pendingRequests = new Map<
    number,
    {
      resolve: (val: any) => void;
      reject: (err: any) => void;
      method: string;
    }
  >();
  private stderrTail: string[] = [];
  private activeUpdateHandler: ((update: any) => void) | null = null;
  private isClosed = false;
  private childFailed = false;
  private generation = 0;
  private activeSessionId: string | null = null;
  private sessionCwd: string;

  constructor(config: CopilotAcpConfig = {}) {
    this.config = config;
    this.sessionCwd = resolve(config.cwd || process.cwd());
  }

  public get cwd(): string {
    return this.sessionCwd;
  }

  public get closed(): boolean {
    return this.isClosed;
  }

  private resolveExecution(): { command: string; shell: boolean } {
    const raw =
      this.config.command?.trim() ||
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
        const nativeNpmPath = join(
          appData,
          'npm',
          'node_modules',
          '@github',
          'copilot',
          'node_modules',
          '@github',
          'copilot-win32-x64',
          'copilot.exe'
        );
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

  private resolveArgs(): string[] {
    let args: string[];
    if (this.config.args && this.config.args.length > 0) {
      args = [...this.config.args];
    } else {
      const envArgs = process.env.COPILOT_ACP_ARGS?.trim();
      if (envArgs) {
        args = envArgs.split(/\s+/);
      } else {
        args = ['--acp'];
        if (this.config.allowAllTools === true) {
          args.push('--allow-all-tools');
        }
      }
    }
    return args;
  }

  /**
   * Spawn child process and setup stdio JSON-RPC channels
   */
  public spawn(): ChildProcess {
    if (this.child && !this.childFailed && !this.child.killed && this.child.exitCode === null) {
      return this.child;
    }
    if (this.child) {
      try {
        this.child.kill();
      } catch {
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

    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd: this.sessionCwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell,
      });
    } catch (err: any) {
      this.childFailed = true;
      throw new Error(
        `Could not start Copilot ACP command '${command}'. Install GitHub Copilot CLI (\`npm install -g @github/copilot\`) or set COPILOT_ACP_COMMAND. ${err.message}`
      );
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

    rl.on('line', (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const msg = JSON.parse(trimmed);
        this.handleIncomingMessage(msg);
      } catch {
        // non-JSON stdout ignored
      }
    });

    // Setup stderr line reader
    const rerr = createInterface({
      input: stderr,
      crlfDelay: Infinity,
    });

    rerr.on('line', (line: string) => {
      this.stderrTail.push(line);
      if (this.stderrTail.length > 50) {
        this.stderrTail.shift();
      }
    });

    const failIfCurrent = (err: Error) => {
      if (generation !== this.generation) return;
      this.childFailed = true;
      this.failAllPending(err);
    };

    child.on('error', (err: NodeJS.ErrnoException) => {
      const tail = this.stderrTail.join('\n').trim();
      const detail =
        err.code === 'ENOENT'
          ? `Could not start Copilot ACP command '${command}'. Install GitHub Copilot CLI (\`npm install -g @github/copilot\`) or set COPILOT_ACP_COMMAND.`
          : `Copilot ACP process error: ${err.message}`;
      failIfCurrent(new Error(`${detail}${tail ? `\nStderr:\n${tail}` : ''}`));
    });

    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      if (generation !== this.generation) return;
      this.childFailed = true;
      const tail = this.stderrTail.join('\n').trim();
      if (isGhCopilotDeprecation(tail)) {
        this.failAllPending(
          new Error(
            `DeepSeek Harness Copilot ACP requires the NEW GitHub Copilot CLI (@github/copilot), but spawned the deprecated gh-copilot extension.\n` +
              `Please install the new CLI:\n  npm install -g @github/copilot\n\nOriginal stderr:\n${tail}`
          )
        );
        return;
      }
      if (code !== 0 && code !== null) {
        this.failAllPending(
          new Error(
            `Copilot ACP process exited unexpectedly with code ${code}${signal ? ` (signal ${signal})` : ''}.${
              tail ? `\nStderr:\n${tail}` : ''
            }`
          )
        );
      } else {
        this.failAllPending(new Error('Copilot ACP process closed.'));
      }
    });

    return child;
  }

  private failAllPending(err: Error): void {
    for (const [id, req] of this.pendingRequests.entries()) {
      req.reject(err);
      this.pendingRequests.delete(id);
    }
  }

  /**
   * Handle server -> client message
   */
  private handleIncomingMessage(msg: any): void {
    if (!msg || typeof msg !== 'object') return;

    // A response has an id and no method. A server request also has an id, so the
    // method check is what stops a colliding server id from resolving our call.
    if (msg.id !== undefined && msg.method === undefined && this.pendingRequests.has(Number(msg.id))) {
      const id = Number(msg.id);
      const req = this.pendingRequests.get(id)!;
      this.pendingRequests.delete(id);

      if (msg.error) {
        const errorMsg =
          typeof msg.error === 'string'
            ? msg.error
            : msg.error?.message || JSON.stringify(msg.error);
        req.reject(new Error(`ACP ${req.method} failed: ${errorMsg}`));
      } else {
        req.resolve(msg.result);
      }
      return;
    }

    // Server-initiated notification
    if (msg.method === 'session/update') {
      const update = msg.params?.update;
      if (this.activeUpdateHandler) {
        try {
          this.activeUpdateHandler(update);
        } catch {
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
  private async handleServerRequest(messageId: any, method: string, params: any): Promise<void> {
    const respondResult = (result: any) => {
      try {
        this.send({ jsonrpc: '2.0', id: messageId, result });
      } catch {
        // The peer is already gone.
      }
    };
    const respondError = (code: number, message: string) => {
      try {
        this.send({ jsonrpc: '2.0', id: messageId, error: { code, message } });
      } catch {
        // The peer is already gone.
      }
    };

    if (method === 'session/request_permission') {
      const permissionMode = this.config.permissionMode ?? 'allow-once';
      respondResult(permissionOutcome(params, permissionMode));
      return;
    }

    if (method === 'fs/read_text_file') {
      if (this.config.allowFileRequests === false) {
        respondError(-32601, 'File read access is disabled.');
        return;
      }
      try {
        const filePath = await resolveReadableInsideCwd(this.sessionCwd, String(params?.path || ''));
        const content = await readFile(filePath, 'utf8');
        const hasSlice = params?.line !== undefined || params?.limit !== undefined;
        if (!hasSlice) {
          respondResult({ content });
        } else {
          const startLine = Number.isInteger(params?.line) && params.line > 0 ? params.line : 1;
          const limit = Number.isInteger(params?.limit) && params.limit >= 0 ? params.limit : undefined;
          const lines = content.split(/\\r?\\n/);
          const start = startLine - 1;
          const selected = limit === undefined ? lines.slice(start) : lines.slice(start, start + limit);
          respondResult({ content: selected.join('\\n') });
        }
      } catch (err: any) {
        respondError(-32602, `Failed to read file: ${err.message}`);
      }
      return;
    }

    if (method === 'fs/write_text_file') {
      if (this.config.allowFileRequests === false) {
        respondError(-32601, 'File write access is disabled.');
        return;
      }
      try {
        const filePath = await resolveWritableInsideCwd(this.sessionCwd, String(params?.path || ''));
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, String(params?.content || ''), 'utf8');
        respondResult(null);
      } catch (err: any) {
        respondError(-32602, `Failed to write file: ${err.message}`);
      }
      return;
    }

    // Unsupported method
    respondError(-32601, `ACP client method '${method}' is not supported.`);
  }

  private send(obj: any): void {
    if (!this.child || !this.child.stdin || this.child.killed) {
      throw new Error('Cannot send message: Copilot ACP process is not running.');
    }
    this.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  /**
   * Send JSON-RPC request and await result
   */
  public request<T = any>(
    method: string,
    params: Record<string, any> = {},
    timeoutMs: number = this.config.timeoutMs || 900000,
    signal?: AbortSignal
  ): Promise<T> {
    this.spawn();
    const id = this.nextRequestId++;

    return new Promise<T>((resolvePromise, rejectPromise) => {
      let timer: NodeJS.Timeout | null = null;
      let abortHandler: (() => void) | null = null;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
        this.pendingRequests.delete(id);
      };

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          cleanup();
          const tail = this.stderrTail.join('\n').trim();
          rejectPromise(
            new Error(
              `Timed out after ${timeoutMs}ms waiting for Copilot ACP response to '${method}'.${
                tail ? `\nStderr:\n${tail}` : ''
              }`
            )
          );
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
      } catch (err) {
        cleanup();
        rejectPromise(err);
      }
    });
  }

  /**
   * Send JSON-RPC notification
   */
  public notify(method: string, params: Record<string, any> = {}): void {
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
  public async initialize(timeoutMs?: number, signal?: AbortSignal): Promise<any> {
    return this.request(
      'initialize',
      {
        protocolVersion: 1,
        clientCapabilities: this.config.allowFileRequests === false
          ? {}
          : { fs: { readTextFile: true, writeTextFile: true } },
        clientInfo: {
          name: 'deepseek-harness',
          title: 'DeepSeek Harness',
          version: '0.1.7',
        },
      },
      timeoutMs,
      signal
    );
  }

  /**
   * Create an ACP session
   */
  public async newSession(cwd?: string, timeoutMs?: number, signal?: AbortSignal): Promise<AcpSessionInfo> {
    const sessionCwd = cwd ? resolve(cwd) : this.sessionCwd;
    this.sessionCwd = sessionCwd;
    const res = await this.request(
      'session/new',
      {
        cwd: sessionCwd,
        mcpServers: [],
      },
      timeoutMs,
      signal
    );
    if (!res || !res.sessionId) {
      throw new Error('Copilot ACP did not return a sessionId from session/new.');
    }
    this.activeSessionId = String(res.sessionId);
    return res;
  }

  /**
   * Set model option on active session
   */
  public async setModel(
    sessionId: string,
    requestedModel: string,
    sessionInfo?: AcpSessionInfo
  ): Promise<boolean> {
    if (!requestedModel || requestedModel === 'copilot-acp' || requestedModel === 'github-copilot-acp') {
      return false;
    }

    // Check if configOptions has a model config option (ACP v1)
    const configOptions = sessionInfo?.configOptions || [];
    const modelOption = configOptions.find(
      (opt: any) =>
        opt && typeof opt === 'object' && (opt.category === 'model' || opt.id === 'model')
    );

    if (modelOption) {
      const allowed = selectOptionValues(modelOption);
      if (allowed.length > 0 && !allowed.includes(requestedModel)) return false;
      await this.request('session/set_config_option', {
        sessionId,
        configId: modelOption.id || 'model',
        value: requestedModel,
      });
      return true;
    }

    // Fallback: try legacy session/set_model
    try {
      await this.request('session/set_model', {
        sessionId,
        modelId: requestedModel,
      });
      return true;
    } catch {
      // If server does not support set_model or rejects it, continue with session default
      return false;
    }
  }

  /**
   * Send prompt and stream updates
   */
  public async prompt(
    sessionId: string,
    promptText: string,
    onUpdate: (update: any) => void,
    signal?: AbortSignal
  ): Promise<any> {
    this.activeUpdateHandler = onUpdate;
    try {
      const res = await this.request(
        'session/prompt',
        {
          sessionId,
          prompt: [{ type: 'text', text: promptText }],
        },
        this.config.timeoutMs || 900000,
        signal
      );
      return res;
    } finally {
      this.activeUpdateHandler = null;
    }
  }

  /**
   * Cancel an ongoing session prompt
   */
  public cancel(sessionId?: string): void {
    const id = sessionId || this.activeSessionId;
    if (!id || !this.child?.stdin || this.childFailed || this.child.killed || this.child.exitCode !== null) return;
    try {
      this.child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: id } }) + '\n'
      );
    } catch {
      // The process is already gone.
    }
  }

  /**
   * List available models by starting a short-lived discovery session.
   * `timeoutMs` bounds the whole probe, not each nested call.
   */
  public async listModels(timeoutMs: number = 15000, signal?: AbortSignal): Promise<string[]> {
    const deadline = Date.now() + timeoutMs;
    const remaining = () => Math.max(1, deadline - Date.now());
    try {
      await this.initialize(remaining(), signal);
      const session = await this.newSession(undefined, remaining(), signal);
      const discovered = this.extractModelsFromSession(session);
      return discovered;
    } finally {
      this.close();
    }
  }

  public extractModelsFromSession(session: AcpSessionInfo): string[] {
    const results: string[] = [];
    // 1. From configOptions
    if (session.configOptions && Array.isArray(session.configOptions)) {
      for (const opt of session.configOptions) {
        if (opt.id === 'model' || opt.category === 'model') {
          for (const val of selectOptionValues(opt)) {
            if (!results.includes(val)) results.push(val);
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
  public close(): void {
    if (this.isClosed && !this.child) return;
    this.cancel();
    this.isClosed = true;
    this.generation += 1;
    this.activeSessionId = null;
    const proc = this.child;
    this.child = null;
    this.failAllPending(new Error('Copilot ACP process closed.'));
    if (!proc) return;
    try {
      proc.kill();
    } catch {
      // ignore
    }

    const timer = setTimeout(() => {
      try {
        if (proc.exitCode === null) {
          proc.kill('SIGKILL');
        }
      } catch {
        // ignore
      }
    }, 2000);
    (timer as any).unref?.();
  }
}
