import fs from 'node:fs';

const MAX_SCENE_BYTES = 64 * 1024 * 1024;

export function readSceneAsArray(absPath) {
  const stat = fs.statSync(absPath);
  if (stat.size > MAX_SCENE_BYTES) {
    return { ok: false, error: `scene file too large to parse safely (${stat.size} bytes)` };
  }
  const text = fs.readFileSync(absPath, 'utf8');
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `JSON parse error: ${err.message}` };
  }
  if (Array.isArray(data)) return { ok: true, entries: data };
  if (data && typeof data === 'object') return { ok: true, entries: [data] };
  return { ok: false, error: 'unexpected root JSON type (expected array or object)' };
}
