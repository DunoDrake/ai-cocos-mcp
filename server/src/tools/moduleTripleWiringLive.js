import fs from 'node:fs';
import path from 'node:path';
import { resolveInRoot } from '../root.js';
import { walkFiles } from '../fsWalk.js';
import { maskSourceText } from '../sourceMask.js';
import { ToolError } from '../errors.js';
import { BRIDGE_EXTENSION, readBridgeConnection, requestBridge, MAX_TREE_RESPONSE_BYTES } from '../bridgeClient.js';

const MAX_ROWS = 1000;
const MAX_COMPONENTS = 200;
const MAX_BATCH = 200;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_TOTAL_SOURCE_BYTES = 16 * MAX_SOURCE_BYTES;
const MODULE_PATTERN = /^(.*)Module(\d*)$/;
const UUID_PATTERN = /^[A-Za-z0-9+/=_-]{1,64}$/;

export const declaration = {
  name: 'module_triple_wiring_check_live',
  description: 'Audit resolved live Editor Module components for compatible Config on the same node and Data class declarations in explicit source scopes. Only audits a Module when its own class source demonstrably calls getComponent() on a Config identifier matching the naming-convention-derived compatible name(s) for that Module; a Module that depends on a differently-named Config class (e.g. a shorter shared/inherited Config prefix) is a known limitation and is skipped, reported in skipped[] with reason no_config_dependency_in_source \u2014 this means "no naming-convention-compatible Config dependency found", not "provably has zero Config dependency". Read-only; never opens, changes, or saves a scene. Among audited modules: missing Config on the node is error; Data class not found is warn. Healthy modules are counted, not findings. Unresolved CIDs are reported separately, never inferred as class names. registeredKeysCount counts only provable literal string-array field initializers, not runtime/inherited keys. Compatibility accepts the same numeric suffix or an unsuffixed class, never a different suffix. No hardcoded per-game whitelist.',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string', description: 'Cocos project directory, relative to server root or absolute inside it.' },
      gamePath: { type: 'string', description: 'Optional game source directory, relative to server root or absolute inside it. Omit to skip game-local sources; no game is inferred.' },
      includeCommon: { type: 'boolean', default: true, description: 'Also search project/assets/cc-common when present.' },
      maxNodes: { type: 'integer', default: 400, description: 'Maximum live nodes to inspect; clamped to 1..1000. Node requests contain at most 200 UUIDs.' }
    },
    required: ['projectPath'],
    additionalProperties: false
  }
};

export function validate(args) {
  if (!args || typeof args.projectPath !== 'string' || !args.projectPath.trim()) {
    throw new Error('projectPath must be a non-empty string');
  }
  if (args.gamePath !== undefined && (typeof args.gamePath !== 'string' || !args.gamePath.trim())) {
    throw new Error('gamePath must be a non-empty string');
  }
  if (args.includeCommon !== undefined && typeof args.includeCommon !== 'boolean') {
    throw new Error('includeCommon must be a boolean');
  }
  if (args.maxNodes !== undefined && !Number.isInteger(args.maxNodes)) {
    throw new Error('maxNodes must be an integer');
  }
  return {
    projectPath: args.projectPath, gamePath: args.gamePath,
    includeCommon: args.includeCommon === undefined ? true : args.includeCommon,
    maxNodes: args.maxNodes === undefined ? 400 : Math.max(1, Math.min(MAX_ROWS, args.maxNodes))
  };
}

function resolveDirectory(root, input, label) {
  const directory = resolveInRoot(root, input, label);
  if (!fs.statSync(directory).isDirectory()) throw new ToolError(`${label} must be a directory`);
  return directory;
}

function sourceScopes(args, root, project) {
  const scopes = [];
  if (args.gamePath !== undefined) scopes.push(resolveDirectory(root, args.gamePath, 'gamePath'));
  const common = path.join(project, 'assets', 'cc-common');
  if (args.includeCommon && fs.existsSync(common)) scopes.push(resolveDirectory(root, common, 'commonPath'));
  return [...new Set(scopes)];
}

