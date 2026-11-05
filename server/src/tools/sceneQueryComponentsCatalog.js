import { resolveSavedScene, componentScriptUuid } from '../savedScene.js';
import { readSceneAsArray } from '../sceneJson.js';
import { isNodeLikeEntry } from '../sceneTree.js';

const DEFAULT_MAX_RESULTS = 200;
const MAX_RESULTS = 1000;
const MAX_IDENTITY_TEXT = 256;
const MAX_NODE_PATH = 4096;

export const declaration = {
  name: 'scene_query_components_catalog',
  description:
    'Read a saved Cocos scene/prefab component catalog, ordered by serialized component type then node and component order. Identity strings/path segments are capped at 256 characters and node paths at 4096, with identityTruncated flags. Never dumps component payloads or opens, modifies, or saves a scene.',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string', description: 'Optional project directory inside the server root; scenePath is resolved relative to this directory.' },
      scenePath: { type: 'string', description: 'Saved .scene/.prefab path relative to projectPath (or server root), or an absolute path inside that scope.' },
      typeFilter: { type: 'string', description: 'Case-insensitive substring of the serialized component type.' },
      maxResults: { type: 'integer', default: DEFAULT_MAX_RESULTS, description: 'Maximum component references to return, clamped to 1..1000.' }
    },
    required: ['scenePath'],
    additionalProperties: false
  }
};

export function validate(args) {
  if (!args || typeof args.scenePath !== 'string' || !args.scenePath.trim()) {
    throw new Error('scenePath must be a non-empty string');
  }
  if (args.projectPath !== undefined && (typeof args.projectPath !== 'string' || !args.projectPath.trim())) {
    throw new Error('projectPath must be a non-empty string');
  }
  if (args.typeFilter !== undefined && typeof args.typeFilter !== 'string') {
    throw new Error('typeFilter must be a string');
  }
  if (args.maxResults !== undefined && (typeof args.maxResults !== 'number' || !isFinite(args.maxResults) || Math.floor(args.maxResults) !== args.maxResults)) {
    throw new Error('maxResults must be a finite integer');
  }
  return {
    projectPath: args.projectPath,
    scenePath: args.scenePath,
    typeFilter: args.typeFilter || '',
    maxResults: args.maxResults === undefined ? DEFAULT_MAX_RESULTS : Math.max(1, Math.min(MAX_RESULTS, args.maxResults))
  };
}

function visitComponents(entries, visitor) {
  entries.forEach((node, nodeIndex) => {
    if (!isNodeLikeEntry(node) || !Array.isArray(node._components)) return;
    node._components.forEach((ref, componentIndex) => {
      const entryIndex = ref && ref.__id__;
      if (typeof entryIndex !== 'number' || entryIndex < 0 || Math.floor(entryIndex) !== entryIndex) return;
      const component = entries[entryIndex];
      if (!component || isNodeLikeEntry(component) || typeof component.__type__ !== 'string' || !component.__type__) return;
      visitor(component, node, nodeIndex, componentIndex);
    });
  });
}

function countTypes(entries, typeFilter) {
  const counts = new Map();
  const filter = typeFilter.toLowerCase();
  let totalMatches = 0;
  visitComponents(entries, (component) => {
    const type = component.__type__;
    if (type.toLowerCase().indexOf(filter) === -1) return;
    counts.set(type, (counts.get(type) || 0) + 1);
    totalMatches += 1;
  });
  return { counts, totalMatches };
}

function createBuckets(counts, maxResults) {
  const buckets = new Map();
  let remaining = maxResults;
  Array.from(counts.keys()).sort().some((type) => {
    const limit = Math.min(counts.get(type), remaining);
    buckets.set(type, { limit, entries: [] });
    remaining -= limit;
    return remaining === 0;
  });
  return buckets;
}

function boundedIdentity(value) {
  return typeof value === 'string' ? value.slice(0, MAX_IDENTITY_TEXT) : null;
}

function boundedPathResolver(entries) {
  const cache = new Map();
  function resolvePath(index, depth = 0) {
    if (cache.has(index)) return cache.get(index);
    if (depth > 128) return { value: '(cycle?)', truncated: true };
    const entry = entries[index];
    const name = typeof entry._name === 'string' && entry._name ? entry._name :
      (entry.__type__ === 'cc.Scene' ? '(scene root)' : `#${index}`);
    const parentIndex = entry._parent && entry._parent.__id__;
    const parent = typeof parentIndex === 'number' && isNodeLikeEntry(entries[parentIndex]) ? resolvePath(parentIndex, depth + 1) : null;
    const value = (parent ? `${parent.value}/` : '') + boundedIdentity(name);
    const result = { value: value.slice(0, MAX_NODE_PATH), truncated: Boolean(parent && parent.truncated) || name.length > MAX_IDENTITY_TEXT || value.length > MAX_NODE_PATH };
    cache.set(index, result);
    return result;
  }
  return resolvePath;
}

function collectReferences(entries, buckets) {
  const resolvePath = boundedPathResolver(entries);
  visitComponents(entries, (component, node, nodeIndex, componentIndex) => {
    const type = component.__type__;
    const bucket = buckets.get(type);
    if (!bucket || bucket.entries.length >= bucket.limit) return;
    const nodePath = resolvePath(nodeIndex);
    const nodeUuid = boundedIdentity(node._id);
    const script = componentScriptUuid(component);
    bucket.entries.push({
      nodePath: nodePath.value,
      nodeUuid,
      componentIndex,
      type: boundedIdentity(type),
      scriptUuid: boundedIdentity(script),
      identityTruncated: nodePath.truncated || (typeof node._id === 'string' && nodeUuid !== node._id) ||
        type.length > MAX_IDENTITY_TEXT || (typeof script === 'string' && script.length > MAX_IDENTITY_TEXT)
    });
  });
  const references = [];
  buckets.forEach((bucket) => {
    bucket.entries.forEach((entry) => references.push(entry));
  });
  return references;
}

export async function handler(args, root) {
  const options = validate(args);
  const { scene } = resolveSavedScene(root, options);
  const parsed = readSceneAsArray(scene);
  if (!parsed.ok) {
    return { scenePath: options.scenePath, parsed: false, parseError: parsed.error, totalMatches: 0, returned: 0, truncated: false, entries: [] };
  }
  const matched = countTypes(parsed.entries, options.typeFilter);
  const buckets = createBuckets(matched.counts, options.maxResults);
  const entries = collectReferences(parsed.entries, buckets);
  return {
    scenePath: options.scenePath,
    parsed: true,
    totalMatches: matched.totalMatches,
    returned: entries.length,
    truncated: matched.totalMatches > entries.length,
    identityTruncated: entries.some((entry) => entry.identityTruncated),
    entries
  };
}
