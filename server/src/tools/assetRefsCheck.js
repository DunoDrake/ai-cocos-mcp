import path from 'node:path';
import { resolveInRoot } from '../root.js';
import { readSceneAsArray } from '../sceneJson.js';
import { ToolError } from '../errors.js';
import { findProjectScopeRoot, buildMetaIndex, isRefResolved, collectUuidRefs } from '../assetIndex.js';

const MAX_META_FILES = 8000;
const MAX_UNRESOLVED = 200;
const MAX_UNIQUE_REFS = 5000;

export const declaration = {
  name: 'asset_refs_check',
  description:
    'Inspect UUID-like asset references (__uuid__) in a scene/prefab and report refs that cannot be resolved through .meta files under the project root.',
  inputSchema: {
    type: 'object',
    properties: {
      scenePath: { type: 'string', description: 'Relative path to a .scene or .prefab JSON file.' }
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

export function handler({ scenePath }, root) {
  const abs = resolveInRoot(root, scenePath, 'scenePath');
  const parsed = readSceneAsArray(abs);
  if (!parsed.ok) {
    throw new ToolError(`cannot parse scenePath as JSON: ${parsed.error}`);
  }

  const scopeRoot = findProjectScopeRoot(root, path.dirname(abs));
  const index = buildMetaIndex(root, scopeRoot, { maxFiles: MAX_META_FILES });
  const { refCounts, truncated: refsTruncated } = collectUuidRefs(parsed.entries);

  const uniqueRefs = [...refCounts.keys()];
  const boundedRefs = uniqueRefs.slice(0, MAX_UNIQUE_REFS);
  const unresolved = [];
  let resolvedCount = 0;
  for (const ref of boundedRefs) {
    if (isRefResolved(ref, index)) {
      resolvedCount += 1;
    } else if (unresolved.length < MAX_UNRESOLVED) {
      unresolved.push({ ref, occurrences: refCounts.get(ref) });
    }
  }

  return {
    scenePath,
    projectScope: path.relative(root, scopeRoot) || '.',
    metaFilesScanned: index.filesScanned,
    metaScanTruncated: index.truncated,
    totalUniqueRefs: uniqueRefs.length,
    refsSampledForCheck: boundedRefs.length,
    refsTruncated: refsTruncated || uniqueRefs.length > MAX_UNIQUE_REFS,
    resolvedCount,
    unresolvedCount: boundedRefs.length - resolvedCount,
    unresolved,
    unresolvedTruncated: unresolved.length >= MAX_UNRESOLVED
  };
}