function route(projectPath, endpoint, uuids, extraParams) {
  const params = new URLSearchParams({ projectPath });
  if (uuids) params.set('uuids', uuids.join(','));
  if (extraParams) {
    for (const [key, value] of Object.entries(extraParams)) params.set(key, value);
  }
  return `${endpoint}?${params.toString()}`;
}

function requireNodeResponse(response, project, endpoint) {
  if (!response || response.projectPath !== project || !Array.isArray(response.nodes) ||
      typeof response.truncated !== 'boolean') {
    throw new Error(`Bridge returned an unexpected ${endpoint} shape; reload the extension`);
  }
}

function catalogNames(catalog) {
  if (!catalog || !Array.isArray(catalog.entries) || typeof catalog.truncated !== 'boolean') {
    throw new Error('Bridge returned an unexpected component-catalog shape; reload the extension');
  }
  const names = new Map();
  for (const entry of catalog.entries) {
    if (!entry || typeof entry.cid !== 'string' || typeof entry.name !== 'string' || !entry.name) continue;
    if (names.has(entry.cid) && names.get(entry.cid) !== entry.name) names.set(entry.cid, null);
    else if (!names.has(entry.cid)) names.set(entry.cid, entry.name);
  }
  return names;
}

async function readLiveNodes(connection, project, maxNodes) {
  const tree = await requestBridge(connection, route(project, '/scene/node-tree'), MAX_TREE_RESPONSE_BYTES);
  requireNodeResponse(tree, project, 'node-tree');
  const selected = [];
  const seen = new Set();
  for (const node of tree.nodes) {
    if (!node || typeof node.uuid !== 'string' || !UUID_PATTERN.test(node.uuid)) {
      throw new Error('Bridge returned an invalid node uuid');
    }
    if (!seen.has(node.uuid) && selected.length < maxNodes) selected.push(node);
    seen.add(node.uuid);
  }
  const catalog = await requestBridge(connection, route(project, '/scene/component-catalog'), MAX_RESPONSE_BYTES);
  const names = catalogNames(catalog);
  const result = { nodes: [], names, truncated: tree.truncated || catalog.truncated || seen.size > maxNodes };
  for (let offset = 0; offset < selected.length; offset += MAX_BATCH) {
    const batch = selected.slice(offset, offset + MAX_BATCH);
    const response = await requestBridge(connection, route(project, '/scene/node', batch.map((node) => node.uuid), { includeProperties: '0' }), MAX_RESPONSE_BYTES);
    requireNodeResponse(response, project, 'node');
    const byUuid = new Map(response.nodes.map((node) => [node && node.uuid, node]));
    result.truncated = result.truncated || response.truncated || byUuid.size !== batch.length;
    for (const entry of batch) {
      const node = byUuid.get(entry.uuid);
      if (!node) { result.truncated = true; continue; }
      if (!Array.isArray(node.components)) throw new Error('Bridge returned an invalid component list');
      result.nodes.push({ uuid: entry.uuid, path: entry.path, components: node.components });
    }
  }
  return result;
}

function closingBrace(masked, start) {
  let depth = 0;
  for (let index = start; index < masked.length; index += 1) {
    if (masked[index] === '{') depth += 1;
    else if (masked[index] === '}' && --depth === 0) return index;
  }
  return -1;
}

function literalArrayCount(source) {
  const tokens = /\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|("(?:\\[^\r\n]|[^"\\\r\n])*"|'(?:\\[^\r\n]|[^'\\\r\n])*')|(,)/gy;
  let position = 0;
  let count = 0;
  let expectValue = true;
  while (position < source.length) {
    tokens.lastIndex = position;
    const token = tokens.exec(source);
    if (!token) return null;
    position = tokens.lastIndex;
    if (token[1]) {
      if (!expectValue) return null;
      count += 1;
      expectValue = false;
    } else if (token[2]) {
      if (expectValue) return null;
      expectValue = true;
    }
  }
  return count;
}

