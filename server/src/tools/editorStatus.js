import { resolveInRoot } from '../root.js';
import { ToolError } from '../errors.js';
import { BRIDGE_EXTENSION, readBridgeConnection, requestBridge } from '../bridgeClient.js';

export const declaration = {
  name: 'editor_status',
  description: 'Check the live Cocos Editor bridge for a specific project. Reads project identity only; does not read, modify, or save scenes. Requires the companion extension.',
  inputSchema: {
    type: 'object',
    properties: { projectPath: { type: 'string', description: 'Cocos project directory relative to the server root, or an absolute path inside it.' } },
    required: ['projectPath']
  }
};

export function validate(args) {
  if (!args || typeof args.projectPath !== 'string' || !args.projectPath.trim()) {
    throw new Error('projectPath must be a non-empty string');
  }
  return { projectPath: args.projectPath };
}

export async function handler({ projectPath }, root) {
  const project = resolveInRoot(root, projectPath, 'projectPath');
  try {
    const connection = readBridgeConnection(project);
    const health = await requestBridge(connection, '/health');
    if (!health || health.status !== 'ok' || health.extension !== BRIDGE_EXTENSION || health.bridgeVersion !== 1 ||
        health.projectPath !== project || health.instanceId !== connection.instanceId ||
        health.pid !== connection.pid || typeof health.writeEnabled !== 'boolean' || typeof health.projectName !== 'string') {
      throw new Error('Bridge identity mismatch; reload the extension in the requested project');
    }
    return {
      connected: true, projectPath: project, projectName: health.projectName,
      extension: BRIDGE_EXTENSION, bridgeVersion: 1, pid: health.pid, writeEnabled: health.writeEnabled
    };
  } catch (error) {
    const detail = error.code === 'ENOENT'
      ? `Load ${BRIDGE_EXTENSION} in this project's Extension Manager; discovery file is missing`
      : error.message;
    throw new ToolError(`Editor connection unavailable: ${detail}`);
  }
}
