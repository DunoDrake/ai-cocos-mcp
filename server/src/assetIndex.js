import fs from 'node:fs';
import path from 'node:path';
import { walkFiles } from './fsWalk.js';
import { compressUuid } from './uuid.js';

const DEFAULT_MAX_META_FILES = 8000;

// Shared by asset_refs_check, the component/script metadata index, and the
// dashboard scene-tree builder: given a start directory, walk upward to the
// nearest ancestor that looks like a Cocos project root (package.json +
// sibling assets/), so uuid resolution is scoped to the owning project
// instead of the whole (possibly multi-project) repo root.
export function findProjectScopeRoot(root, startDir) {
  let dir = startDir;
  for (let i = 0; i < 12; i += 1) {
    const hasPackage = fs.existsSync(path.join(dir, 'package.json'));
    const assetsDir = path.join(dir, 'assets');
    if (hasPackage && fs.existsSync(assetsDir) && fs.statSync(assetsDir).isDirectory()) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return root;
}

function indexSubMetas(meta, canonicalIndex, compressedIndex, metaFile) {
  if (!meta.subMetas || typeof meta.subMetas !== 'object') return;
  for (const subUuid of Object.values(meta.subMetas)) {
    if (typeof subUuid !== 'string') continue;
    canonicalIndex.set(subUuid.replace(/-/g, '').toLowerCase(), metaFile);
    const compressed = compressUuid(subUuid);
    if (compressed) compressedIndex.set(compressed, metaFile);
  }
}

// Indexes every `.meta` file under `scopeDir/assets` (or `scopeDir` itself if
// it has no `assets` child) by both the canonical uuid (hyphens stripped,
// lowercased) and the Cocos-compressed form, mapped to the absolute path of
// the asset the `.meta` file describes (i.e. the `.meta` path with the
// trailing `.meta` suffix removed) is available to callers via
// `metaFileToAssetPath`; the index itself stores the `.meta` file path so
// callers can inspect importer/subMetas metadata when needed.
export function buildMetaIndex(root, scopeDir, options = {}) {
  const maxFiles = options.maxFiles || DEFAULT_MAX_META_FILES;
  const assetsDir = fs.existsSync(path.join(scopeDir, 'assets')) ? path.join(scopeDir, 'assets') : scopeDir;
  const { files, truncated } = walkFiles(root, assetsDir, {
    extensions: ['.meta'],
    maxDepth: 30,
    maxFiles,
    maxVisitedDirs: maxFiles
  });
  const canonicalIndex = new Map();
  const compressedIndex = new Map();
  for (const file of files) {
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (!meta || typeof meta.uuid !== 'string') continue;
    canonicalIndex.set(meta.uuid.replace(/-/g, '').toLowerCase(), file);
    const compressed = compressUuid(meta.uuid);
    if (compressed) compressedIndex.set(compressed, file);
    indexSubMetas(meta, canonicalIndex, compressedIndex, file);
  }
  return { canonicalIndex, compressedIndex, filesScanned: files.length, truncated };
}

export function metaFileToAssetPath(metaFile) {
  return metaFile.endsWith('.meta') ? metaFile.slice(0, -'.meta'.length) : metaFile;
}

export function isRefResolved(ref, index) {
  const [mainPart] = ref.split('@');
  if (index.compressedIndex.has(mainPart)) return true;
  return index.canonicalIndex.has(mainPart.replace(/-/g, '').toLowerCase());
}

// Whole-scene-array uuid ref scan used by asset_refs_check for its summary
// counts; kept here so the scene-tree builder's top-level asset summary uses
// the exact same walk semantics instead of a second, slightly different one.
export function collectUuidRefs(entries, options = {}) {
  const maxVisited = options.maxVisited || 200000;
  const refCounts = new Map();
  const stack = [...entries];
  let visited = 0;
  while (stack.length > 0 && visited < maxVisited) {
    const node = stack.pop();
    visited += 1;
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
      continue;
    }
    if (!node || typeof node !== 'object') continue;
    if (typeof node.__uuid__ === 'string') {
      refCounts.set(node.__uuid__, (refCounts.get(node.__uuid__) || 0) + 1);
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') stack.push(value);
    }
  }
  return { refCounts, truncated: visited >= maxVisited };
}