function registeredKeysCount(source, masked) {
  const occurrences = masked.match(/\bregisteredKeys\b/g);
  if (!occurrences || occurrences.length !== 1) return null;
  const field = /(?:^|[;\n}])\s*(?:(?:public|protected|private|readonly|override)\s+)*registeredKeys\s*(?::\s*(?:string\s*\[\s*\]|Array\s*<\s*string\s*>))?\s*=\s*\[/.exec(masked);
  if (!field) return null;
  const start = field.index + field[0].length;
  let depth = 0;
  for (let index = 0; index < start; index += 1) {
    if (masked[index] === '{') depth += 1;
    else if (masked[index] === '}') depth -= 1;
  }
  if (depth !== 0) return null;
  const end = masked.indexOf(']', start);
  if (end < 0 || !/^\s*(?:;|$)/.test(masked.slice(end + 1))) return null;
  return literalArrayCount(source.slice(start, end));
}

function collectGetComponentTargets(maskedBody) {
  const targets = new Set();
  const pattern = /getComponent\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g;
  let match;
  while ((match = pattern.exec(maskedBody))) targets.add(match[1]);
  return targets;
}

// A Module class only "depends" on a Config when its own body calls
// getComponent() on that identifier — matching *Module*/*Config* names alone
// produces false positives for framework modules (Toast/Dialog/Popup/...)
// that share the naming suffix but never read a sibling Config component.
function collectModuleClasses(source, modules) {
  const masked = maskSourceText(source);
  const declarations = /\bclass\s+((?:[A-Za-z_$][\w$]*)?Module\d*)\b[^;{]*\{/g;
  let declaration;
  while ((declaration = declarations.exec(masked))) {
    const start = declaration.index + declaration[0].length;
    const end = closingBrace(masked, start - 1);
    if (end < 0) continue;
    const targets = collectGetComponentTargets(masked.slice(start, end));
    const name = declaration[1];
    modules.set(name, modules.has(name) ? null : targets);
  }
}

function collectDataClasses(source, classes) {
  const masked = maskSourceText(source);
  const declarations = /\bclass\s+((?:[A-Za-z_$][\w$]*)?Data\d*)\b[^;{]*\{/g;
  let declaration;
  while ((declaration = declarations.exec(masked))) {
    const start = declaration.index + declaration[0].length;
    const end = closingBrace(masked, start - 1);
    if (end < 0) continue;
    const count = registeredKeysCount(source.slice(start, end), masked.slice(start, end));
    const name = declaration[1];
    classes.set(name, classes.has(name) ? null : count);
  }
}

function readSourceEvidence(scopes, root) {
  const classes = new Map();
  const moduleClasses = new Map();
  const seen = new Set();
  let bytes = 0;
  let truncated = false;
  for (const scope of scopes) {
    const walked = walkFiles(root, scope, { extensions: ['.ts'], maxDepth: Infinity, maxFiles: 2000 });
    truncated = truncated || walked.truncated;
    for (const file of walked.files.sort()) {
      if (seen.has(file)) continue;
      seen.add(file);
      const resolved = resolveInRoot(root, file, 'sourcePath');
      if (resolved !== scope && !resolved.startsWith(scope + path.sep)) {
        throw new ToolError('sourcePath escapes its requested source scope');
      }
      const size = fs.statSync(resolved).size;
      if (size > MAX_SOURCE_BYTES || bytes + size > MAX_TOTAL_SOURCE_BYTES) { truncated = true; continue; }
      bytes += size;
      const text = fs.readFileSync(resolved, 'utf8');
      collectDataClasses(text, classes);
      collectModuleClasses(text, moduleClasses);
    }
  }
  return { classes, moduleClasses, truncated };
}

function compatibleNames(base, kind, digits) {
  const unsuffixed = `${base}${kind}`;
  return digits ? [unsuffixed + digits, unsuffixed] : [unsuffixed];
}

function componentName(component, names) {
  const resolved = typeof component.name === 'string' && component.name ? component.name : null;
  if (!names.has(component.cid)) return resolved;
  const catalogName = names.get(component.cid);
  if (!catalogName || (resolved && resolved !== catalogName)) return null;
  return resolved || catalogName;
}

function boundedText(value, limit, result) {
  if (typeof value !== 'string') return null;
  if (value.length > limit) result.truncated = true;
  return value.slice(0, limit);
}

function appendBounded(rows, row, result) {
  if (rows.length < MAX_ROWS) rows.push(row);
  else result.truncated = true;
}

function appendSkipped(context, reason) {
  const { name, node, result } = context;
  result.scanned.skippedModuleComponents += 1;
  appendBounded(result.skipped, {
    nodeUuid: node.uuid, nodePath: boundedText(node.path, 1024, result),
    moduleName: boundedText(name, 256, result), reason
  }, result);
}

function auditModule(context) {
  const { name, match, node, names, classes, moduleEvidence, result } = context;
  result.scanned.moduleComponents += 1;
  const configNames = compatibleNames(match[1], 'Config', match[2]);
  const evidence = moduleEvidence.get(name);
  if (evidence === undefined) return appendSkipped(context, 'module_source_not_found');
  if (evidence === null) return appendSkipped(context, 'ambiguous_module_source_duplicate_declaration');
  const dependsOnConfig = configNames.some((candidate) => evidence.has(candidate));
  if (!dependsOnConfig) return appendSkipped(context, 'no_config_dependency_in_source');
  result.scanned.auditedModuleComponents += 1;
  const dataNames = compatibleNames(match[1], 'Data', match[2]);
  const dataName = dataNames.find((candidate) => classes.has(candidate));
  const hasConfig = configNames.some((candidate) => names.includes(candidate));
  if (hasConfig && dataName) { result.scanned.healthyModuleComponents += 1; return; }
  const row = {
    nodeUuid: node.uuid, nodePath: boundedText(node.path, 1024, result),
    moduleName: boundedText(name, 256, result),
    expectedConfigName: boundedText(configNames[0], 256, result),
    hasConfigOnNode: hasConfig, dataClassFound: Boolean(dataName),
    registeredKeysCount: dataName ? classes.get(dataName) : null
  };
  if (!hasConfig) appendBounded(result.findings, { severity: 'error', ...row }, result);
  if (!dataName) appendBounded(result.findings, { severity: 'warn', ...row }, result);
}

function auditNode(node, live, evidence, result) {
  result.scanned.nodes += 1;
  if (node.components.length > MAX_COMPONENTS) result.truncated = true;
  const components = node.components.slice(0, MAX_COMPONENTS);
  const names = components.map((component) => {
    if (!component || typeof component !== 'object') throw new Error('Bridge returned an invalid component');
    return componentName(component, live.names);
  });
  for (let index = 0; index < components.length; index += 1) {
    const name = names[index];
    if (!name) {
      appendBounded(result.unresolvedCids, {
        nodeUuid: node.uuid, nodePath: boundedText(node.path, 1024, result),
        cid: boundedText(components[index].cid, 256, result)
      }, result);
      continue;
    }
    const match = MODULE_PATTERN.exec(name);
    if (match) auditModule({ name, match, node, names, classes: evidence.classes, moduleEvidence: evidence.moduleClasses, result });
  }
}

export async function handler(input, root) {
  const args = validate(input);
  const project = resolveDirectory(root, args.projectPath, 'projectPath');
  const scopes = sourceScopes(args, root, project);
  let live;
  try {
    const connection = readBridgeConnection(project);
    live = await readLiveNodes(connection, project, args.maxNodes);
  } catch (error) {
    const detail = error.code === 'ENOENT'
      ? `Load ${BRIDGE_EXTENSION} in this project's Extension Manager; discovery file is missing`
      : error.message;
    throw new ToolError(`Editor connection unavailable: ${detail}`);
  }
  const evidence = readSourceEvidence(scopes, root);
  const result = {
    projectPath: project,
    scanned: {
      nodes: 0, moduleComponents: 0, auditedModuleComponents: 0,
      healthyModuleComponents: 0, skippedModuleComponents: 0
    },
    findings: [], skipped: [], whitelisted: [], unresolvedCids: [], truncated: live.truncated || evidence.truncated
  };
  for (const node of live.nodes) auditNode(node, live, evidence, result);
  return result;
}
