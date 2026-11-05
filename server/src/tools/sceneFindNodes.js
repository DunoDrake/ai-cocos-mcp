import { resolveInRoot } from '../root.js';
import { ToolError } from '../errors.js';
import { BRIDGE_EXTENSION, readBridgeConnection, requestBridge, MAX_TREE_RESPONSE_BYTES } from '../bridgeClient.js';

const MAX_NAME_PATTERN_LENGTH = 200;
const DEFAULT_MAX_RESULTS = 100;
const MAX_MAX_RESULTS = 500;

export const declaration = {
  name: 'scene_find_nodes',
  description:
    'Filter the live scene node hierarchy by name/path regex through the companion Cocos Editor extension. Read-only: fetches the full tree via /scene/node-tree and filters client-side; never opens, modifies, or saves a scene. Requires the Editor to have the project open.',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string', description: 'Cocos project directory relative to the server root, or an absolute path inside it.' },
      namePattern: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_NAME_PATTERN_LENGTH,
        description: 'Regular expression (no flags) matched against each node\'s path.'
      },
      componentName: {
        type: 'string',
        description: 'NOT AVAILABLE YET: passing this always fails with a not_available_yet error until a component-reading route ships.'
      },
      maxResults: { type: 'integer', minimum: 1, maximum: MAX_MAX_RESULTS, default: DEFAULT_MAX_RESULTS }
    },
    required: ['projectPath'],
    additionalProperties: false
  }
};

export function validate(args) {
  if (!args || typeof args.projectPath !== 'string' || !args.projectPath.trim()) {
    throw new Error('projectPath must be a non-empty string');
  }
  if (args.namePattern !== undefined) {
    if (typeof args.namePattern !== 'string' || args.namePattern.length === 0 || args.namePattern.length > MAX_NAME_PATTERN_LENGTH) {
      throw new Error(`namePattern must be a 1-${MAX_NAME_PATTERN_LENGTH} character string`);
    }
    try {
      // eslint-disable-next-line no-new
      new RegExp(args.namePattern);
    } catch (error) {
      throw new Error(`namePattern is not a valid regular expression: ${error.message}`);
    }
  }
  if (args.componentName !== undefined && (typeof args.componentName !== 'string' || args.componentName.length === 0)) {
    throw new Error('componentName must be a non-empty string');
  }
  let maxResults = DEFAULT_MAX_RESULTS;
  if (args.maxResults !== undefined) {
    if (!Number.isInteger(args.maxResults) || args.maxResults < 1 || args.maxResults > MAX_MAX_RESULTS) {
      throw new Error(`maxResults must be an integer between 1 and ${MAX_MAX_RESULTS}`);
    }
    maxResults = args.maxResults;
  }
  return {
    projectPath: args.projectPath,
    namePattern: args.namePattern,
    componentName: args.componentName,
    maxResults
  };
}

function buildRequestPath(projectPath) {
  return `/scene/node-tree?${new URLSearchParams({ projectPath }).toString()}`;
}

export async function handler({ projectPath, namePattern, componentName, maxResults }, root) {
  if (componentName !== undefined) {
    throw new ToolError('not_available_yet: componentName filtering requires a component-reading bridge route that does not exist yet');
  }
  const project = resolveInRoot(root, projectPath, 'projectPath');
  let tree;
  try {
    const connection = readBridgeConnection(project);
    tree = await requestBridge(connection, buildRequestPath(project), MAX_TREE_RESPONSE_BYTES);
    if (!tree || tree.projectPath !== project || !Array.isArray(tree.nodes) || typeof tree.truncated !== 'boolean') {
      throw new Error('Bridge returned an unexpected node-tree shape; reload the extension in the requested project');
    }
  } catch (error) {
    const detail = error.code === 'ENOENT'
      ? `Load ${BRIDGE_EXTENSION} in this project's Extension Manager; discovery file is missing`
      : error.message;
    throw new ToolError(`Editor connection unavailable: ${detail}`);
  }

  // No `g`/`y` flags: this regex is only ever used with .test(), so there is
  // no lastIndex state to leak between the nodes checked in this one call.
  const matcher = namePattern ? new RegExp(namePattern) : null;
  const matchedNodes = matcher ? tree.nodes.filter((node) => matcher.test(node.path)) : tree.nodes;

  return {
    projectPath: project,
    matched: matchedNodes.length,
    truncated: tree.truncated || matchedNodes.length > maxResults,
    nodes: matchedNodes.slice(0, maxResults).map((node) => ({
      uuid: node.uuid,
      name: node.name,
      path: node.path,
      parentUuid: node.parentUuid
    }))
  };
}
