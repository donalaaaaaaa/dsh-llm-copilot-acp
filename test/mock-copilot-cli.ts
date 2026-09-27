import { createInterface } from 'node:readline';
import { resolve } from 'node:path';

const rl = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

function send(msg: any) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

let pendingResponses = new Map<number, (val: any) => void>();
let sessionCounter = 0;
const sessionCwds = new Map<string, string>();

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
          agentCapabilities: { loadSession: true },
          echoedPermission: permission?.result ?? null,
          echoedClientCapabilities: params?.clientCapabilities ?? null,
        },
      });
      return;
    }

    if (method === 'session/new') {
      const sessionId = `sess_mock_${String(++sessionCounter).padStart(3, '0')}`;
      sessionCwds.set(sessionId, params?.cwd || process.cwd());
      send({
        jsonrpc: '2.0',
        id,
        result: {
          sessionId,
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

    if (method === 'session/load') {
      const sessionId = String(params?.sessionId || '');
      sessionCwds.set(sessionId, params?.cwd || process.cwd());
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'replayed history' },
          },
        },
      });
      send({ jsonrpc: '2.0', id, result: {} });
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
        const reqId = 9999;
        const readPromise = new Promise((resolve) => {
          pendingResponses.set(reqId, resolve);
        });
        const sessionId = String(params?.sessionId || '');
        const cwd = sessionCwds.get(sessionId) || process.cwd();
        send({
          jsonrpc: '2.0',
          id: reqId,
          method: 'fs/read_text_file',
          params: {
            sessionId,
            path: resolve(cwd, 'test_read.txt'),
            ...(promptText.includes('trigger_read_file_slice') ? { line: 2, limit: 2 } : {}),
          },
        });

        const res: any = await readPromise;
        const fileContent = res?.result?.content || '(empty)';

        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: String(params?.sessionId || ''),
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
        const sessionId = String(params?.sessionId || '');
        const cwd = sessionCwds.get(sessionId) || process.cwd();
        send({
          jsonrpc: '2.0',
          id: reqId,
          method: 'fs/read_text_file',
          params: { sessionId, path: resolve(cwd, '..', 'outside-copilot-acp-secret.txt') },
        });
        const res: any = await readPromise;
        const text = res?.error ? `READ_DENIED ${res.error.message}` : 'READ_ALLOWED';
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: String(params?.sessionId || ''),
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text },
            },
          },
        });
        send({ jsonrpc: '2.0', id, result: {} });
        return;
      }

      if (promptText.includes('trigger_read_relative')) {
        const reqId = 4343;
        const readPromise = new Promise((resolve) => pendingResponses.set(reqId, resolve));
        send({
          jsonrpc: '2.0',
          id: reqId,
          method: 'fs/read_text_file',
          params: { sessionId: String(params?.sessionId || ''), path: 'relative.txt' },
        });
        const res: any = await readPromise;
        const text = res?.error ? `RELATIVE_DENIED ${res.error.message}` : 'RELATIVE_ALLOWED';
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: String(params?.sessionId || ''),
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text },
            },
          },
        });
        send({ jsonrpc: '2.0', id, result: {} });
        return;
      }

      if (promptText.includes('trigger_write_file')) {
        const reqId = 5151;
        const writePromise = new Promise((resolve) => pendingResponses.set(reqId, resolve));
        const sessionId = String(params?.sessionId || '');
        const cwd = sessionCwds.get(sessionId) || process.cwd();
        send({
          jsonrpc: '2.0',
          id: reqId,
          method: 'fs/write_text_file',
          params: {
            sessionId,
            path: resolve(cwd, 'test_write.txt'),
            content: 'written by mock',
          },
        });
        const res: any = await writePromise;
        const text = res?.error ? `WRITE_DENIED ${res.error.message}` : 'WRITE_OK';
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
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
            sessionId: String(params?.sessionId || ''),
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
            sessionId: String(params?.sessionId || ''),
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
            sessionId: String(params?.sessionId || ''),
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
            sessionId: String(params?.sessionId || ''),
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
      const sessionId = String(params?.sessionId || '');
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
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
          sessionId,
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
          sessionId,
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
