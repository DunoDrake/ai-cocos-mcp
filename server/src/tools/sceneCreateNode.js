import { resolveInRoot } from '../root.js';
import { ToolError } from '../errors.js';
import { BRIDGE_EXTENSION, readBridgeConnection, requestBridge } from '../bridgeClient.js';

const PARENT_UUID_PATTERN = /^[A-Za-z0-9+/_-]{20,80}$/;
const NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_ .-]*$/;

export const declaration = {
  name: 'scene_create_node',
  description:
    'Create ONE empty node live in the open Cocos Editor scene hierarchy. Requires the companion extension with write enabled. Does NOT save the scene; the change is undoable with Ctrl+Z in the Editor.',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string', description: 'Cocos project dir relative to server root.' },
      parentUuid: {
        type: 'string',
        pattern: '^[A-Za-z0-9+/_-]{20,80}$',
        description: 'REQUIRED. Parent node UUID from scene_query_node_tree. Path strings are not accepted.'
      },
      name: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9_][A-Za-z0-9_ .-]*$' },
      siblingIndex: { type: 'integer', minimum: -1, default: -1 },
      position: {
        type: 'object',
        additionalProperties: false,
        properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }
      },
      nameIncrease: { type: 'boolean', default: true },
      allowDirty: { type: 'boolean', default: false },
      confirm: { type: 'boolean', const: true }
    },
    required: ['projectPath', 'parentUuid', 'name', 'confirm'],
    additionalProperties: false
  }
};

export function validate(args) {
  if (!args || typeof args.projectPath !== 'string' || !args.projectPath.trim()) {
    throw new Error('projectPath must be a non-empty string');
  }
  if (typeof args.parentUuid !== 'string' || !PARENT_UUID_PATTERN.test(args.parentUuid)) {
    throw new Error('parentUuid must be a non-empty uuid-like string from scene_query_node_tree, not a path');
  }
  if (typeof args.name !== 'string' || !NAME_PATTERN.test(args.name) || args.name.length > 64) {
    throw new Error('name must be a 1-64 character string matching ^[A-Za-z0-9_][A-Za-z0-9_ .-]*$');
  }
  if (args.siblingIndex !== undefined && args.siblingIndex !== -1) {
    throw new Error('siblingIndex only supports -1 (append) in this version');
  }
  if (args.position !== undefined) {
    const position = args.position;
    if (!position || typeof position !== 'object' || typeof position.x !== 'number' || typeof position.y !== 'number' || typeof position.z !== 'number') {
      throw new Error('position must be an object with numeric x, y, z');
    }
  }
  if (args.nameIncrease !== undefined && typeof args.nameIncrease !== 'boolean') {
    throw new Error('nameIncrease must be a boolean');
  }
  if (args.allowDirty !== undefined && typeof args.allowDirty !== 'boolean') {
    throw new Error('allowDirty must be a boolean');
  }
  if (args.confirm !== true) {
    throw new Error('confirm must be true; this tool creates a live node in the open Editor scene');
  }
  return {
    projectPath: args.projectPath,
    parentUuid: args.parentUuid,
    name: args.name,
    position: args.position,
    nameIncrease: args.nameIncrease !== false,
    allowDirty: args.allowDirty === true
  };
}

export async function handler({ projectPath, parentUuid, name, position, nameIncrease, allowDirty }, root) {
  const project = resolveInRoot(root, projectPath, 'projectPath');
  const body = { projectPath: project, parentUuid, name, nameIncrease, allowDirty, confirm: true };
  if (position) body.position = position;
  try {
    const connection = readBridgeConnection(project);
    const result = await requestBridge(connection, '/scene/create-node', undefined, { method: 'POST', body });
    if (!result || typeof result.uuid !== 'string' || typeof result.undoable !== 'boolean' || typeof result.sceneSaved !== 'boolean') {
      throw new Error('Bridge returned an unexpected create-node response shape; reload the extension in the requested project');
    }
    return {
      projectPath: project,
      parentUuid,
      uuid: result.uuid,
      path: result.path || null,
      undoable: result.undoable,
      sceneSaved: result.sceneSaved
    };
  } catch (error) {
    const detail = error.code === 'ENOENT'
      ? `Load ${BRIDGE_EXTENSION} in this project's Extension Manager; discovery file is missing`
      : error.message;
    throw new ToolError(`Editor connection unavailable or create-node rejected: ${detail}`);
  }
}
