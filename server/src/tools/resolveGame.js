import fs from 'node:fs';
import path from 'node:path';
import { isDenylistedRelative } from '../root.js';

const GAME_ID_PATTERN = /^[0-9]{4}$/;
const MAX_MATCHES = 25;
const MAX_VISITED = 20000;
const MAX_DEPTH = 16;

export const declaration = {
  name: 'resolve_game',
  description:
    'Resolve a 4-digit game id to all matching game-like directories under the project root; never guesses on ambiguous matches.',
  inputSchema: {
    type: 'object',
    properties: {
      gameId: { type: 'string', pattern: '^[0-9]{4}$', description: 'Four-digit game id, e.g. 1001' }
    },
    required: ['gameId']
  }
};

export function validate(args) {
  if (!args || typeof args.gameId !== 'string' || !GAME_ID_PATTERN.test(args.gameId)) {
    throw new Error('gameId is required and must match ^[0-9]{4}$');
  }
  return { gameId: args.gameId };
}

function isProjectRoot(dir) {
  if (!fs.existsSync(path.join(dir, 'package.json'))) return false;
  try {
    return fs.statSync(path.join(dir, 'assets')).isDirectory();
  } catch {
    return false;
  }
}

function findAncestorProjectInfo(root, startDir) {
  let current = startDir;
  for (let i = 0; i < 12; i += 1) {
    if (isProjectRoot(current)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(current, 'package.json'), 'utf8'));
        const creatorVersion = pkg.creator && typeof pkg.creator.version === 'string' ? pkg.creator.version : null;
        return { projectPath: path.relative(root, current) || '.', creatorVersion };
      } catch {
        return { projectPath: path.relative(root, current) || '.', creatorVersion: null };
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { projectPath: null, creatorVersion: null };
}

function describeMatch(root, dir) {
  const project = findAncestorProjectInfo(root, path.dirname(dir));
  let childCount = null;
  try {
    childCount = fs.readdirSync(dir).length;
  } catch {
    childCount = null;
  }
  return {
    path: path.relative(root, dir),
    name: path.basename(dir),
    project,
    hasVersionJson: fs.existsSync(path.join(dir, 'version.json')),
    childCount
  };
}

export function handler({ gameId }, root) {
  const pattern = new RegExp(`(?:^|[^0-9])${gameId}$`);
  const matches = [];
  let visited = 0;
  let truncated = false;
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length > 0 && matches.length < MAX_MATCHES) {
    if (visited >= MAX_VISITED) {
      truncated = true;
      break;
    }
    const { dir, depth } = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    visited += 1;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const childPath = path.join(dir, entry.name);
      if (isDenylistedRelative(path.relative(root, childPath))) continue;
      if (pattern.test(entry.name)) {
        matches.push(describeMatch(root, childPath));
        if (matches.length >= MAX_MATCHES) {
          truncated = true;
          break;
        }
        continue;
      }
      if (depth + 1 < MAX_DEPTH) queue.push({ dir: childPath, depth: depth + 1 });
    }
  }
  return { gameId, matches, matchesTruncated: truncated || visited >= MAX_VISITED };
}
