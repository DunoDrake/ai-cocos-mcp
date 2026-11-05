import fs from 'node:fs';
import path from 'node:path';
import { isDenylistedRelative } from '../root.js';

const MAX_PROJECTS_DEFAULT = 25;
const MAX_PROJECTS_CAP = 50;
const GAME_DIR_PATTERN = /-([0-9]{4})$/;

export const declaration = {
  name: 'project_map',
  description:
    'Discover likely Cocos Creator project roots under the resolved project root, their creator/engine version, actual npm scripts, and bounded game-like subdirectories.',
  inputSchema: {
    type: 'object',
    properties: {
      maxProjects: {
        type: 'number',
        description: `Cap on returned project roots (default ${MAX_PROJECTS_DEFAULT}, max ${MAX_PROJECTS_CAP}).`
      }
    }
  }
};

export function validate(args) {
  const input = args || {};
  let maxProjects = MAX_PROJECTS_DEFAULT;
  if (input.maxProjects !== undefined) {
    if (typeof input.maxProjects !== 'number' || !Number.isFinite(input.maxProjects) || input.maxProjects <= 0) {
      throw new Error('maxProjects must be a positive number');
    }
    maxProjects = Math.min(Math.floor(input.maxProjects), MAX_PROJECTS_CAP);
  }
  return { maxProjects };
}

function isProjectRoot(dir) {
  const pkgPath = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgPath)) return false;
  try {
    return fs.statSync(path.join(dir, 'assets')).isDirectory();
  } catch {
    return false;
  }
}

function findProjectRoots(root, maxProjects) {
  const found = [];
  let visited = 0;
  const maxVisited = 6000;
  const maxDepth = 6;
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length > 0 && found.length < maxProjects && visited < maxVisited) {
    const { dir, depth } = queue.shift();
    if (isProjectRoot(dir)) {
      found.push(dir);
      continue;
    }
    if (depth >= maxDepth) continue;
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
      queue.push({ dir: childPath, depth: depth + 1 });
    }
  }
  return { found, truncated: found.length >= maxProjects || visited >= maxVisited };
}

function findGameDirs(root, projectDir) {
  const assetsDir = path.join(projectDir, 'assets');
  if (!fs.existsSync(assetsDir)) return { games: [], truncated: false };
  const games = [];
  let visited = 0;
  const maxVisited = 3000;
  const maxDepth = 5;
  const maxGames = 25;
  const queue = [{ dir: assetsDir, depth: 0 }];
  let truncated = false;
  while (queue.length > 0 && !truncated) {
    if (visited >= maxVisited) {
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
      const match = GAME_DIR_PATTERN.exec(entry.name);
      if (match) {
        games.push({ name: entry.name, path: path.relative(root, childPath), gameId: match[1] });
        if (games.length >= maxGames) {
          truncated = true;
          break;
        }
        continue;
      }
      if (depth + 1 < maxDepth) queue.push({ dir: childPath, depth: depth + 1 });
    }
  }
  return { games, truncated };
}

function readPackageInfo(projectDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8'));
    return {
      name: typeof pkg.name === 'string' ? pkg.name : null,
      creatorVersion: pkg.creator && typeof pkg.creator.version === 'string' ? pkg.creator.version : null,
      scripts: pkg.scripts && typeof pkg.scripts === 'object' ? Object.keys(pkg.scripts) : []
    };
  } catch {
    return { name: null, creatorVersion: null, scripts: [] };
  }
}

export function handler({ maxProjects }, root) {
  const { found, truncated } = findProjectRoots(root, maxProjects);
  const projects = found.map((projectDir) => {
    const info = readPackageInfo(projectDir);
    const { games, truncated: gamesTruncated } = findGameDirs(root, projectDir);
    return {
      path: path.relative(root, projectDir) || '.',
      packageName: info.name,
      creatorVersion: info.creatorVersion,
      scripts: info.scripts,
      games,
      gamesTruncated
    };
  });
  return { root, projects, projectsTruncated: truncated };
}
