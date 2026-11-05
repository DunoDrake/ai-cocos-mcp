import * as projectMap from './projectMap.js';
import * as resolveGame from './resolveGame.js';
import * as sceneInspect from './sceneInspect.js';
import * as assetRefsCheck from './assetRefsCheck.js';
import * as es5Scan from './es5Scan.js';
import * as moduleTripleCheck from './moduleTripleCheck.js';
import * as editorStatus from './editorStatus.js';
import * as sceneQueryNodeTree from './sceneQueryNodeTree.js';
import * as sceneCreateNode from './sceneCreateNode.js';
import * as sceneQueryNodeComponents from './sceneQueryNodeComponents.js';
import * as sceneQueryComponentsCatalog from './sceneQueryComponentsCatalog.js';
import * as sceneBatchNodeProperties from './sceneBatchNodeProperties.js';
import * as moduleTripleWiringLive from './moduleTripleWiringLive.js';
import * as sceneMissingRefsLive from './sceneMissingRefsLive.js';
import { ProtocolError, ToolError } from '../errors.js';

const MODULES = [
  projectMap, resolveGame, sceneInspect, assetRefsCheck, es5Scan, moduleTripleCheck,
  editorStatus, sceneQueryNodeTree, moduleTripleWiringLive, sceneMissingRefsLive, sceneCreateNode,
  sceneQueryNodeComponents, sceneQueryComponentsCatalog, sceneBatchNodeProperties
];

export const TOOLS = MODULES.map((mod) => ({
  declaration: mod.declaration,
  validate: mod.validate,
  handler: mod.handler
}));

export async function callTool(params, root) {
  if (!params || typeof params !== 'object' || typeof params.name !== 'string') {
    throw new ProtocolError(-32602, 'Invalid params: tools/call requires a string "name"');
  }
  const tool = TOOLS.find((entry) => entry.declaration.name === params.name);
  if (!tool) {
    throw new ProtocolError(-32602, `Unknown tool: ${params.name}`);
  }
  let args;
  try {
    args = tool.validate(params.arguments || {});
  } catch (err) {
    throw new ProtocolError(-32602, `Invalid arguments for ${params.name}: ${err.message}`);
  }
  try {
    const output = await tool.handler(args, root);
    return {
      content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
      structuredContent: output
    };
  } catch (err) {
    if (err instanceof ToolError) {
      return { content: [{ type: 'text', text: err.message }], isError: true };
    }
    throw err;
  }
}
