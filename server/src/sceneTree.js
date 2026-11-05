import path from 'node:path';
import { resolveInRoot } from './root.js';
import { readSceneAsArray } from './sceneJson.js';
import { findProjectScopeRoot, buildMetaIndex, isRefResolved } from './assetIndex.js';
import { createScriptCache, resolveComponentMetadata } from './scriptIndex.js';

const MAX_NODES = 2000;
const MAX_COMPONENTS_PER_NODE = 20;
const MAX_ASSET_REFS_PER_NODE = 20;
const MAX_SCRIPT_METADATA_RECORDS = 1000;
const MAX_ASSET_WALK_DEPTH = 8;
const MAX_META_FILES = 8000;

const UI_EXPECTED_TYPES = new Set(['cc.SpriteFrame', 'cc.BitmapFont', 'sp.SkeletonData', 'cc.Prefab', 'cc.JsonAsset', 'cc.AnimationClip']);
const UI_FIELD_PREFIXES = ['_spriteFrame', '_normalSprite', '_hoverSprite', '_pressedSprite', '_disabledSprite', '_font', '_skeletonData'];

export function isNodeLikeEntry(entry) {
  return Boolean(entry) && (entry.__type__ === 'cc.Node' || entry.__type__ === 'cc.Scene');
}

function categorizeAssetRef(fieldPath, expectedType) {
  if (expectedType && UI_EXPECTED_TYPES.has(expectedType)) return 'ui';
  const lastSegment = fieldPath.split('.').pop() || '';
  if (UI_FIELD_PREFIXES.some((prefix) => lastSegment.startsWith(prefix))) return 'ui';
  return 'other';
}

