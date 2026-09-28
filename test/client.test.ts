import test from 'node:test';
import assert from 'node:assert';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, mkdtemp, rm, symlink, writeFile, unlink } from 'node:fs/promises';
import {
  CopilotAcpClient,
  isGhCopilotDeprecation,
  permissionOutcome,
  resolveInsideCwd,
  resolveReadableInsideCwd,
  resolveWritableInsideCwd,
} from '../lib/client.js';

const mockCliPath = resolve('test/mock-copilot-cli.ts');
const nodeBin = process.execPath;

function mockArgs(...extra: string[]) {
  return ['--experimental-strip-types', mockCliPath, ...extra];
}

test('isGhCopilotDeprecation: recognizes gh copilot deprecation banners', () => {
  const sampleStderr =
    'The `gh-copilot` extension has been deprecated. No commands will be executed. Please use copilot instead.';
  assert.strictEqual(isGhCopilotDeprecation(sampleStderr), true);
  assert.strictEqual(isGhCopilotDeprecation('copilot: warning: network latency'), false);
});

test('CopilotAcpClient: initialize and session/new with mock CLI', async () => {
  const client = new CopilotAcpClient({
    command: nodeBin,
    args: mockArgs(),
    cwd: process.cwd(),
    timeoutMs: 5000,
  });

  try {
    const initRes = await client.initialize();
    assert.strictEqual(initRes.protocolVersion, 1);
    assert.strictEqual(initRes.echoedPermission.outcome.outcome, 'selected');
    assert.strictEqual(initRes.echoedPermission.outcome.optionId, 'allow-once');
    assert.deepStrictEqual(initRes.echoedCapabilities.fs, {
      readTextFile: true,
      writeTextFile: true,
    });

    const session = await client.newSession();
    assert.strictEqual(session.sessionId, 'sess_mock_001');
    assert.deepStrictEqual(
      client.extractModelsFromSession(session),
      ['gpt-4o', 'claude-3.5-sonnet', 'o1-preview']
    );
  } finally {
    client.close();
  }
});

test('CopilotAcpClient: does not advertise fs when file requests are disabled', async () => {
  const client = new CopilotAcpClient({
    command: nodeBin,
    args: mockArgs(),
    cwd: process.cwd(),
    timeoutMs: 5000,
    allowFileRequests: false,
  });
  try {
    const initRes = await client.initialize();
    assert.deepStrictEqual(initRes.echoedCapabilities, {});
  } finally {
    client.close();
  }
});

test('CopilotAcpClient: setModel and prompt streaming', async () => {
  const client = new CopilotAcpClient({
    command: nodeBin,
    args: mockArgs(),
    cwd: process.cwd(),
    timeoutMs: 5000,
  });

  try {
    await client.initialize();
    const session = await client.newSession();
    assert.strictEqual(await client.setModel(session.sessionId, 'claude-3.5-sonnet', session), true);

    const updates: any[] = [];
    const promptRes = await client.prompt(session.sessionId, 'Hello copilot', (update) => updates.push(update));

    assert.strictEqual(promptRes.stopReason, 'end_turn');
    assert.strictEqual(updates.length, 3);
    assert.strictEqual(updates[0].sessionUpdate, 'agent_thought_chunk');
    assert.strictEqual(updates[1].sessionUpdate, 'agent_message_chunk');
    assert.strictEqual(updates[2].sessionUpdate, 'usage_update');
  } finally {
    client.close();
  }
});

test('CopilotAcpClient: client handles server fs/read_text_file requests', async () => {
  const testFilePath = resolve('test_read.txt');
  await writeFile(testFilePath, 'hello file content 123', 'utf8');

  const client = new CopilotAcpClient({
    command: nodeBin,
    args: mockArgs(),
    cwd: process.cwd(),
    timeoutMs: 5000,
    allowFileRequests: true,
  });

  try {
    await client.initialize();
    const session = await client.newSession();

    let receivedText = '';
    await client.prompt(session.sessionId, 'trigger_read_file', (update) => {
      if (update.sessionUpdate === 'agent_message_chunk') receivedText += update.content.text;
    });

    assert.ok(receivedText.includes('Read file: hello file content 123'));
  } finally {
    client.close();
    await unlink(testFilePath).catch(() => {});
  }
});

test('CopilotAcpClient: fs/read_text_file honors line and limit', async () => {
  const testFilePath = resolve('test_read.txt');
  await writeFile(testFilePath, 'line-1\nline-2\nline-3', 'utf8');

  const client = new CopilotAcpClient({
    command: nodeBin,
    args: mockArgs(),
    cwd: process.cwd(),
    timeoutMs: 5000,
    allowFileRequests: true,
  });

  try {
    await client.initialize();
    const session = await client.newSession();
    let receivedText = '';
    await client.prompt(session.sessionId, 'trigger_read_slice', (update) => {
      if (update.sessionUpdate === 'agent_message_chunk') receivedText += update.content.text;
    });
    assert.strictEqual(receivedText, 'Slice: line-2');
  } finally {
    client.close();
    await unlink(testFilePath).catch(() => {});
  }
});

