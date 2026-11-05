import path from 'node:path';
import { resolveSavedScene, componentScriptUuid } from '../savedScene.js';
import { ToolError } from '../errors.js';
import { readSceneAsArray } from '../sceneJson.js';
import { buildPathResolver, isNodeLikeEntry } from '../sceneTree.js';

const MAX_FIELDS = 32;
const MAX_TEXT = 256;
const OMITTED_FIELDS = ['__type__', '_enabled', '_id', 'node', '_node', '_script', '__prefab'];

export const declaration = {
  name: 'scene_query_node_components',
  description:
    'Read bounded serialized component summaries for exactly one node in a saved .scene/.prefab. Select by exact nodePath or nodeUuid, not both. Scalars only: at most 32 fields per component and 256 characters per value. Never opens the Editor or modifies files.',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string', description: 'Project directory inside the server root; defaults to the server root.' },
      scenePath: { type: 'string', description: 'Saved .scene/.prefab path relative to projectPath, or absolute inside it.' },
      nodePath: { type: 'string', description: 'Exact serialized hierarchy path, including the scene root name.' },
      nodeUuid: { type: 'string', description: 'Exact serialized node _id.' },
      maxComponents: { type: 'integer', description: 'Default 50; clamped to 1..200.' }
    },
    required: ['scenePath'],
    oneOf: [{ required: ['nodePath'] }, { required: ['nodeUuid'] }]
  }
};

export function validate(args) {
  if (!args || typeof args.scenePath !== 'string' || !args.scenePath.trim()) {
    throw new Error('scenePath must be a non-empty string');
  }
  const hasPath = args.nodePath !== undefined;
  const hasUuid = args.nodeUuid !== undefined;
  if (hasPath === hasUuid) throw new Error('Exactly one of nodePath or nodeUuid is required');
  const selector = hasPath ? 'nodePath' : 'nodeUuid';
  if (typeof args[selector] !== 'string' || !args[selector].trim()) {
    throw new Error(`${selector} must be a non-empty string`);
  }
  if (args.projectPath !== undefined && (typeof args.projectPath !== 'string' || !args.projectPath.trim())) {
    throw new Error('projectPath must be a non-empty string');
  }
  let maxComponents = 50;
  if (args.maxComponents !== undefined) {
    if (typeof args.maxComponents !== 'number' || !isFinite(args.maxComponents) || Math.floor(args.maxComponents) !== args.maxComponents) {
      throw new Error('maxComponents must be a finite integer');
    }
    maxComponents = Math.max(1, Math.min(200, args.maxComponents));
  }
  return { projectPath: args.projectPath, scenePath: args.scenePath, nodePath: args.nodePath, nodeUuid: args.nodeUuid, maxComponents };
}

function findNode(entries, args) {
  const resolvePath = buildPathResolver(entries);
  let match = null;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!isNodeLikeEntry(entry)) continue;
    const matches = args.nodePath !== undefined ? resolvePath(index, 0) === args.nodePath : entry._id === args.nodeUuid;
    if (!matches) continue;
    if (match) throw new ToolError('Ambiguous node selector: multiple nodes match; use a unique nodePath or nodeUuid');
    match = { index, entry, path: resolvePath(index, 0) };
  }
  if (!match) throw new ToolError('Node not found: no serialized node matches the exact nodePath or nodeUuid');
  return match;
}

function boundedText(value, limit = MAX_TEXT) {
  return typeof value === 'string' ? value.slice(0, limit) : null;
}

function summarizeFields(entry) {
  const fields = Object.create(null);
  let included = 0;
  let omittedFieldCount = 0;
  let fieldsTruncated = false;
  for (const key of Object.keys(entry).sort()) {
    if (OMITTED_FIELDS.indexOf(key) !== -1) continue;
    const value = entry[key];
    const scalar = value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
    if (!scalar || key.length > 128 || included >= MAX_FIELDS) {
      omittedFieldCount += 1;
      continue;
    }
    fields[key] = typeof value === 'string' ? boundedText(value) : value;
    if (typeof value === 'string' && value.length > MAX_TEXT) fieldsTruncated = true;
    included += 1;
  }
  return { fields, omittedFieldCount, fieldsTruncated: fieldsTruncated || omittedFieldCount > 0 };
}

function summarizeComponent(entry, index, entryIndex) {
  const type = boundedText(entry.__type__);
  const script = componentScriptUuid(entry);
  const scriptUuid = boundedText(script);
  const summary = summarizeFields(entry);
  return {
    index,
    entryIndex,
    type,
    scriptUuid,
    enabled: entry._enabled !== false,
    fields: summary.fields,
    omittedFieldCount: summary.omittedFieldCount,
    fieldsTruncated: summary.fieldsTruncated,
    metadataTruncated: entry.__type__.length > MAX_TEXT || (typeof script === 'string' && script.length > MAX_TEXT)
  };
}

function readComponents(entries, node, maxComponents) {
  const refs = Array.isArray(node._components) ? node._components : [];
  const components = [];
  for (let index = 0; index < refs.length; index += 1) {
    const entryIndex = refs[index] && refs[index].__id__;
    const entry = typeof entryIndex === 'number' && Math.floor(entryIndex) === entryIndex ? entries[entryIndex] : null;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.__type__ !== 'string' || isNodeLikeEntry(entry)) {
      throw new ToolError(`Invalid serialized component reference at node component index ${index}`);
    }
    if (components.length < maxComponents) components.push(summarizeComponent(entry, index, entryIndex));
  }
  return { count: refs.length, truncated: refs.length > maxComponents, components };
}

export async function handler(args, root) {
  const options = validate(args);
  const { project, scene } = resolveSavedScene(root, options);
  const parsed = readSceneAsArray(scene);
  if (!parsed.ok) throw new ToolError(`Cannot parse scenePath: ${parsed.error}`);
  const match = findNode(parsed.entries, options);
  const summary = readComponents(parsed.entries, match.entry, options.maxComponents);
  const nodeName = match.entry._name || (match.entry.__type__ === 'cc.Scene' ? '(scene root)' : null);
  return {
    scenePath: path.relative(project, scene),
    node: {
      index: match.index,
      name: boundedText(nodeName),
      path: boundedText(match.path, 4096),
      nodeUuid: boundedText(match.entry._id),
      identityTruncated: match.path.length > 4096 || (typeof nodeName === 'string' && nodeName.length > MAX_TEXT) ||
        (typeof match.entry._id === 'string' && match.entry._id.length > MAX_TEXT)
    },
    count: summary.count,
    truncated: summary.truncated,
    components: summary.components
  };
}
