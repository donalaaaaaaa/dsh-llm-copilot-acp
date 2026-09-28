import test from 'node:test';
import assert from 'node:assert';
import {
  formatMessagesAsPrompt,
  renderToolBridge,
  extractToolCallsFromText,
  renderContent,
} from '../lib/prompt-bridge.js';
import type { DshMessage, GenerateOptions } from '../lib/types.js';

test('renderToolBridge: renders OpenAI function-call style schema', () => {
  const tools = [
    {
      name: 'read_file',
      description: 'Read a file from disk',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
        },
        required: ['path'],
      },
    },
  ];

  const rendered = renderToolBridge(tools);
  assert.ok(rendered.length > 0);
  assert.ok(rendered.some((line) => line.includes('# Available Tools')));
  assert.ok(rendered.some((line) => line.includes('"name": "read_file"')));
});

test('renderContent: handles string, text block, reasoning block, tool calls', () => {
  assert.strictEqual(renderContent('hello world'), 'hello world');
  assert.strictEqual(
    renderContent([{ type: 'text', text: 'part 1' }, { type: 'text', text: 'part 2' }]),
    'part 1\npart 2'
  );
  assert.strictEqual(
    renderContent([{ type: 'reasoning', text: 'deep thought' }]),
    '[Thinking: deep thought]'
  );
  assert.ok(
    renderContent([
      {
        type: 'tool-call',
        id: 'call_1',
        name: 'test_tool',
        arguments: '{"foo": "bar"}',
      },
    ]).includes('<tool_call>{"name":"test_tool","arguments":{"foo":"bar"}}</tool_call>')
  );
});

test('formatMessagesAsPrompt: formats full conversation into ACP prompt', () => {
  const messages: DshMessage[] = [
    {
      role: 'user',
      content: [{ type: 'text', text: 'List the files in src/' }],
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          id: 'call_123',
          name: 'glob',
          arguments: '{"pattern": "src/*"}',
        },
      ],
    },
    {
      role: 'tool',
      toolCallId: 'call_123',
      content: [{ type: 'text', text: 'index.ts, adapter.ts' }],
    },
  ];

  const options: GenerateOptions = {
    provider: 'github-copilot-acp',
    model: 'gpt-4o',
    messages,
    system: 'You are an expert engineer.',
  };

  const prompt = formatMessagesAsPrompt(options);

  assert.ok(prompt.includes('You are being used as the active ACP agent backend for DeepSeek Harness.'));
  assert.ok(prompt.includes('System Instructions:\nYou are an expert engineer.'));
  assert.ok(prompt.includes('Conversation transcript:'));
  assert.ok(prompt.includes('User:\nList the files in src/'));
  assert.ok(prompt.includes('Assistant:\n<tool_call>{"name":"glob"'));
  assert.ok(prompt.includes('Tool (call_id: call_123):\nindex.ts, adapter.ts'));
  assert.ok(prompt.includes('Continue the conversation from the latest user request.'));
});

test('formatMessagesAsPrompt: declares DSH tool ownership when tools are available', () => {
  const prompt = formatMessagesAsPrompt({
    provider: 'github-copilot-acp',
    model: 'gpt-4o',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Inspect src' }] }],
    tools: [{
      name: 'glob',
      description: 'Find files',
      parameters: { type: 'object', properties: { pattern: { type: 'string' } } },
    }],
  });

  assert.match(prompt, /DeepSeek Harness owns execution/);
  assert.match(prompt, /<tool_call>/);
  assert.match(prompt, /"name": "glob"/);
});

test('extractToolCallsFromText: extracts <tool_call> and cleans text', () => {
  const text =
    'I will now check the file.\n' +
    '<tool_call>{"name": "read_file", "arguments": {"path": "src/index.ts"}}</tool_call>\n' +
    'Please wait while I process.';

  const { toolCalls, cleanedText } = extractToolCallsFromText(text);

  assert.strictEqual(toolCalls.length, 1);
  assert.strictEqual(toolCalls[0].name, 'read_file');
  assert.deepStrictEqual(toolCalls[0].arguments, { path: 'src/index.ts' });
  assert.strictEqual(
    cleanedText,
    'I will now check the file.\n\nPlease wait while I process.'
  );
});
