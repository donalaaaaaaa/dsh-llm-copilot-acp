import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { apply, inject, name } from '../lib/index.js';

const runtimeRoot = 'D:\\.deepseek\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai';

test('apply registers on the real LlmRuntime', async (t) => {
  const llmPath = `${runtimeRoot}\\dsh-llm\\lib\\index.js`;
  const cordisPath = `${runtimeRoot}\\cordis\\lib\\index.js`;
  if (!existsSync(llmPath) || !existsSync(cordisPath)) {
    t.skip('bundled DSH runtime is not available to this Node process');
    return;
  }
  let cordis: any;
  let llm: any;
  try {
    cordis = await import(pathToFileURL(cordisPath).href);
    llm = await import(pathToFileURL(llmPath).href);
  } catch (error: any) {
    t.skip(`bundled DSH runtime cannot be imported: ${error.message}`);
    return;
  }

  const ctx = new cordis.Context();
  await ctx.plugin(llm.default);
  await ctx.plugin({ name, inject, apply });

  const ids = ctx.llm.listProviders().map((provider: { id: string }) => provider.id);
  assert.deepStrictEqual(ids, ['github-copilot-acp', 'copilot-acp']);
  const directory = ctx.llm.listConfigurableProviders();
  assert.strictEqual(directory.length, 2);
  assert.ok(directory[0].settingsNs.length > 0);
  assert.strictEqual(directory[0].settingsNs, directory[1].settingsNs);
  assert.deepStrictEqual(directory[0].settingsPath, []);
  assert.deepStrictEqual(directory[1].settingsPath, []);
  assert.strictEqual(ctx.llm.imageRequestPricing('github-copilot-acp', 'gpt-4o'), undefined);
});
