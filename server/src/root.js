import fs from 'node:fs';
import path from 'node:path';
import { ToolError } from './errors.js';

const DENY_SEGMENTS = new Set(['.git', 'node_modules']);
const DENY_DIR_PATTERN = /^(dist|dist-prod|build|library|temp|out)$/i;
const DENY_PATH_PATTERN = /core-lib/i;

function readArgValue(argv, flag) {
  const idx = argv.indexOf(flag);
  if (idx === -1 || idx === argv.length - 1) return undefined;
  return argv[idx + 1];
}

export function resolveRoot(argv) {
  const explicit = readArgValue(argv, '--root');
  const candidate = explicit || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  let real;
  try {
    real = fs.realpathSync(candidate);
  } catch (err) {
    throw new Error(`cannot resolve project root "${candidate}": ${err.message}`);
  }
  const stat = fs.statSync(real);
  if (!stat.isDirectory()) {
    throw new Error(`project root is not a directory: ${real}`);
  }
  return real;
}

export function isDenylistedRelative(relPath) {
  const segments = relPath.split(path.sep).filter(Boolean);
  return segments.some(
    (segment) => DENY_SEGMENTS.has(segment) || DENY_DIR_PATTERN.test(segment) || DENY_PATH_PATTERN.test(segment)
  );
}

// realpath is resolved BEFORE the prefix check so a symlink inside root that
// points outside (e.g. at $HOME) cannot pass a naive string comparison.
export function resolveInRoot(root, inputPath, label = 'path') {
  if (typeof inputPath !== 'string' || inputPath.length === 0) {
    throw new ToolError(`${label} must be a non-empty string`);
  }
  const raw = path.isAbsolute(inputPath) ? inputPath : path.join(root, inputPath);
  let real;
  try {
    real = fs.realpathSync(raw);
  } catch (err) {
    throw new ToolError(`${label} not found: ${inputPath}`);
  }
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (real !== root && !real.startsWith(rootWithSep)) {
    throw new ToolError(`${label} escapes project root: ${inputPath}`);
  }
  const relFromRoot = path.relative(root, real);
  if (isDenylistedRelative(relFromRoot)) {
    throw new ToolError(`${label} is denylisted (vcs/dependency/generated path): ${inputPath}`);
  }
  return real;
}