// Walks a single component's own serialized fields (never following
// `{__id__}` references, which point at unrelated sibling entries in the
// flat scene array) collecting `{__uuid__, __expectedType__}` leaves with a
// dotted field path, bounded per component so one asset-heavy component
// (e.g. a texture atlas swap list) cannot blow up the response.
function collectComponentAssetRefs(componentEntry, index, maxRefs) {
  const refs = [];
  const seen = new Set();
  const stack = [{ value: componentEntry, prefix: '', depth: 0 }];
  while (stack.length > 0 && refs.length <= maxRefs) {
    const { value, prefix, depth } = stack.pop();
    if (!value || typeof value !== 'object' || depth > MAX_ASSET_WALK_DEPTH) continue;
    if (typeof value.__uuid__ === 'string') {
      const key = `${prefix}\u0000${value.__uuid__}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({
        field: prefix,
        uuid: value.__uuid__,
        expectedType: value.__expectedType__ || null,
        category: categorizeAssetRef(prefix, value.__expectedType__),
        resolved: isRefResolved(value.__uuid__, index)
      });
      continue;
    }
    if ('__id__' in value) continue;
    if (Array.isArray(value)) {
      value.forEach((item, i) => stack.push({ value: item, prefix: prefix ? `${prefix}[${i}]` : `[${i}]`, depth: depth + 1 }));
      continue;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === 'node' || key === '__prefab' || key.startsWith('__')) continue;
      stack.push({ value: child, prefix: prefix ? `${prefix}.${key}` : key, depth: depth + 1 });
    }
  }
  return { refs: refs.slice(0, maxRefs), truncated: refs.length > maxRefs };
}

export function buildPathResolver(entries) {
  const cache = new Map();
  function resolvePath(idx, guardDepth) {
    if (cache.has(idx)) return cache.get(idx);
    if (guardDepth > 128) return '(cycle?)';
    const entry = entries[idx];
    const name = (entry && entry._name) || (entry && entry.__type__ === 'cc.Scene' ? '(scene root)' : `#${idx}`);
    const parentRef = entry && entry._parent && entry._parent.__id__;
    const parentIsNode = typeof parentRef === 'number' && isNodeLikeEntry(entries[parentRef]);
    const result = parentIsNode ? `${resolvePath(parentRef, guardDepth + 1)}/${name}` : name;
    cache.set(idx, result);
    return result;
  }
  return resolvePath;
}

function findNodeUiTransform(entries, componentRefs) {
  for (const ref of componentRefs) {
    if (!ref || typeof ref.__id__ !== 'number') continue;
    const comp = entries[ref.__id__];
    if (comp && comp.__type__ === 'cc.UITransform') return comp;
  }
  return null;
}

function vec3ToPlain(vec) {
  return vec ? { x: vec.x || 0, y: vec.y || 0, z: vec.z || 0 } : null;
}

// `ctx` bundles the read-only structures shared across every node/component
// visited during one buildSceneTree call: the flat scene entries, the
// project uuid index, the script-metadata cache, the project root, and the
// running asset-ref counters mutated as refs are discovered.
function buildComponentSummary(ctx, componentRef) {
  const idx = componentRef.__id__;
  const entry = ctx.entries[idx];
  const metadata = resolveComponentMetadata(ctx.scriptCache, ctx.root, ctx.index, entry.__type__, MAX_SCRIPT_METADATA_RECORDS);
  const { refs, truncated } = collectComponentAssetRefs(entry, ctx.index, MAX_ASSET_REFS_PER_NODE);
  ctx.counters.totalAssetRefs += refs.length;
  ctx.counters.uiAssetRefs += refs.filter((ref) => ref.category === 'ui').length;
  ctx.counters.unresolvedAssetRefs += refs.filter((ref) => !ref.resolved).length;
  if (truncated) ctx.counters.assetRefsTruncated = true;
  return {
    id: idx,
    type: entry.__type__,
    uuid: entry._id || null,
    scriptPath: metadata.scriptPath,
    className: metadata.className,
    isSlotbase: metadata.isSlotbase,
    slotbaseEvidence: metadata.evidence,
    resolved: metadata.resolved,
    enabled: entry._enabled !== false,
    assetRefs: refs,
    assetRefsTruncated: truncated
  };
}

function collectNodeAssetRefs(components) {
  const assetRefs = [];
  const seen = new Set();
  for (const component of components) {
    for (const ref of component.assetRefs) {
      const key = `${component.id}\u0000${ref.field}\u0000${ref.uuid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      assetRefs.push(ref);
    }
  }
  return assetRefs;
}

function buildNodeSummary(ctx, idx) {
  const entry = ctx.entries[idx];
  const componentRefs = Array.isArray(entry._components) ? entry._components : [];
  const validComponentRefs = componentRefs.filter((ref) => {
    return ref && typeof ref.__id__ === 'number' && ctx.entries[ref.__id__];
  });
  const components = validComponentRefs.slice(0, MAX_COMPONENTS_PER_NODE).map((ref) => buildComponentSummary(ctx, ref));
  const uiTransform = findNodeUiTransform(ctx.entries, validComponentRefs);
  const parentRef = entry._parent && typeof entry._parent.__id__ === 'number' ? entry._parent.__id__ : null;
  const parentId = parentRef !== null && isNodeLikeEntry(ctx.entries[parentRef]) ? parentRef : null;
  const childIds = (Array.isArray(entry._children) ? entry._children : [])
    .map((ref) => ref && ref.__id__)
    .filter((childId) => typeof childId === 'number' && isNodeLikeEntry(ctx.entries[childId]));
  const assetRefs = collectNodeAssetRefs(components);

  return {
    id: idx,
    nodeUuid: entry._id || null,
    name: entry._name || (entry.__type__ === 'cc.Scene' ? '(scene root)' : null),
    path: ctx.resolvePath(idx, 0),
    parentId,
    childIds,
    childrenCount: childIds.length,
    active: entry._active !== false,
    position: vec3ToPlain(entry._lpos),
    size: uiTransform ? { width: uiTransform._contentSize.width, height: uiTransform._contentSize.height } : null,
    components,
    componentsCount: componentRefs.length,
    componentsTruncated: componentRefs.length > MAX_COMPONENTS_PER_NODE,
    assetRefs: assetRefs.slice(0, MAX_ASSET_REFS_PER_NODE),
    assetRefsTruncated: assetRefs.length > MAX_ASSET_REFS_PER_NODE || components.some((component) => component.assetRefsTruncated)
  };
}

function summarizeComponentMetadata(scriptCache) {
  const records = [...scriptCache.metadata.values()];
  const resolved = records.filter((record) => record.resolved).length;
  return {
    scanned: records.length,
    resolved,
    unresolved: records.length - resolved,
    truncated: records.some((record) => record.capped)
  };
}

function countTotalComponents(entries, nodeIndices) {
  let total = 0;
  for (const idx of nodeIndices) {
    total += Array.isArray(entries[idx]._components) ? entries[idx]._components.length : 0;
  }
  return total;
}

export function buildSceneTree(root, scenePath) {
  const abs = resolveInRoot(root, scenePath, 'scenePath');
  const parsed = readSceneAsArray(abs);
  if (!parsed.ok) {
    return { ok: false, scenePath, parseError: parsed.error };
  }

  const entries = parsed.entries;
  const nodeIndices = [];
  entries.forEach((entry, idx) => {
    if (isNodeLikeEntry(entry)) nodeIndices.push(idx);
  });
  const scopeRoot = findProjectScopeRoot(root, path.dirname(abs));
  const ctx = {
    entries,
    root,
    index: buildMetaIndex(root, scopeRoot, { maxFiles: MAX_META_FILES }),
    scriptCache: createScriptCache(),
    resolvePath: buildPathResolver(entries),
    counters: { totalAssetRefs: 0, uiAssetRefs: 0, unresolvedAssetRefs: 0, assetRefsTruncated: false }
  };

  const boundedNodeIndices = nodeIndices.slice(0, MAX_NODES);
  const nodes = boundedNodeIndices.map((idx) => buildNodeSummary(ctx, idx));
  const roots = nodes.filter((node) => node.parentId === null).map((node) => node.id);
  const distinctComponentTypes = new Set();
  for (const node of nodes) {
    for (const component of node.components) distinctComponentTypes.add(component.type);
  }

  return {
    ok: true,
    scene: {
      path: scenePath,
      totalEntries: entries.length,
      nodeCount: nodeIndices.length,
      totalComponents: countTotalComponents(entries, nodeIndices),
      distinctComponentTypes: distinctComponentTypes.size,
      projectScope: path.relative(root, scopeRoot) || '.'
    },
    roots,
    nodes,
    nodesTruncated: nodeIndices.length > MAX_NODES,
    componentMetadata: summarizeComponentMetadata(ctx.scriptCache),
    assetRefs: {
      total: ctx.counters.totalAssetRefs,
      uiAssets: ctx.counters.uiAssetRefs,
      unresolved: ctx.counters.unresolvedAssetRefs,
      truncated: ctx.counters.assetRefsTruncated
    }
  };
}
