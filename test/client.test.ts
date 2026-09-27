import test from 'node:test';
import assert from 'node:assert';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFile, unlink, mkdtemp, rm, symlink } from 'node:fs/promises';
import {
  CopilotAcpClient,
  isGhCopilotDeprecation,
  permissionOutcome,
  resolveInsideCwd,
  resolveInsideCwdCanonical,
} from '../lib/client.js';

const mockCliPath = resolve('test/mock-copilot-cli.ts');
const nodeBin = process.execPath;

test('isGhCopilotDeprecation: recognizes gh copilot deprecation banners', () => {
  const sampleStderr =
    'The `gh-copilot` extension has been deprecated. No commands will be executed. Please use copilot instead.';
  assert.strictEqual(isGhCopilotDeprecation(sampleStderr), true);

  const normalStderr = 'copilot: warning: network latency';
  assert.strictEqual(isGhCopilotDeprecation(normalStderr), false);
});

test('CopilotAcpClient: initialize and session/new with mock CLI', async () => {
  const client = new CopilotAcpClient({
    command: nodeBin,
    args: ['--experimental-strip-types', mockCliPath],
    cwd: process.cwd(),
    timeoutMs: 5000,
    allowAllTools: true,
    allowFileRequests: true,
  });

  try {
    const initRes = await client.initialize();
    assert.strictEqual(initRes.protocolVersion, 1);
    assert.strictEqual(initRes.echoedPermission.outcome.outcome, 'selected');
    assert.strictEqual(initRes.echoedPermission.outcome.optionId, 'allow-once');
    assert.deepStrictEqual(initRes.echoedClientCapabilities.fs, {
      readTextFile: true,
      writeTextFile: true,
    });

    const session = await client.newSession();
    assert.strictEqual(session.sessionId, 'sess_mock_001');
    assert.ok(Array.isArray(session.configOptions));

    const models = client.extractModelsFromSession(session);
    assert.deepStrictEqual(models, ['gpt-4o', 'claude-3.5-sonnet', 'o1-preview']);
  } finally {
    client.close();
  }
});

test('CopilotAcpClient: least-privilege defaults cancel permissions and omit fs capability', async () => {
  const client = new CopilotAcpClient({
    command: nodeBin,
    args: ['--experimental-strip-types', mockCliPath],
    cwd: process.cwd(),
    timeoutMs: 5000,
  });
  try {
    const initRes = await client.initialize();
    assert.deepStrictEqual(initRes.echoedPermission, { outcome: { outcome: 'cancelled' } });
    assert.strictEqual(initRes.echoedClientCapabilities.fs, undefined);
  } finally {
    client.close();
  }
});

test('CopilotAcpClient: setModel and prompt streaming', async () => {
  const client = new CopilotAcpClient({
    command: nodeBin,
    args: ['--experimental-strip-types', mockCliPath],
    cwd: process.cwd(),
    timeoutMs: 5000,
  });

  try {
    await client.initialize();
    const session = await client.newSession();
    await client.setModel(session.sessionId, 'claude-3.5-sonnet', session);

    const updates: any[] = [];
    const promptRes = await client.prompt(
      session.sessionId,
      'Hello copilot',
      (update) => {
        updates.push(update);
      }
    );

    assert.ok(promptRes);
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
    args: ['--experimental-strip-types', mockCliPath],
    cwd: process.cwd(),
    timeoutMs: 5000,
    allowFileRequests: true,
  });

  try {
    await client.initialize();
    const session = await client.newSession();

    let receivedText = '';
    await client.prompt(
      session.sessionId,
      'trigger_read_file',
      (update) => {
        if (update.sessionUpdate === 'agent_message_chunk') {
          receivedText += update.content.text;
        }
      }
    );

    assert.ok(receivedText.includes('Read file: hello file content 123'));
  } finally {
    client.close();
    await unlink(testFilePath).catch(() => {});
  }
});

test('CopilotAcpClient: listModels discovery method', async () => {
  const client = new CopilotAcpClient({
    command: nodeBin,
    args: ['--experimental-strip-types', mockCliPath],
    cwd: process.cwd(),
    timeoutMs: 5000,
  });

  const models = await client.listModels(5000);
  assert.deepStrictEqual(models, ['gpt-4o', 'claude-3.5-sonnet', 'o1-preview']);
});

test('resolveInsideCwd rejects parent and sibling paths on the current platform', () => {
  const root = resolve('sandbox-root');
  assert.strictEqual(resolveInsideCwd(root, 'a.txt'), resolve(root, 'a.txt'));
  for (const target of ['../secret/x', '../sandbox-root-evil/x']) {
    assert.throws(() => resolveInsideCwd(root, target), /Access denied/);
  }
});

test('resolveInsideCwd rejects another drive on Windows', { skip: process.platform !== 'win32' }, () => {
  const root = 'C:\\work\\proj';
  assert.strictEqual(resolveInsideCwd(root, 'C:\\work\\proj\\a.txt'), 'C:\\work\\proj\\a.txt');
  assert.throws(() => resolveInsideCwd(root, 'D:\\secret\\x'), /Access denied/);
});

test('resolveInsideCwdCanonical rejects symlink or junction escapes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'copilot-acp-root-'));
  const outside = await mkdtemp(join(tmpdir(), 'copilot-acp-outside-'));
  try {
    await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8');
    const linkPath = join(root, 'escape');
    await symlink(outside, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(
      () => resolveInsideCwdCanonical(root, join('escape', 'secret.txt'), 'read'),
      /symbolic link|outside session cwd|Access denied/
    );
    await assert.rejects(
      () => resolveInsideCwdCanonical(root, join('escape', 'new.txt'), 'write'),
      /symbolic link|outside session cwd|Access denied/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('permissionOutcome uses a real option id or cancels', () => {
  const params = {
    options: [
      { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
      { optionId: 'always', kind: 'allow_always', name: 'Always' },
    ],
  };
  assert.deepStrictEqual(permissionOutcome(params, true), { outcome: { outcome: 'selected', optionId: 'always' } });
  assert.deepStrictEqual(permissionOutcome(params, false), { outcome: { outcome: 'cancelled' } });
  assert.deepStrictEqual(permissionOutcome({ options: [] }, true), { outcome: { outcome: 'cancelled' } });
});

test('CopilotAcpClient: file bridge denies paths outside the session cwd', async () => {
  const client = new CopilotAcpClient({
    command: nodeBin,
    args: ['--experimental-strip-types', mockCliPath],
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
