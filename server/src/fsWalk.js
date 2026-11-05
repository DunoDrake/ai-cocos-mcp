import fs from 'node:fs';
import path from 'node:path';
import { isDenylistedRelative } from './root.js';

export function walkFiles(root, startDir, options = {}) {
  const { extensions, maxDepth = 12, maxFiles = 2000, maxVisitedDirs = 4000 } = options;
  const files = [];
  let visitedDirs = 0;
  let truncated = false;
  const stack = [{ dir: startDir, depth: 0 }];

  while (stack.length > 0) {
    if (visitedDirs >= maxVisitedDirs || files.length >= maxFiles) {
      truncated = true;
      break;
    }
    const { dir, depth } = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    visitedDirs += 1;
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const childPath = path.join(dir, entry.name);
      const relFromRoot = path.relative(root, childPath);
      if (isDenylistedRelative(relFromRoot)) continue;
      if (entry.isDirectory()) {
        if (depth + 1 <= maxDepth) stack.push({ dir: childPath, depth: depth + 1 });
      } else if (entry.isFile()) {
        if (!extensions || extensions.some((ext) => entry.name.endsWith(ext))) {
          files.push(childPath);
          if (files.length >= maxFiles) {
            truncated = true;
            break;
          }
        }
      }
    }
  }
  return { files, truncated };
}
