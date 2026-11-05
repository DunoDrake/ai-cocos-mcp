import fs from 'node:fs';
import path from 'node:path';
import { resolveInRoot } from '../root.js';
import { maskSourceLines } from '../sourceMask.js';

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];
const TRIPLE_SUFFIX_PATTERN = /^(.*?)(Module|Data|Config)(\d*)$/;
const MAX_GROUPS = 10;

export const declaration = {
  name: 'module_triple_check',
  description:
    'Inspect a Module/Data/Config file group for the repo naming pattern and onDestroy cleanup calls (targetOff, releaseAll), reporting evidence without modifying files.',
  inputSchema: {
    type: 'object',
    properties: {
      modulePath: { type: 'string', description: 'Relative path to a *Module.ts file or its containing directory.' }
    },
    required: ['modulePath']
  }
};

export function validate(args) {
  if (!args || typeof args.modulePath !== 'string' || args.modulePath.length === 0) {
    throw new Error('modulePath is required and must be a non-empty string');
  }
  return { modulePath: args.modulePath };
}

function parseTripleName(filename) {
  const ext = path.extname(filename);
  const base = filename.slice(0, filename.length - ext.length);
  const match = TRIPLE_SUFFIX_PATTERN.exec(base);
  if (!match) return null;
  return { baseName: match[1], kind: match[2], digits: match[3] || '' };
}

function groupDirectoryFiles(dir) {
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext)));
  const groups = new Map();
  for (const entry of entries) {
    const parsed = parseTripleName(entry.name);
    if (!parsed) continue;
    const key = `${parsed.baseName}::${parsed.digits}`;
    if (!groups.has(key)) groups.set(key, {});
    groups.get(key)[parsed.kind] = entry.name;
  }
  return groups;
}

function extractLine(text, regex) {
  const idx = text.search(regex);
  if (idx === -1) return null;
  const lineStart = text.lastIndexOf('\n', idx) + 1;
  const lineEndIdx = text.indexOf('\n', idx);
  const lineEnd = lineEndIdx === -1 ? text.length : lineEndIdx;
  return text.slice(lineStart, lineEnd).trim().slice(0, 160);
}

// Matches a real `onDestroy(...)` method declaration immediately followed by
// its body's opening brace (optionally through a TS return-type annotation),
// evaluated against masked source so a comment/string occurrence (e.g. a
// JSDoc mentioning "onDestroy()") never counts as a real declaration. The
// leading `[^.\w]` alternative excludes call sites like `foo.onDestroy()`.
const ON_DESTROY_DECLARATION_PATTERN = /(^|[^.\w])onDestroy\s*\([^)]*\)\s*(?::\s*[^{;]+)?\{/;

function findOnDestroyBody(source) {
  const masked = maskSourceLines(source).maskedLines.join('\n');
  const match = ON_DESTROY_DECLARATION_PATTERN.exec(masked);
  if (!match) return null;
  const braceStart = match.index + match[0].length - 1;
  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = end === -1 ? source.slice(braceStart) : source.slice(braceStart, end + 1);
  return { body, bodyParsed: end !== -1 };
}

function analyzeOnDestroy(source) {
  const found = findOnDestroyBody(source);
  if (!found) {
    return { methodFound: false, targetOff: false, releaseAll: false, superCall: false, evidence: [], missing: ['onDestroy() method'] };
  }
  const body = found.body || '';
  const targetOff = /targetOff\s*\(\s*this\s*\)/.test(body);
  const releaseAll = /releaseAll\s*\(/.test(body);
  const superCall = /super\.onDestroy\s*\(/.test(body);
  const evidence = [targetOff, releaseAll, superCall]
    .map((present, i) => (present ? extractLine(body, [/targetOff\s*\(\s*this\s*\)/, /releaseAll\s*\(/, /super\.onDestroy\s*\(/][i]) : null))
    .filter(Boolean);
  const missing = [];
  if (!targetOff) missing.push('targetOff(this)');
  if (!releaseAll) missing.push('releaseAll(');
  if (!superCall) missing.push('super.onDestroy()');
  return { methodFound: true, bodyParsed: found.bodyParsed, targetOff, releaseAll, superCall, evidence, missing };
}

function buildGroupReport(root, dir, key, files) {
  const [baseName, digits] = key.split('::');
  const report = {
    baseName,
    digits: digits || null,
    files: {
      Module: files.Module ? path.relative(root, path.join(dir, files.Module)) : null,
      Data: files.Data ? path.relative(root, path.join(dir, files.Data)) : null,
      Config: files.Config ? path.relative(root, path.join(dir, files.Config)) : null
    }
  };
  report.onDestroy = files.Module
    ? analyzeOnDestroy(fs.readFileSync(path.join(dir, files.Module), 'utf8'))
    : { methodFound: false, note: 'no Module file in this group' };
  return report;
}

export function handler({ modulePath }, root) {
  const abs = resolveInRoot(root, modulePath, 'modulePath');
  const stat = fs.statSync(abs);
  const dir = stat.isDirectory() ? abs : path.dirname(abs);
  const groups = groupDirectoryFiles(dir);

  if (stat.isFile()) {
    const parsed = parseTripleName(path.basename(abs));
    if (!parsed) {
      return {
        modulePath,
        dir: path.relative(root, dir),
        groups: [],
        note: 'file name does not match the Module/Data/Config naming pattern'
      };
    }
    const key = `${parsed.baseName}::${parsed.digits}`;
    const files = groups.get(key) || {};
    return { modulePath, dir: path.relative(root, dir), groups: [buildGroupReport(root, dir, key, files)], groupsTruncated: false };
  }

  const selectedKeys = [...groups.keys()].sort().slice(0, MAX_GROUPS);
  const groupReports = selectedKeys.map((key) => buildGroupReport(root, dir, key, groups.get(key)));
  return { modulePath, dir: path.relative(root, dir), groups: groupReports, groupsTruncated: groups.size > MAX_GROUPS };
}
