import fs from 'node:fs';
import path from 'node:path';
import { resolveInRoot } from './root.js';
import { metaFileToAssetPath } from './assetIndex.js';

const SCRIPT_META_SUFFIXES = ['.ts.meta', '.tsx.meta', '.js.meta', '.jsx.meta'];
const SLOTBASE_CLASS_NAME = 'SlotBaseModule';
const CLASS_EXTENDS_PATTERN = /\bclass\s+[A-Za-z0-9_$]+\s+extends\s+([A-Za-z0-9_$.]+)/;
const CCCLASS_NAME_PATTERN = /@ccclass\(\s*['"]([^'"]+)['"]\s*\)/;
const IMPORT_NAMED_PATTERN = /import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;

function scriptMetaSuffix(metaFile) {
  return SCRIPT_META_SUFFIXES.find((suffix) => metaFile.endsWith(suffix)) || null;
}

// One resolution cache per sceneTree build: source text, parsed class info,
// and re-exporting "barrel" (`export * from '...'`) name -> file maps are
// each expensive only once, and the same raw component `__type__` recurs
// for every instance of a symbol/button/etc. in the scene.
export function createScriptCache() {
  return { source: new Map(), classInfo: new Map(), barrelMap: new Map(), metadata: new Map() };
}

function readSourceCached(cache, absPath) {
  if (cache.source.has(absPath)) return cache.source.get(absPath);
  let text = null;
  try {
    text = fs.readFileSync(absPath, 'utf8');
  } catch {
    text = null;
  }
  cache.source.set(absPath, text);
  return text;
}

function parseClassInfo(cache, absPath) {
  if (cache.classInfo.has(absPath)) return cache.classInfo.get(absPath);
  const source = readSourceCached(cache, absPath);
  const info = { className: null, extendsTarget: null, importSource: new Map() };
  if (source) {
    const classNameMatch = CCCLASS_NAME_PATTERN.exec(source);
    if (classNameMatch) info.className = classNameMatch[1];
    const extendsMatch = CLASS_EXTENDS_PATTERN.exec(source);
    if (extendsMatch) info.extendsTarget = extendsMatch[1];
    let importMatch;
    while ((importMatch = IMPORT_NAMED_PATTERN.exec(source))) {
      const specifier = importMatch[2];
      for (const rawName of importMatch[1].split(',')) {
        const name = rawName.trim().split(/\s+as\s+/)[0].trim();
        if (name) info.importSource.set(name, specifier);
      }
    }
  }
  cache.classInfo.set(absPath, info);
  return info;
}

function resolveModuleSpecifier(root, fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      try {
        return resolveInRoot(root, candidate, 'scriptImport');
      } catch {
        return null;
      }
    }
  }
  return null;
}

// A barrel file (this repo's convention: `SlotModuleExport.ts`) re-exports
// every module class via `export * from "<relative path>"` without ever
// defining a class itself, so an imported name resolved to that file has to
// be looked up again by matching the barrel line's path basename.
function buildBarrelMap(cache, root, barrelAbsPath) {
  if (cache.barrelMap.has(barrelAbsPath)) return cache.barrelMap.get(barrelAbsPath);
  const source = readSourceCached(cache, barrelAbsPath) || '';
  const map = new Map();
  const lineRegex = /export\s*\*\s*from\s*["']([^"']+)["']/g;
  let match;
  while ((match = lineRegex.exec(source))) {
    const resolved = resolveModuleSpecifier(root, barrelAbsPath, match[1]);
    if (resolved) map.set(path.basename(match[1]), resolved);
  }
  cache.barrelMap.set(barrelAbsPath, map);
  return map;
}

function resolveHopTarget(cache, root, fromFile, importedName) {
  const info = parseClassInfo(cache, fromFile);
  const specifier = info.importSource.get(importedName);
  if (!specifier) return null;
  const resolved = resolveModuleSpecifier(root, fromFile, specifier);
  if (!resolved) return null;
  if (path.basename(resolved).replace(/\.(ts|tsx|js|jsx)$/, '') === 'SlotModuleExport') {
    return buildBarrelMap(cache, root, resolved).get(importedName) || null;
  }
  return resolved;
}

// Bounded (max two hops) evidence-based Slotbase classification: true only
// when the component's own class extends SlotBaseModule directly, or its
// immediate parent class (resolved through at most one import, including
// through the SlotModuleExport barrel) extends SlotBaseModule. Deeper
// ancestry is out of scope and reported as unresolved evidence rather than
// guessed.
function classifySlotbase(cache, root, scriptAbsPath) {
  const info = parseClassInfo(cache, scriptAbsPath);
  if (!info.extendsTarget) return { isSlotbase: false, evidence: null };
  if (info.extendsTarget === SLOTBASE_CLASS_NAME) {
    return { isSlotbase: true, evidence: `extends ${SLOTBASE_CLASS_NAME} directly` };
  }
  const hopFile = resolveHopTarget(cache, root, scriptAbsPath, info.extendsTarget);
  if (!hopFile) return { isSlotbase: false, evidence: null };
  const hopInfo = parseClassInfo(cache, hopFile);
  if (hopInfo.extendsTarget === SLOTBASE_CLASS_NAME) {
    return { isSlotbase: true, evidence: `extends ${info.extendsTarget}, which extends ${SLOTBASE_CLASS_NAME}` };
  }
  return { isSlotbase: false, evidence: null };
}

function builtinMetadata(rawType) {
  return {
    type: rawType,
    resolved: true,
    builtin: true,
    scriptPath: null,
    className: rawType.replace(/^(cc|sp)\./, ''),
    isSlotbase: false,
    evidence: null
  };
}

// Resolves one raw component `__type__` value (a builtin `cc.*`/`sp.*` name,
// or a Cocos-compressed script uuid) to script/class metadata, bounded by
// `maxRecords` distinct custom types per scene-tree build and reusing the
// scene's own uuid `metaIndex` (asset_refs_check builds the identical index)
// so no separate filesystem walk is needed for script resolution.
export function resolveComponentMetadata(cache, root, metaIndex, rawType, maxRecords) {
  if (rawType.startsWith('cc.') || rawType.startsWith('sp.')) return builtinMetadata(rawType);
  if (cache.metadata.has(rawType)) return cache.metadata.get(rawType);
  if (cache.metadata.size >= maxRecords) {
    return { type: rawType, resolved: false, builtin: false, scriptPath: null, className: null, isSlotbase: false, evidence: null, capped: true };
  }
  const metaFile = metaIndex.compressedIndex.get(rawType) || metaIndex.canonicalIndex.get(rawType.replace(/-/g, '').toLowerCase());
  const suffix = metaFile ? scriptMetaSuffix(metaFile) : null;
  let result;
  if (!metaFile || !suffix) {
    result = { type: rawType, resolved: false, builtin: false, scriptPath: null, className: null, isSlotbase: false, evidence: null };
  } else {
    const scriptAbsPath = metaFileToAssetPath(metaFile);
    const info = parseClassInfo(cache, scriptAbsPath);
    const slotbase = classifySlotbase(cache, root, scriptAbsPath);
    result = {
      type: rawType,
      resolved: true,
      builtin: false,
      scriptPath: path.relative(root, scriptAbsPath),
      className: info.className,
      isSlotbase: slotbase.isSlotbase,
      evidence: slotbase.evidence
    };
  }
  cache.metadata.set(rawType, result);
  return result;
}
