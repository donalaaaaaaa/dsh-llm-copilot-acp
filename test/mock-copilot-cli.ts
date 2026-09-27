import { createInterface } from 'node:readline';

const rl = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

function send(msg: any) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

let pendingResponses = new Map<number, (val: any) => void>();

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  try {
    const msg = JSON.parse(trimmed);

    // If client responded to our request
    if (msg.id !== undefined && pendingResponses.has(msg.id)) {
      const cb = pendingResponses.get(msg.id)!;
      pendingResponses.delete(msg.id);
      cb(msg);
      return;
    }

    const { id, method, params } = msg;

    if (method === 'initialize') {
      // Reuse the in-flight request id. A client that treats every id as its
      // own response will swallow this permission request and hang here.
      const permission: any = await new Promise((resolve) => {
        pendingResponses.set(id, resolve);
        send({
          jsonrpc: '2.0',
          id,
          method: 'session/request_permission',
          params: {
            sessionId: 'pending',
            toolCall: { toolCallId: 'perm', title: 'read' },
            options: [
              { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
              { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
            ],
          },
        });
      });
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: 1,
          capabilities: { models: true },
          echoedPermission: permission?.result ?? null,
        },
      });
      return;
    }

    if (method === 'session/new') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          sessionId: 'sess_mock_001',
          configOptions: [
            {
              id: 'model',
              category: 'model',
              options: [
                { value: 'gpt-4o' },
                { value: 'claude-3.5-sonnet' },
                { value: 'o1-preview' },
              ],
            },
          ],
        },
      });
      return;
    }

    if (method === 'session/set_config_option' || method === 'session/set_model') {
      send({
        jsonrpc: '2.0',
        id,
        result: {},
      });
      return;
    }

    if (method === 'session/prompt') {
      const promptText = params?.prompt?.[0]?.text || '';

      if (promptText.includes('trigger_read_file')) {
        // Send a request to client to read a file
        const reqId = 9999;
        const readPromise = new Promise((resolve) => {
          pendingResponses.set(reqId, resolve);
        });

        send({
          jsonrpc: '2.0',
          id: reqId,
          method: 'fs/read_text_file',
          params: { path: 'test_read.txt' },
        });

        const res: any = await readPromise;
        const fileContent = res?.result?.content || '(empty)';

        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `Read file: ${fileContent}` },
            },
          },
        });

        send({ jsonrpc: '2.0', id, result: {} });
        return;
      }

      if (promptText.includes('trigger_read_outside')) {
        const reqId = 4242;
        const readPromise = new Promise((resolve) => {
          pendingResponses.set(reqId, resolve);
        });
        send({
          jsonrpc: '2.0',
          id: reqId,
          method: 'fs/read_text_file',
          params: { path: 'D:\\outside-copilot-acp\\secret.txt' },
        });
        const res: any = await readPromise;
        const text = res?.error ? `READ_DENIED ${res.error.message}` : 'READ_ALLOWED';
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text },
            },
          },
        });
        send({ jsonrpc: '2.0', id, result: {} });
        return;
      }

      if (promptText.includes('trigger_text_tool')) {
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: 'Calling DSH.\n<tool_call>{"name":"glob","arguments":{"pattern":"*.ts"}}</tool_call>',
              },
            },
          },
        });
        send({ jsonrpc: '2.0', id, result: {} });
        return;
      }

      if (promptText.includes('trigger_tool')) {
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            update: {
              sessionUpdate: 'agent_thought_chunk',
              content: { type: 'text', text: 'I will call a tool.' },
            },
          },
        });

        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'call_mock_123',
              name: 'calculator',
              rawInput: { expression: '2+2' },
            },
          },
        });

        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'call_mock_123',
              status: 'completed',
            },
          },
        });

        send({ jsonrpc: '2.0', id, result: {} });
        return;
      }

      // Normal prompt streaming
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          update: {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: 'Analyzing ACP request...' },
          },
        },
      });

      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Hello from mock Copilot ACP!' },
          },
        },
      });

      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          update: {
            sessionUpdate: 'usage_update',
            used: 150,
            size: 128000,
          },
        },
      });

      send({
        jsonrpc: '2.0',
        id,
        result: {},
      });
      return;
    }

    if (id !== undefined) {
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Unknown method: ${method}` },
      });
    }
  } catch (err: any) {
    // ignore
  }
});
