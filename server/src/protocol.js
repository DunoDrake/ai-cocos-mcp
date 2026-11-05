import { TOOLS, callTool } from './tools/index.js';
import { ProtocolError } from './errors.js';
import { PROTOCOL_VERSION, SERVER_NAME, SERVER_VERSION } from './constants.js';

const SILENT_NOTIFICATIONS = new Set([
  'initialized',
  'notifications/initialized',
  'notifications/cancelled',
  'notifications/roots/list_changed'
]);

function dispatch(method, params, root) {
  if (method === 'initialize') {
    return {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
    };
  }
  if (method === 'ping' || SILENT_NOTIFICATIONS.has(method)) {
    return {};
  }
  if (method === 'tools/list') {
    return { tools: TOOLS.map((tool) => tool.declaration) };
  }
  if (method === 'tools/call') {
    return callTool(params, root);
  }
  throw new ProtocolError(-32601, `Method not found: ${method}`);
}

export async function handleMessage(message, root) {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
  }
  const { id, method } = message;
  const isNotification = id === undefined;
  try {
    const result = await dispatch(method, message.params, root);
    return isNotification ? null : { jsonrpc: '2.0', id, result };
  } catch (err) {
    if (isNotification) return null;
    if (err instanceof ProtocolError) {
      const error = { code: err.code, message: err.message };
      if (err.data !== undefined) error.data = err.data;
      return { jsonrpc: '2.0', id, error };
    }
    return { jsonrpc: '2.0', id, error: { code: -32603, message: 'Internal error', data: { detail: err.message } } };
  }
}

// A batch is a top-level JSON array of request/notification objects (JSON-RPC
// 2.0 §6): each item is dispatched independently, notifications never appear
// in the response array, and an empty batch is itself an Invalid Request.
// Promise.all preserves input order in its resolved array regardless of
// per-item settle timing, so batch response order still matches request order.
export async function handleRequest(parsed, root) {
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
    }
    const settled = await Promise.all(parsed.map((item) => handleMessage(item, root)));
    const responses = settled.filter((response) => response !== null);
    return responses.length > 0 ? responses : null;
  }
  return handleMessage(parsed, root);
}
