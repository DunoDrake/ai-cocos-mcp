import { resolveInRoot } from '../root.js';
import { ToolError } from '../errors.js';
import { BRIDGE_EXTENSION, readBridgeConnection, requestBridge, MAX_TREE_RESPONSE_BYTES } from '../bridgeClient.js';

const NODE_UUID_PATTERN = /^[A-Za-z0-9+/=_-]{1,64}$/;
const ASSET_UUID_PATTERN = /^[A-Za-z0-9+/=_-]{1,64}(?:@[A-Za-z0-9_-]{1,64})?$/;
const MAX_DEPTH = 12;
const MAX_PROPERTY_PATH = 512;
const NODE_BATCH_SIZE = 10;
const ASSET_BATCH_SIZE = 100;

export const declaration = {
  name: 'scene_missing_refs_live',
  description: 'Inspect bounded live component serialized properties for missing asset UUID references using the Editor bridge. Read-only: queries node-tree, node details, and asset info only; never follows __id__ links, opens, modifies, or saves scenes. Unresolved component names and expected types remain null. Requires the updated companion extension.',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string', description: 'Cocos project directory relative to the server root, or an absolute path inside it.' },
      rootUuid: { type: 'string', description: 'Optional node UUID restricting inspection to its live subtree.' },
      maxNodes: { type: 'integer', default: 400, description: 'Node scan limit, clamped to 1..1000.' },
      maxRefs: { type: 'integer', default: 1000, description: 'Distinct reference occurrence limit, clamped to 1..5000.' }
    },
    required: ['projectPath'],
    additionalProperties: false
  }
};

function clampLimit(value, fallback, maximum, name) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return Math.max(1, Math.min(maximum, value));
}

export function validate(args) {
  if (!args || typeof args.projectPath !== 'string' || !args.projectPath.trim()) {
    throw new Error('projectPath must be a non-empty string');
  }
  if (args.rootUuid !== undefined && (typeof args.rootUuid !== 'string' || !NODE_UUID_PATTERN.test(args.rootUuid))) {
    throw new Error('rootUuid must be a non-empty uuid-like string');
  }
  return {
    projectPath: args.projectPath, rootUuid: args.rootUuid,
    maxNodes: clampLimit(args.maxNodes, 400, 1000, 'maxNodes'),
    maxRefs: clampLimit(args.maxRefs, 1000, 5000, 'maxRefs')
  };
}

function boundedString(value, limit, state) {
  if (typeof value !== 'string') return null;
  if (value.length > limit) state.truncated = true;
  return value.slice(0, limit);
}

async function requestData(state, route, params, field) {
  const query = new URLSearchParams({ projectPath: state.project, ...params });
  const data = await requestBridge(state.connection, `${route}?${query}`, MAX_TREE_RESPONSE_BYTES);
  if (!data || !Array.isArray(data[field]) || typeof data.truncated !== 'boolean' ||
      (route !== '/asset/info' && data.projectPath !== state.project)) {
    throw new Error(`Bridge returned an unexpected ${route} shape; reload the extension`);
  }
  state.truncated = state.truncated || data.truncated;
  return data[field];
}

function selectNodes(nodes, state, maxNodes) {
  const seen = new Set();
  const selected = [];
  for (const node of nodes) {
    if (!node || typeof node.uuid !== 'string' || !NODE_UUID_PATTERN.test(node.uuid)) {
      state.truncated = true;
      continue;
    }
    if (seen.has(node.uuid)) continue;
    seen.add(node.uuid);
    if (selected.length === maxNodes) { state.truncated = true; break; }
    selected.push({ uuid: node.uuid, path: boundedString(node.path, 1024, state) });
  }
  return selected;
}

function collectReference(value, context, state) {
  if (typeof value.__uuid__ !== 'string' || !ASSET_UUID_PATTERN.test(value.__uuid__)) {
    state.truncated = true;
    return;
  }
  const key = JSON.stringify([context.nodeUuid, context.componentIndex, context.path, value.__uuid__]);
  if (state.seenRefs.has(key)) return;
  if (state.refs.length === state.maxRefs) { state.truncated = true; state.full = true; return; }
  state.seenRefs.add(key);
  state.refs.push({
    nodeUuid: context.nodeUuid, nodePath: context.nodePath, componentName: context.componentName,
    propertyPath: context.path, assetUuid: value.__uuid__,
    expectedType: boundedString(value.__expectedType__, 256, state)
  });
}

