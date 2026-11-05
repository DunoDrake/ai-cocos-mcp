import { resolveInRoot } from '../root.js';
import { readSceneAsArray } from '../sceneJson.js';

const MAX_NODES = 200;
const MAX_COMPONENT_TYPES = 30;

export const declaration = {
  name: 'scene_inspect',
  description:
    'Parse a Cocos .scene/.prefab JSON file (array or object root) and return bounded node/component counts, node names/paths, and parse errors. No full dump.',
  inputSchema: {
    type: 'object',
    properties: {
      scenePath: { type: 'string', description: 'Relative path to a .scene or .prefab file.' }
    },
    required: ['scenePath']
  }
};

export function validate(args) {
  if (!args || typeof args.scenePath !== 'string' || args.scenePath.length === 0) {
    throw new Error('scenePath is required and must be a non-empty string');
  }
  return { scenePath: args.scenePath };
}

function analyzeScene(entries) {
  const nodeIndices = [];
  entries.forEach((entry, idx) => {
    if (entry && entry.__type__ === 'cc.Node') nodeIndices.push(idx);
  });

  const pathCache = new Map();
  function resolvePath(idx, guardDepth) {
    if (pathCache.has(idx)) return pathCache.get(idx);
    if (guardDepth > 64) return '(cycle?)';
    const entry = entries[idx];
    const name = (entry && entry._name) || `#${idx}`;
    const parentRef = entry && entry._parent && entry._parent.__id__;
    const parentIsNode = typeof parentRef === 'number' && entries[parentRef] && entries[parentRef].__type__ === 'cc.Node';
    const result = parentIsNode ? `${resolvePath(parentRef, guardDepth + 1)}/${name}` : name;
    pathCache.set(idx, result);
    return result;
  }

  const componentTypeCounts = new Map();
  let totalComponents = 0;
  for (const idx of nodeIndices) {
    const components = Array.isArray(entries[idx]._components) ? entries[idx]._components : [];
    for (const ref of components) {
      const refId = ref && ref.__id__;
      if (typeof refId !== 'number') continue;
      const type = (entries[refId] && entries[refId].__type__) || 'unknown';
      componentTypeCounts.set(type, (componentTypeCounts.get(type) || 0) + 1);
      totalComponents += 1;
    }
  }

  return { nodeIndices, resolvePath, componentTypeCounts, totalComponents };
}

export function handler({ scenePath }, root) {
  const abs = resolveInRoot(root, scenePath, 'scenePath');
  const parsed = readSceneAsArray(abs);
  if (!parsed.ok) {
    return { scenePath, parsed: false, parseError: parsed.error };
  }

  const { nodeIndices, resolvePath, componentTypeCounts, totalComponents } = analyzeScene(parsed.entries);
  const nodes = nodeIndices.slice(0, MAX_NODES).map((idx) => ({
    name: parsed.entries[idx]._name || null,
    path: resolvePath(idx, 0)
  }));
  const componentsByType = [...componentTypeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_COMPONENT_TYPES)
    .map(([type, count]) => ({ type, count }));

  return {
    scenePath,
    parsed: true,
    totalEntries: parsed.entries.length,
    nodeCount: nodeIndices.length,
    totalComponents,
    distinctComponentTypes: componentTypeCounts.size,
    componentsByType,
    nodes,
    nodesTruncated: nodeIndices.length > MAX_NODES
  };
}
