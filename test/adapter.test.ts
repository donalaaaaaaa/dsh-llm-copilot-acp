import test from 'node:test';
import assert from 'node:assert';
import { resolve } from 'node:path';
import { CopilotAcpAdapter } from '../lib/adapter.js';
import { apply, name, inject, providerDirectoryEntries } from '../lib/index.js';
import type { GenerateOptions } from '../lib/types.js';

const mockCliPath = resolve('test/mock-copilot-cli.ts');
const nodeBin = process.execPath;

test('CopilotAcpAdapter: providerInfo, listModels, resolveModel, prepareCall', async () => {
  const adapter = new CopilotAcpAdapter({
    command: nodeBin,
    args: ['--experimental-strip-types', mockCliPath],
    cwd: process.cwd(),
  });

  const info = adapter.providerInfo('github-copilot-acp');
  assert.strictEqual(info.id, 'github-copilot-acp');
  assert.strictEqual(info.name, 'GitHub Copilot (ACP)');

  const models = await adapter.listModels('github-copilot-acp');
  assert.ok(models.length >= 3);
  assert.strictEqual(models[0].provider, 'github-copilot-acp');
  assert.strictEqual(models[0].id, 'gpt-4o');

  const resolved = await adapter.resolveModel('github-copilot-acp', 'claude-3.5-sonnet');
  assert.strictEqual(resolved.id, 'claude-3.5-sonnet');
  assert.strictEqual(resolved.provider, 'github-copilot-acp');
  assert.strictEqual(resolved.context, undefined);

  const missing = new CopilotAcpAdapter({ command: 'copilot-acp-missing-binary-xyz', modelDiscoveryTimeoutMs: 1000 });
  assert.deepStrictEqual(await missing.listModels('github-copilot-acp'), []);

  const prepared = await adapter.prepareCall('github-copilot-acp', 'claude-3.5-sonnet');
  assert.strictEqual(prepared.model.id, 'claude-3.5-sonnet');
  assert.strictEqual(typeof prepared.stream, 'function');
});

test('CopilotAcpAdapter: stream normal completion chunks', async () => {
  const adapter = new CopilotAcpAdapter({
    command: nodeBin,
    args: ['--experimental-strip-types', mockCliPath],
    cwd: process.cwd(),
    timeoutMs: 5000,
  });

  const options: GenerateOptions = {
    provider: 'github-copilot-acp',
    model: 'gpt-4o',
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Hi' }],
      },
    ],
  };

  const chunks: any[] = [];
  for await (const chunk of adapter.stream(options)) {
    chunks.push(chunk);
  }

  assert.ok(chunks.length > 0);
  assert.ok(chunks.some((c) => c.type === 'reasoning-delta' && c.text.includes('Analyzing ACP')));
  assert.ok(chunks.some((c) => c.type === 'text-delta' && c.text.includes('Hello from mock Copilot ACP!')));
  assert.ok(chunks.every((c) => c.type !== 'usage'));
  assert.ok(chunks.every((c) => c.type !== 'tool-call-delta'));

  const finish = chunks[chunks.length - 1];
  assert.strictEqual(finish.type, 'finish');
  assert.strictEqual(finish.reason.kind, 'stop');
});

test('CopilotAcpAdapter: native tool events are not executable, text tool calls are', async () => {
  const adapter = new CopilotAcpAdapter({
    command: nodeBin,
    args: ['--experimental-strip-types', mockCliPath],
    cwd: process.cwd(),
    timeoutMs: 5000,
  });

  const nativeChunks: any[] = [];
  for await (const chunk of adapter.stream({
    provider: 'github-copilot-acp',
    model: 'gpt-4o',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'trigger_tool' }] }],
  })) nativeChunks.push(chunk);
  assert.ok(nativeChunks.every((chunk) => chunk.type !== 'tool-call-delta'));
  assert.strictEqual(nativeChunks[nativeChunks.length - 1].reason.kind, 'stop');

  const textChunks: any[] = [];
  for await (const chunk of adapter.stream({
    provider: 'github-copilot-acp',
    model: 'gpt-4o',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'trigger_text_tool' }] }],
  })) textChunks.push(chunk);
  const deltas = textChunks.filter((chunk) => chunk.type === 'tool-call-delta');
  assert.strictEqual(deltas.length, 1);
  assert.strictEqual(deltas[0].name, 'glob');
  assert.strictEqual(deltas[0].argumentsDelta, '{"pattern":"*.ts"}');
  assert.strictEqual(textChunks[textChunks.length - 1].reason.kind, 'tool-calls');
});

test('Cordis Plugin: apply registers adapter and routes', () => {
  assert.strictEqual(name, 'github-copilot-acp');
  assert.deepStrictEqual(inject, ['llm']);

  let registeredRoutes: string[] = [];
  let registeredAdapter: any = null;
  let discoveryNs = '';

  const mockCtx: any = {
    fiber: { entry: { options: { id: 'github-copilot-acp' } } },
    llm: {
      registerAdapter(routes: string[], adapter: any) {
        registeredRoutes = routes;
        registeredAdapter = adapter;
        for (const route of routes) {
          const info = adapter.providerInfo(route);
          assert.strictEqual(info.id, route);
          assert.strictEqual(typeof info.name, 'string');
          assert.strictEqual(adapter.providerRetryPolicy(route), undefined);
          assert.strictEqual(adapter.imageRequestPricing(route, 'gpt-4o'), undefined);
        }
        return () => undefined;
      },
      registerConfigurableProviders(entries: any[]) {
        assert.deepStrictEqual(entries, providerDirectoryEntries('github-copilot-acp'));
        for (const entry of entries) {
          assert.ok(entry.settingsNs.length > 0);
          assert.ok(Array.isArray(entry.settingsPath));
          assert.ok(!entry.settingsPath.some((segment: string) => segment.length === 0));
        }
        return () => undefined;
      },
      registerModelDiscovery(settingsNs: string) {
        discoveryNs = settingsNs;
        return () => undefined;
      },
    },
  };

  const result = apply(mockCtx, {
    command: 'copilot',
  });

  assert.ok(result.adapter);
  assert.ok(registeredAdapter);
  assert.deepStrictEqual(registeredRoutes, ['github-copilot-acp', 'copilot-acp']);
  assert.strictEqual(discoveryNs, 'github-copilot-acp');
});
