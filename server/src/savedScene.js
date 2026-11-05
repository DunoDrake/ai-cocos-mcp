import fs from 'node:fs';
import { resolveInRoot } from './root.js';
import { ToolError } from './errors.js';

const SCRIPT_UUID_PATTERN = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32}|[0-9a-f]{5}[A-Za-z0-9+/]{18}|[0-9a-f]{2}[A-Za-z0-9+/]{20})$/i;

export function resolveSavedScene(root, options) {
  const project = resolveInRoot(root, options.projectPath === undefined ? '.' : options.projectPath, 'projectPath');
  if (!fs.statSync(project).isDirectory()) throw new ToolError('projectPath must point to a directory');
  const scene = resolveInRoot(project, options.scenePath, 'scenePath');
  if (!/\.(scene|prefab)$/i.test(scene) || !fs.statSync(scene).isFile()) {
    throw new ToolError('scenePath must point to a regular .scene or .prefab file');
  }
  return { project, scene };
}

export function componentScriptUuid(component) {
  if (component._script && typeof component._script.__uuid__ === 'string') return component._script.__uuid__;
  return typeof component.__type__ === 'string' && SCRIPT_UUID_PATTERN.test(component.__type__) ? component.__type__ : null;
}
