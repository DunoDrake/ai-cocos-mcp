import { resolveInRoot } from '../root.js';
import { ToolError } from '../errors.js';
import { BRIDGE_EXTENSION, readBridgeConnection, requestBridge, MAX_TREE_RESPONSE_BYTES } from '../bridgeClient.js';

const ROOT_UUID_PATTERN = /^[A-Za-z0-9+/=_-]{1,64}$/;

export const declaration = {
  name: 'scene_query_node_tree',
  description:
    'Read the live scene node hierarchy (uuid, name, path, parent/child links) through the companion Cocos Editor extension. Read-only: never opens, modifies, or saves a scene. Requires the Editor to have the project open.',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string', description: 'Cocos project directory relative to the server root, or an absolute path inside it.' },
      rootUuid: { type: 'string', description: 'Optional node uuid to scope the query to a subtree; omit to query the whole open scene.' }
    },
    required: ['projectPath']
  }
};

export function validate(args) {
  if (!args || typeof args.projectPath !== 'string' || !args.projectPath.trim()) {
    throw new Error('projectPath must be a non-empty string');
  }
  if (args.rootUuid !== undefined && (typeof args.rootUuid !== 'string' || !ROOT_UUID_PATTERN.test(args.rootUuid))) {
    throw new Error('rootUuid must be a non-empty uuid-like string');
  }
  return { projectPath: args.projectPath, rootUuid: args.rootUuid };
}

function buildRequestPath(projectPath, rootUuid) {
  const params = new URLSearchParams({ projectPath });
  if (rootUuid) params.set('rootUuid', rootUuid);
  return `/scene/node-tree?${params.toString()}`;
}

export async function handler({ projectPath, rootUuid }, root) {
  const project = resolveInRoot(root, projectPath, 'projectPath');
  try {
    const connection = readBridgeConnection(project);
    const tree = await requestBridge(connection, buildRequestPath(project, rootUuid), MAX_TREE_RESPONSE_BYTES);
    if (!tree || tree.projectPath !== project || !Array.isArray(tree.nodes) ||
        typeof tree.nodeCount !== 'number' || typeof tree.truncated !== 'boolean') {
      throw new Error('Bridge returned an unexpected node-tree shape; reload the extension in the requested project');
    }
    return {
      projectPath: project,
      rootUuid: rootUuid || null,
      nodeCount: tree.nodeCount,
      truncated: tree.truncated,
      nodes: tree.nodes
    };
  } catch (error) {
    const detail = error.code === 'ENOENT'
      ? `Load ${BRIDGE_EXTENSION} in this project's Extension Manager; discovery file is missing`
      : error.message;
    throw new ToolError(`Editor connection unavailable: ${detail}`);
  }
}
