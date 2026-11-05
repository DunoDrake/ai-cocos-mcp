import fs from 'node:fs';
import path from 'node:path';
import { resolveInRoot } from '../root.js';
import { walkFiles } from '../fsWalk.js';
import { maskSourceLines } from '../sourceMask.js';

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];
const MAX_FINDINGS = 200;
const MAX_FILE_BYTES = 3 * 1024 * 1024;

export const declaration = {
  name: 'es5_scan',
  description:
    'Recursively scan source files for constructs banned by the repo cross-profile ES5-safety rule: optional chaining, nullish coalescing, Object.fromEntries, flat/flatMap, replaceAll, Promise.allSettled, globalThis, top-level await, private #fields, BigInt literals.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative source file or directory to scan.' }
    },
    required: ['path']
  }
};

export function validate(args) {
  if (!args || typeof args.path !== 'string' || args.path.length === 0) {
    throw new Error('path is required and must be a non-empty string');
  }
  return { path: args.path };
}

const SIMPLE_RULES = [
  { name: 'optional-chaining', regex: /\?\./ },
  { name: 'nullish-coalescing', regex: /\?\?/ },
  { name: 'object-from-entries', regex: /Object\.fromEntries\s*\(/ },
  { name: 'array-flat', regex: /\.flat\s*\(/ },
  { name: 'array-flatmap', regex: /\.flatMap\s*\(/ },
  { name: 'string-replaceall', regex: /\.replaceAll\s*\(/ },
  { name: 'promise-allsettled', regex: /Promise\.allSettled\s*\(/ },
  { name: 'globalthis', regex: /\bglobalThis\b/ },
  { name: 'bigint-literal', regex: /\b(?:0[xX][0-9a-fA-F]+|0[oO][0-7]+|0[bB][01]+|\d+)n\b/ }
];

const PRIVATE_FIELD_PATTERN = /#[A-Za-z_$][\w$]*/;

function scanFile(absPath, relPath) {
  const stat = fs.statSync(absPath);
  if (stat.size > MAX_FILE_BYTES) return { findings: [], skipped: true };
  const text = fs.readFileSync(absPath, 'utf8');
  const { lines, maskedLines, depths } = maskSourceLines(text);
  const findings = [];
  lines.forEach((line, idx) => {
    if (idx === 0 && line.startsWith('#!')) return;
    const maskedLine = maskedLines[idx];
    for (const rule of SIMPLE_RULES) {
      if (rule.regex.test(maskedLine)) {
        findings.push({ file: relPath, line: idx + 1, rule: rule.name, snippet: line.trim().slice(0, 160) });
      }
    }
    if (PRIVATE_FIELD_PATTERN.test(maskedLine)) {
      findings.push({ file: relPath, line: idx + 1, rule: 'private-field', snippet: line.trim().slice(0, 160) });
    }
    if (depths[idx] === 0 && /\bawait\b/.test(maskedLine)) {
      findings.push({ file: relPath, line: idx + 1, rule: 'top-level-await', snippet: line.trim().slice(0, 160) });
    }
  });
  return { findings, skipped: false };
}

function resolveTargetFiles(root, abs, stat) {
  if (stat.isFile()) {
    const hasSourceExt = SOURCE_EXTENSIONS.some((ext) => abs.endsWith(ext));
    return { files: hasSourceExt ? [abs] : [], truncated: false };
  }
  return walkFiles(root, abs, {
    extensions: SOURCE_EXTENSIONS,
    maxDepth: 20,
    maxFiles: 3000,
    maxVisitedDirs: 6000
  });
}

export function handler({ path: relPath }, root) {
  const abs = resolveInRoot(root, relPath, 'path');
  const stat = fs.statSync(abs);
  const { files: targetFiles, truncated: filesTruncated } = resolveTargetFiles(root, abs, stat);

  const findings = [];
  let filesScanned = 0;
  let filesSkippedLarge = 0;
  let findingsTruncated = false;
  for (const file of targetFiles) {
    filesScanned += 1;
    const { findings: fileFindings, skipped } = scanFile(file, path.relative(root, file));
    if (skipped) {
      filesSkippedLarge += 1;
      continue;
    }
    for (const finding of fileFindings) {
      if (findings.length >= MAX_FINDINGS) {
        findingsTruncated = true;
        break;
      }
      findings.push(finding);
    }
    if (findingsTruncated) break;
  }

  return { path: relPath, filesScanned, filesSkippedLarge, filesTruncated, findingsTruncated, findings };
}
