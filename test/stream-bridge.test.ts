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

  // Finish
  const finishChunks = emitter.finish();
  assert.strictEqual(finishChunks.length, 2);
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

  // Should close reasoning block and start text block
  assert.strictEqual(textChunks.length, 3);
  assert.strictEqual(textChunks[0].type, 'block-end');
  assert.strictEqual(textChunks[1].type, 'block-start');
  assert.strictEqual((textChunks[1] as any).blockType, 'text');
  assert.strictEqual(textChunks[2].type, 'text-delta');

  const finishChunks = emitter.finish();
  assert.strictEqual(finishChunks.length, 2);
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

  const toolChunks = emitter.handleSessionUpdate({
    sessionUpdate: 'tool_call',
    toolCallId: 'tc_456',
    name: 'bash',
    rawInput: { command: 'ls -la' },
  });
  const updateChunks = emitter.handleSessionUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tc_456',
    status: 'completed',
    rawInput: { command: 'ls -la' },
  });

  assert.deepStrictEqual(toolChunks, []);
  assert.deepStrictEqual(updateChunks, []);

  const finishChunks = emitter.finish();
  assert.ok(finishChunks.every((chunk) => chunk.type !== 'tool-call-delta'));
  assert.strictEqual(finishChunks[finishChunks.length - 1].type, 'finish');
  assert.strictEqual((finishChunks[finishChunks.length - 1] as any).reason.kind, 'stop');
});

test('AcpStreamEmitter: handles text-based <tool_call> extraction', () => {
  const emitter = new AcpStreamEmitter();

  const streamed = emitter.handleSessionUpdate({
    sessionUpdate: 'agent_message_chunk',
    content: {
      type: 'text',
      text: 'I will list files:\n<tool_call>{"name": "glob", "arguments": {"pattern": "*.ts"}}</tool_call>',
    },
  });

  assert.ok(streamed.every((chunk) => chunk.type !== 'text-delta' || !chunk.text.includes('<tool_call>')));
  const finishChunks = emitter.finish();
  assert.ok(finishChunks.every((chunk) => chunk.type !== 'text-delta' || !chunk.text.includes('<tool_call>')));
  const deltas = finishChunks.filter((chunk) => chunk.type === 'tool-call-delta');
  assert.strictEqual(deltas.length, 1);
  assert.strictEqual((deltas[0] as any).argumentsDelta, '{"pattern":"*.ts"}');
  const toolEnd = finishChunks.find((chunk) => chunk.type === 'block-end' && (chunk as any).block?.type === 'tool-call');
  assert.strictEqual((toolEnd as any).block.arguments, '{"pattern":"*.ts"}');
  const finish = finishChunks[finishChunks.length - 1];
  assert.strictEqual(finish.type, 'finish');
  assert.strictEqual((finish as any).reason.kind, 'tool-calls');
});

test('AcpStreamEmitter: withholds tool tags split across ACP chunks', () => {
  const emitter = new AcpStreamEmitter();
  const chunks = [
    ...emitter.handleSessionUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Before <tool_' },
    }),
    ...emitter.handleSessionUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'call>{"name":"glob","arguments":' },
    }),
    ...emitter.handleSessionUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '{"pattern":"*.ts"}}</tool_call> After' },
    }),
    ...emitter.finish(),
  ];

  const visibleText = chunks
    .filter((chunk) => chunk.type === 'text-delta')
    .map((chunk: any) => chunk.text)
    .join('');
  assert.strictEqual(visibleText, 'Before  After');
  assert.doesNotMatch(visibleText, /tool_call/i);

  const toolCall = chunks.find((chunk) => chunk.type === 'tool-call-delta') as any;
  assert.ok(toolCall);
  assert.strictEqual(toolCall.name, 'glob');
  assert.strictEqual(toolCall.argumentsDelta, '{"pattern":"*.ts"}');
  const finish = chunks[chunks.length - 1] as any;
  assert.strictEqual(finish.reason.kind, 'tool-calls');
});

test('AcpStreamEmitter: preserves malformed unclosed tool tags as text', () => {
  const emitter = new AcpStreamEmitter();
  const chunks = [
    ...emitter.handleSessionUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Hello <tool_call>{"name":"broken"' },
    }),
    ...emitter.finish(),
  ];
  const visibleText = chunks
    .filter((chunk) => chunk.type === 'text-delta')
    .map((chunk: any) => chunk.text)
    .join('');
  assert.strictEqual(visibleText, 'Hello <tool_call>{"name":"broken"');
  assert.ok(chunks.every((chunk) => chunk.type !== 'tool-call-delta'));
});

test('AcpStreamEmitter: does not treat context usage as token usage', () => {
  const emitter = new AcpStreamEmitter();
  assert.deepStrictEqual(emitter.handleSessionUpdate({
    sessionUpdate: 'usage_update',
    used: 1250,
    size: 128000,
  }), []);
});
