import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

export const BRIDGE_EXTENSION = 'cc30-mcp-server-extension';
const MAX_RESPONSE_BYTES = 8192;
export const MAX_TREE_RESPONSE_BYTES = 262144;
const REQUEST_TIMEOUT_MS = 5000;

// Only this fixed discovery file may bypass the generic generated-directory denylist.
export function readBridgeConnection(projectPath) {
  const sentinel = path.join(projectPath, 'temp', 'mcp-editor-server.json');
  if (fs.realpathSync(sentinel) !== sentinel) throw new Error('Bridge discovery file must not use symlinks');
  if (fs.statSync(sentinel).size > MAX_RESPONSE_BYTES) throw new Error('Bridge discovery file is too large');
  const connection = JSON.parse(fs.readFileSync(sentinel, 'utf8'));
  if (!connection || connection.projectPath !== projectPath || connection.extension !== BRIDGE_EXTENSION || connection.bridgeVersion !== 1) {
    throw new Error('Wrong project or obsolete bridge; reload the extension in this project');
  }
  if (!Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65535 ||
      typeof connection.token !== 'string' || !/^[a-f0-9]{64}$/.test(connection.token) ||
      typeof connection.instanceId !== 'string' || !/^[a-f0-9]{32}$/.test(connection.instanceId)) {
    throw new Error('Invalid bridge connection details');
  }
  return connection;
}

export function requestBridge(connection, requestPath, maxResponseBytes, options) {
  const limit = maxResponseBytes || MAX_RESPONSE_BYTES;
  const method = (options && options.method) || 'GET';
  const bodyPayload = options && options.body !== undefined ? Buffer.from(JSON.stringify(options.body), 'utf8') : null;
  return new Promise((resolve, reject) => {
    const headers = { Authorization: `Bearer ${connection.token}` };
    if (bodyPayload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(bodyPayload.length);
    }
    const request = http.request({
      hostname: '127.0.0.1', port: connection.port, path: requestPath, method,
      headers, agent: false
    }, (response) => {
      let size = 0;
      const chunks = [];
      response.on('error', reject);
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) return request.destroy(new Error('Bridge response too large'));
        chunks.push(chunk);
      });
      response.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch (error) { return reject(new Error('Bridge returned invalid JSON')); }
        if (response.statusCode !== 200) {
          const detail = parsed && typeof parsed.error === 'string' ? parsed.error : `HTTP ${response.statusCode}`;
          return reject(new Error(`Bridge HTTP ${response.statusCode}: ${detail}`));
        }
        resolve(parsed);
      });
    });
    const timer = setTimeout(() => request.destroy(new Error('Bridge timed out after 5 seconds')), REQUEST_TIMEOUT_MS);
    request.on('close', () => clearTimeout(timer));
    request.on('error', reject);
    if (bodyPayload) request.end(bodyPayload);
    else request.end();
  });
}
