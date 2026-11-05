#!/usr/bin/env node
import http from 'node:http';
import { createInterface } from 'node:readline';
import { resolveRoot } from './root.js';
import { handleRequest } from './protocol.js';

const DEFAULT_HTTP_PORT = 9750;
const HTTP_PATH = '/mcp';
const MAX_HTTP_BODY_BYTES = 1024 * 1024;
const PARSE_ERROR_LINE = JSON.stringify({
  jsonrpc: '2.0',
  id: null,
  error: { code: -32700, message: 'Parse error' }
});

function readArgValue(argv, flag) {
  const idx = argv.indexOf(flag);
  if (idx === -1 || idx === argv.length - 1) return undefined;
  return argv[idx + 1];
}

function parseTransportConfig(argv) {
  const transport = argv.includes('--http') || readArgValue(argv, '--transport') === 'http' ? 'http' : 'stdio';
  const portArg = readArgValue(argv, '--port');
  const parsedPort = portArg !== undefined ? Number(portArg) : DEFAULT_HTTP_PORT;
  if (transport === 'http' && (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535)) {
    throw new Error(`invalid HTTP port: ${portArg}`);
  }
  return { transport, port: parsedPort };
}

function writeStdioResponse(response) {
  if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
}

function startStdioServer(root) {
  process.stderr.write(`cocos-slot-mcp: transport=stdio root=${root}\n`);
  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch (err) {
      process.stderr.write(`invalid JSON line ignored: ${err.message}\n`);
      process.stdout.write(`${PARSE_ERROR_LINE}\n`);
      return;
    }
    let response;
    try {
      response = await handleRequest(message, root);
    } catch (err) {
      process.stderr.write(`unhandled error: ${err.stack || err.message}\n`);
      return;
    }
    writeStdioResponse(response);
  });
  rl.on('close', () => {
    process.exitCode = 0;
  });
}

function readHttpBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_HTTP_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendHttpJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'mcp-protocol-version': '2024-11-05',
    'x-content-type-options': 'nosniff'
  });
  res.end(text);
}

async function handleHttpRequest(req, res, root) {
  const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
  if (requestUrl.pathname === '/health' && req.method === 'GET') {
    sendHttpJson(res, 200, { status: 'ok', transport: 'http', endpoint: HTTP_PATH, root, readOnly: true });
    return;
  }
  if (requestUrl.pathname !== HTTP_PATH) {
    sendHttpJson(res, 404, { error: 'not found' });
    return;
  }
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    sendHttpJson(res, 405, { error: 'method not allowed', allow: 'POST' });
    return;
  }
  try {
    const parsed = JSON.parse(await readHttpBody(req));
    const response = await handleRequest(parsed, root);
    if (response === null) {
      res.writeHead(202, { 'mcp-protocol-version': '2024-11-05' });
      res.end();
      return;
    }
    sendHttpJson(res, 200, response);
  } catch (err) {
    const isBodyLimit = err.message === 'request body too large';
    if (isBodyLimit) {
      sendHttpJson(res, 413, { error: err.message });
      return;
    }
    sendHttpJson(res, 200, JSON.parse(PARSE_ERROR_LINE));
  }
}

function startHttpServer(root, port) {
  const server = http.createServer((req, res) => {
    handleHttpRequest(req, res, root).catch((err) => {
      sendHttpJson(res, 500, { error: err.message });
    });
  });
  server.listen(port, '127.0.0.1', () => {
    process.stderr.write(`cocos-slot-mcp: transport=http root=${root} listening on http://127.0.0.1:${port}${HTTP_PATH}\n`);
  });
}

function main() {
  let root;
  let transportConfig;
  try {
    root = resolveRoot(process.argv.slice(2));
    transportConfig = parseTransportConfig(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`fatal: ${err.message}\n`);
    process.exitCode = 1;
    return;
  }
  if (transportConfig.transport === 'http') {
    startHttpServer(root, transportConfig.port);
    return;
  }
  startStdioServer(root);
}

main();