function walkProperties(value, context, state) {
  if (state.full) return;
  if (context.depth > MAX_DEPTH || state.visited >= 250000) { state.truncated = true; return; }
  state.visited += 1;
  if (!value || typeof value !== 'object') return;
  if (Object.prototype.hasOwnProperty.call(value, '__id__')) return;
  if (Object.prototype.hasOwnProperty.call(value, '__uuid__')) return collectReference(value, context, state);
  const keys = Object.keys(value);
  if (keys.length > 64) state.truncated = true;
  for (const key of keys.slice(0, 64)) {
    const propertyPath = Array.isArray(value) ? `${context.path}[${key}]` : (context.path ? `${context.path}.${key}` : key);
    if (key.length > 128 || propertyPath.length > MAX_PROPERTY_PATH) { state.truncated = true; continue; }
    walkProperties(value[key], { ...context, path: propertyPath, depth: context.depth + 1 }, state);
    if (state.full) break;
  }
}

function scanNode(node, selected, state) {
  if (!Array.isArray(node.components)) throw new Error('Bridge node components are unavailable');
  state.scannedNodes += 1;
  state.truncated = state.truncated || node.componentsTruncated === true || node.components.length > 32;
  for (const [index, component] of node.components.slice(0, 32).entries()) {
    if (!component || !Object.prototype.hasOwnProperty.call(component, 'properties')) {
      throw new Error('Live component properties unavailable; reload the updated extension');
    }
    state.truncated = state.truncated || component.propertiesTruncated === true;
    walkProperties(component.properties, {
      nodeUuid: selected.uuid, nodePath: selected.path,
      componentName: boundedString(component.name, 256, state),
      componentIndex: Number.isInteger(component.index) ? component.index : index, path: '', depth: 0
    }, state);
    if (state.full) break;
  }
}

async function scanNodes(nodes, state) {
  for (let offset = 0; offset < nodes.length; offset += NODE_BATCH_SIZE) {
    const batch = nodes.slice(offset, offset + NODE_BATCH_SIZE);
    const returned = await requestData(state, '/scene/node', { uuids: batch.map((node) => node.uuid).join(',') }, 'nodes');
    const byUuid = new Map();
    for (const node of returned) {
      if (node && !byUuid.has(node.uuid)) byUuid.set(node.uuid, node);
    }
    for (const selected of batch) {
      const node = byUuid.get(selected.uuid);
      if (!node) { state.truncated = true; continue; }
      scanNode(node, selected, state);
      if (state.full) return;
    }
  }
}

async function findMissing(state) {
  const uniqueUuids = [...new Set(state.refs.map((ref) => ref.assetUuid))];
  const missingUuids = new Set();
  for (let offset = 0; offset < uniqueUuids.length; offset += ASSET_BATCH_SIZE) {
    const batch = uniqueUuids.slice(offset, offset + ASSET_BATCH_SIZE);
    const results = await requestData(state, '/asset/info', { uuids: batch.join(',') }, 'results');
    const statuses = new Map();
    for (const result of results) {
      if (!result || !batch.includes(result.uuid) || typeof result.exists !== 'boolean' || statuses.has(result.uuid)) {
        throw new Error('Bridge returned invalid asset-info results');
      }
      statuses.set(result.uuid, result.exists);
    }
    for (const uuid of batch) {
      if (!statuses.has(uuid)) throw new Error('Bridge returned incomplete asset-info results');
      if (!statuses.get(uuid)) missingUuids.add(uuid);
    }
  }
  return state.refs.filter((ref) => missingUuids.has(ref.assetUuid));
}

export async function handler(args, root) {
  const options = validate(args);
  const project = resolveInRoot(root, options.projectPath, 'projectPath');
  try {
    const state = {
      project, connection: readBridgeConnection(project), refs: [], seenRefs: new Set(),
      maxRefs: options.maxRefs, scannedNodes: 0, visited: 0, truncated: false, full: false
    };
    const params = options.rootUuid ? { rootUuid: options.rootUuid } : {};
    const tree = await requestData(state, '/scene/node-tree', params, 'nodes');
    const nodes = selectNodes(tree, state, options.maxNodes);
    await scanNodes(nodes, state);
    const missing = await findMissing(state);
    return { projectPath: project, scannedNodes: state.scannedNodes, scannedRefs: state.refs.length, missing, truncated: state.truncated };
  } catch (error) {
    const detail = error.code === 'ENOENT'
      ? `Load ${BRIDGE_EXTENSION} in this project's Extension Manager; discovery file is missing`
      : error.message;
    throw new ToolError(`Editor inspection unavailable: ${detail}`);
  }
}