test('CopilotAcpClient: listModels returns only advertised models', async () => {
  const client = new CopilotAcpClient({
    command: nodeBin,
    args: mockArgs(),
    cwd: process.cwd(),
    timeoutMs: 5000,
  });
  assert.deepStrictEqual(
    await client.listModels(5000),
    ['gpt-4o', 'claude-3.5-sonnet', 'o1-preview']
  );

  const empty = new CopilotAcpClient({
    command: nodeBin,
    args: mockArgs('--no-models'),
    cwd: process.cwd(),
    timeoutMs: 5000,
  });
  assert.deepStrictEqual(await empty.listModels(5000), []);
});

test('CopilotAcpClient: extracts grouped model config options', async () => {
  const client = new CopilotAcpClient({
    command: nodeBin,
    args: mockArgs('--grouped-models'),
    cwd: process.cwd(),
    timeoutMs: 5000,
  });
  try {
    await client.initialize();
    const session = await client.newSession();
    assert.deepStrictEqual(
      client.extractModelsFromSession(session),
      ['gpt-4o', 'o1-preview', 'claude-3.5-sonnet']
    );
    assert.strictEqual(await client.setModel(session.sessionId, 'claude-3.5-sonnet', session), true);
    assert.strictEqual(await client.setModel(session.sessionId, 'not-advertised', session), false);
  } finally {
    client.close();
  }
});

test('resolveInsideCwd rejects lexical traversal', () => {
  const root = resolve('sandbox-root');
  assert.strictEqual(resolveInsideCwd(root, 'a.txt'), resolve(root, 'a.txt'));
  assert.throws(() => resolveInsideCwd(root, '../secret.txt'), /Access denied/);
  assert.throws(() => resolveInsideCwd(root, resolve(root, '..', 'sibling', 'x')), /Access denied/);
});

test('canonical file sandbox rejects symlink or junction escapes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'copilot-acp-root-'));
  const outside = await mkdtemp(join(tmpdir(), 'copilot-acp-outside-'));
  const link = join(root, 'escape');
  await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8');

  try {
    try {
      await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (err: any) {
      if (err?.code === 'EPERM' || err?.code === 'EACCES') {
        t.skip('symlink/junction creation is not permitted on this system');
        return;
      }
      throw err;
    }

    await assert.rejects(() => resolveReadableInsideCwd(root, 'escape/secret.txt'), /outside session cwd/);
    await assert.rejects(() => resolveWritableInsideCwd(root, 'escape/new.txt'), /outside session cwd/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('permissionOutcome respects explicit permission mode', () => {
  const params = {
    options: [
      { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
      { optionId: 'always', kind: 'allow_always', name: 'Always' },
    ],
  };
  assert.deepStrictEqual(permissionOutcome(params, 'allow-always'), {
    outcome: { outcome: 'selected', optionId: 'always' },
  });
  assert.deepStrictEqual(permissionOutcome(params, 'allow-once'), {
    outcome: { outcome: 'selected', optionId: 'once' },
  });
  assert.deepStrictEqual(permissionOutcome(params, 'deny'), {
    outcome: { outcome: 'cancelled' },
  });
  // Backward-compatible boolean inputs.
  assert.deepStrictEqual(permissionOutcome(params, true), {
    outcome: { outcome: 'selected', optionId: 'always' },
  });
});

test('CopilotAcpClient: file bridge denies paths outside the session cwd', async () => {
  const client = new CopilotAcpClient({
    command: nodeBin,
    args: mockArgs(),
    cwd: process.cwd(),
    timeoutMs: 5000,
    allowFileRequests: true,
  });
  try {
    await client.initialize();
    const session = await client.newSession();
    let receivedText = '';
    await client.prompt(session.sessionId, 'trigger_read_outside', (update) => {
      if (update.sessionUpdate === 'agent_message_chunk') receivedText += update.content.text;
    });
    assert.match(receivedText, /READ_DENIED/);
    assert.doesNotMatch(receivedText, /READ_ALLOWED/);
  } finally {
    client.close();
  }
});

test('CopilotAcpClient: listModels honors its timeout', async () => {
  const hangPath = resolve('test/mock-hang.ts');
  const client = new CopilotAcpClient({
    command: nodeBin,
    args: ['--experimental-strip-types', hangPath],
    cwd: process.cwd(),
    timeoutMs: 900000,
  });
  const started = Date.now();
  await assert.rejects(() => client.listModels(400), /Timed out/);
  assert.ok(Date.now() - started < 3000);
});

test('CopilotAcpClient: missing CLI fails fast and can be retried', async () => {
  const client = new CopilotAcpClient({
    command: 'copilot-acp-missing-binary-xyz',
    cwd: process.cwd(),
    timeoutMs: 2000,
  });
  await assert.rejects(() => client.initialize(), /Could not start Copilot ACP command/);
  const started = Date.now();
  await assert.rejects(() => client.initialize(), /Could not start Copilot ACP command/);
  assert.ok(Date.now() - started < 1500);
});
