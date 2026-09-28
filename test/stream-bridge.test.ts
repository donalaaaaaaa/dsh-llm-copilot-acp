import test from 'node:test';
import assert from 'node:assert';
import { AcpStreamEmitter } from '../lib/stream-bridge.js';

test('AcpStreamEmitter: handles agent_thought_chunk to reasoning delta', () => {
  const emitter = new AcpStreamEmitter();

  const chunks1 = emitter.handleSessionUpdate({
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: 'Thinking step 1...' },
  });

  assert.strictEqual(chunks1.length, 2);
  assert.deepStrictEqual(chunks1[0], {
    type: 'block-start',
    index: 0,
    blockType: 'reasoning',
  });
  assert.deepStrictEqual(chunks1[1], {
    type: 'reasoning-delta',
    index: 0,
    text: 'Thinking step 1...',
  });

  const chunks2 = emitter.handleSessionUpdate({
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: 'step 2' },
  });

  assert.strictEqual(chunks2.length, 1);
  assert.deepStrictEqual(chunks2[0], {
    type: 'reasoning-delta',
    index: 0,
    text: 'step 2',
  });

  const finishChunks = emitter.finish();
  assert.deepStrictEqual(finishChunks[0], {
    type: 'block-end',
    index: 0,
    block: {
      type: 'reasoning',
      text: 'Thinking step 1...step 2',
    },
  });
  assert.deepStrictEqual(finishChunks[1], {
    type: 'finish',
    reason: { kind: 'stop' },
  });
});

test('AcpStreamEmitter: handles transition from reasoning to text', () => {
  const emitter = new AcpStreamEmitter();

  emitter.handleSessionUpdate({
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: 'analyzing...' },
  });

  const textChunks = emitter.handleSessionUpdate({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Here is the answer.' },
  });

  assert.strictEqual(textChunks.length, 3);
  assert.strictEqual(textChunks[0].type, 'block-end');
  assert.strictEqual(textChunks[1].type, 'block-start');
  assert.strictEqual((textChunks[1] as any).blockType, 'text');
  assert.strictEqual(textChunks[2].type, 'text-delta');

  const finishChunks = emitter.finish();
  assert.strictEqual(finishChunks[0].type, 'block-end');
  assert.strictEqual(finishChunks[1].type, 'finish');
  assert.strictEqual((finishChunks[1] as any).reason.kind, 'stop');
});

test('AcpStreamEmitter: ignores native ACP tool_call updates', () => {
  const emitter = new AcpStreamEmitter();

  emitter.handleSessionUpdate({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Let me run a tool.' },
  });

  assert.deepStrictEqual(emitter.handleSessionUpdate({
    sessionUpdate: 'tool_call',
    toolCallId: 'tc_456',
    name: 'bash',
    rawInput: { command: 'ls -la' },
  }), []);
  assert.deepStrictEqual(emitter.handleSessionUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tc_456',
    status: 'completed',
  }), []);

  const finishChunks = emitter.finish();
  assert.ok(finishChunks.every((chunk) => chunk.type !== 'tool-call-delta'));
  assert.strictEqual((finishChunks[finishChunks.length - 1] as any).reason.kind, 'stop');
});

test('AcpStreamEmitter: extracts text tool calls without leaking markup', () => {
  const emitter = new AcpStreamEmitter();

  const updateChunks = emitter.handleSessionUpdate({
    sessionUpdate: 'agent_message_chunk',
    content: {
      type: 'text',
      text: 'I will list files:\n<tool_call>{"name": "glob", "arguments": {"pattern": "*.ts"}}</tool_call>',
    },
  });
  const chunks = [...updateChunks, ...emitter.finish()];

  const visibleText = chunks
    .filter((chunk) => chunk.type === 'text-delta')
    .map((chunk: any) => chunk.text)
    .join('');
  assert.strictEqual(visibleText, 'I will list files:\n');
  assert.doesNotMatch(visibleText, /tool_call/i);

  const deltas = chunks.filter((chunk) => chunk.type === 'tool-call-delta');
  assert.strictEqual(deltas.length, 1);
  assert.strictEqual((deltas[0] as any).name, 'glob');
  assert.strictEqual((deltas[0] as any).argumentsDelta, '{"pattern":"*.ts"}');

  const finish = chunks[chunks.length - 1] as any;
  assert.strictEqual(finish.type, 'finish');
  assert.strictEqual(finish.reason.kind, 'tool-calls');
});

test('AcpStreamEmitter: buffers tool tags split across ACP chunks', () => {
  const emitter = new AcpStreamEmitter();
  const chunks: any[] = [];

  chunks.push(...emitter.handleSessionUpdate({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Before <tool_' },
  }));
  chunks.push(...emitter.handleSessionUpdate({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'call>{"name":"glob","arguments":{"pattern":"src/*"}}</tool_call> After' },
  }));
  chunks.push(...emitter.finish());

  const text = chunks
    .filter((chunk) => chunk.type === 'text-delta')
    .map((chunk) => chunk.text)
    .join('');
  assert.strictEqual(text, 'Before  After');
  assert.doesNotMatch(text, /<tool_|tool_call>/i);
  assert.strictEqual(chunks.filter((chunk) => chunk.type === 'tool-call-delta').length, 1);
  assert.strictEqual(chunks[chunks.length - 1].reason.kind, 'tool-calls');
});

test('AcpStreamEmitter: preserves malformed incomplete tool markup as text', () => {
  const emitter = new AcpStreamEmitter();
  const chunks = [
    ...emitter.handleSessionUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Literal <tool_call>{not-json' },
    }),
    ...emitter.finish(),
  ];
  const text = chunks
    .filter((chunk) => chunk.type === 'text-delta')
    .map((chunk: any) => chunk.text)
    .join('');
  assert.strictEqual(text, 'Literal <tool_call>{not-json');
  assert.strictEqual((chunks[chunks.length - 1] as any).reason.kind, 'stop');
});

test('AcpStreamEmitter: maps ACP stop reasons', () => {
  assert.strictEqual((new AcpStreamEmitter().finish(undefined, undefined, 'max_tokens').at(-1) as any).reason.kind, 'max-tokens');
  assert.strictEqual((new AcpStreamEmitter().finish(undefined, undefined, 'cancelled').at(-1) as any).reason.kind, 'aborted');

  const refusal = new AcpStreamEmitter().finish(undefined, undefined, 'refusal').at(-1) as any;
  assert.strictEqual(refusal.reason.kind, 'error');
  assert.strictEqual(refusal.reason.failure.code, 'ACP_REFUSAL');

  const turns = new AcpStreamEmitter().finish(undefined, undefined, 'max_turn_requests').at(-1) as any;
  assert.strictEqual(turns.reason.kind, 'error');
  assert.strictEqual(turns.reason.failure.code, 'ACP_MAX_TURN_REQUESTS');
});

test('AcpStreamEmitter: does not treat context usage as token usage', () => {
  const emitter = new AcpStreamEmitter();
  assert.deepStrictEqual(emitter.handleSessionUpdate({
    sessionUpdate: 'usage_update',
    used: 1250,
    size: 128000,
  }), []);
});
