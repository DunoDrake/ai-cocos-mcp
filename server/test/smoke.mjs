import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { buildSceneTree } from '../src/sceneTree.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(HERE, '..', 'src', 'index.js');
const FOO_UUID = '0e30d14f-cf2f-4f9e-b3c0-38bfc09af72a';
const FOO_UUID_COMPRESSED = '0e30dFPzy9PnrPAOL/Amvcq';
const SCENE_PATH = 'assets/cc-release-slot/cc-demo-9999/g9999.scene';

const failures = [];

function assert(condition, message) {
  if (!condition) failures.push(message);
}

function buildFixture() {
  const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-mcp-smoke-')));
  const projectRoot = path.join(tmpRoot, 'fixture-project');
  const scriptsDir = path.join(projectRoot, 'assets', 'cc-release-slot', 'cc-demo-9999', 'scripts');
  const commonScriptsDir = path.join(projectRoot, 'assets', 'cc-common', 'scripts');
  const decoyDir = path.join(projectRoot, 'node_modules', 'fake-9999');

  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.mkdirSync(commonScriptsDir, { recursive: true });
  fs.mkdirSync(decoyDir, { recursive: true });
  fs.writeFileSync(path.join(decoyDir, 'index.js'), '// decoy, must never be reported by resolve_game\n');

  fs.writeFileSync(
    path.join(projectRoot, 'package.json'),
    JSON.stringify({ name: 'fixture-project', version: '1.0.0', creator: { version: '3.7.3' }, scripts: { build: 'echo build', pull: 'echo pull' } }, null, 2)
  );

  fs.writeFileSync(path.join(tmpRoot, 'outside-secret.txt'), 'should not be reachable via mcp\n');

  writeFixtureScene(path.join(projectRoot, 'assets', 'cc-release-slot', 'cc-demo-9999', 'g9999.scene'));
  writeFixtureModuleTriple(scriptsDir);
  writeFixtureViolations(scriptsDir);
  writeFixtureMaskedViolations(scriptsDir);
  writeFixtureFoo(commonScriptsDir);

  return { tmpRoot, projectRoot };
}

function writeFixtureScene(scenePath) {
  const scene = [
    { __type__: 'cc.SceneAsset', _name: 'g9999', scene: { __id__: 1 } },
    { __type__: 'cc.Scene', _name: 'g9999', _children: [{ __id__: 2 }], _components: [] },
    {
      __type__: 'cc.Node', _id: 'root-node', _name: 'Root', _parent: { __id__: 1 },
      _children: [{ __id__: 3 }], _components: [{ __id__: 4 }, { __id__: 5 }],
      _active: false, _lpos: { __type__: 'cc.Vec3', x: 1, y: 2, z: 3 },
      _lrot: { __type__: 'cc.Quat', x: 0, y: 0, z: 0, w: 1 },
      _lscale: { __type__: 'cc.Vec3', x: 2, y: 2, z: 2 }, _layer: 33554432,
      customData: { nested: { secret: 'must not be exposed' } }
    },
    { __type__: 'cc.Node', _id: 'child-node', _name: 'Child', _parent: { __id__: 2 }, _children: [], _components: [{ __id__: 6 }] },
    { __type__: 'cc.Sprite', _enabled: false, _sizeMode: 2, _spriteFrame: { __uuid__: `${FOO_UUID_COMPRESSED}@f9941` } },
    { __type__: 'cc.Sprite', _spriteFrame: { __uuid__: 'deadbeef-dead-beef-dead-beefdeadbeef' } },
    { __type__: 'cc.Label', _string: 'Hello' }
  ];
  fs.writeFileSync(scenePath, JSON.stringify(scene, null, 2));
}

function writeFixtureModuleTriple(scriptsDir) {
  fs.writeFileSync(
    path.join(scriptsDir, 'DemoModule.ts'),
    "import { Component } from 'cc';\nimport { DemoConfig } from './DemoConfig';\n\nexport class DemoModule extends Component {\n  private moduleEvent: any;\n  private config: DemoConfig;\n\n  onLoad(): void {\n    this.config = this.getComponent(DemoConfig);\n  }\n\n  onDestroy() {\n    this.moduleEvent.targetOff(this);\n    super.onDestroy();\n  }\n}\n"
  );
  fs.writeFileSync(path.join(scriptsDir, 'DemoData.ts'), 'export class DemoData {\n  matrix: number[][] = [];\n}\n');
  fs.writeFileSync(path.join(scriptsDir, 'DemoConfig.ts'), 'export class DemoConfig {\n  static readonly GAME_ID = 9999;\n}\n');
  fs.writeFileSync(
    path.join(scriptsDir, 'BadModule.ts'),
    "import { Component } from 'cc';\nimport { BadConfig } from './BadConfig';\n\nexport class BadModule extends Component {\n  private config: BadConfig;\n\n  onLoad(): void {\n    this.config = this.getComponent(BadConfig);\n  }\n\n  onDestroy() {\n    console.log('destroyed');\n  }\n}\n"
  );
  fs.writeFileSync(
    path.join(scriptsDir, 'NoDestroyModule.ts'),
    "import { Component } from 'cc';\n\n/**\n * TODO: implement onDestroy() cleanup here.\n */\nexport class NoDestroyModule extends Component {\n  private moduleEvent: any;\n}\n"
  );
  fs.writeFileSync(
    path.join(scriptsDir, 'FrameworkModule.ts'),
    "import { Component } from 'cc';\n\nexport class FrameworkModule extends Component {\n  onLoad(): void {\n    this.node.children.forEach((child) => child.active = true);\n  }\n}\n"
  );
}

function writeFixtureViolations(scriptsDir) {
  const content = [
    'const value = someObject?.prop;',
    "const fallback = value ?? 'default';",
    'const merged = Object.fromEntries(new Map());',
    'const flattened = [[1, 2]].flat();',
    'const mapped = [1, 2].flatMap((x) => [x]);',
    "const replaced = 'a-b-a'.replaceAll('a', 'c');",
    'const settled = Promise.allSettled([]);',
    'const globalRef = globalThis;',
    'const bigDecimal = 10n;',
    'const bigHex = 0x1Fn;',
    'const bigOctal = 0o17n;',
    'const bigBinary = 0b101n;',
    '',
    'class Holder {',
    '  #secret = 1;',
    '}',
    '',
    'await doSomethingAsync();',
    ''
  ].join('\n');
  fs.writeFileSync(path.join(scriptsDir, 'Violations.ts'), content);
}

function writeFixtureMaskedViolations(scriptsDir) {
  const content = [
    "const cssSelector = '#header';",
    '// #issue tracked in a comment, not a private field',
    "const literal = 'a??b';",
    'const real = someObject?.prop;',
    ''
  ].join('\n');
  fs.writeFileSync(path.join(scriptsDir, 'MaskedViolations.ts'), content);
}

function writeFixtureFoo(commonScriptsDir) {
  fs.writeFileSync(path.join(commonScriptsDir, 'Foo.ts'), "import { Component } from 'cc';\n\nexport class Foo extends Component {}\n");
  fs.writeFileSync(
    path.join(commonScriptsDir, 'Foo.ts.meta'),
    JSON.stringify({ ver: '4.0.23', importer: 'typescript', imported: true, uuid: FOO_UUID, files: [], subMetas: {}, userData: {} }, null, 2)
  );
}

function runSession(root, requests) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_ENTRY, '--root', root], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdoutBuf = '';
    let stderrBuf = '';
    const responses = [];

    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString('utf8');
      let idx;
      while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, idx);
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (line.trim().length > 0) responses.push(line);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, responses, stderr: stderrBuf, danglingStdout: stdoutBuf });
    });

    for (const req of requests) {
      const line = typeof req === 'string' ? req : JSON.stringify(req);
      child.stdin.write(`${line}\n`);
    }
    child.stdin.end();
  });
}

function parseResponses(rawLines) {
  return rawLines.map((line, idx) => {
    try {
      return JSON.parse(line);
    } catch (err) {
      failures.push(`stdout line ${idx} is not valid JSON: ${err.message} (line: ${line.slice(0, 200)})`);
      return null;
    }
  });
}

function findById(messages, id) {
  for (const msg of messages) {
    if (Array.isArray(msg)) {
      const found = msg.find((item) => item && item.id === id);
      if (found) return found;
    } else if (msg && msg.id === id) {
      return msg;
    }
  }
  return undefined;
}

function toolResult(message) {
  return message && message.result;
}

function savedSceneRequests() {
  const calls = [
    ['scene_query_node_components', { nodePath: 'g9999/Root' }],
    ['scene_query_node_components', { nodeUuid: 'root-node', maxComponents: 1 }],
    ['scene_query_components_catalog', { maxResults: 2 }],
    ['scene_query_components_catalog', { typeFilter: 'sPRiTe', maxResults: 1 }],
    ['scene_batch_node_properties', { nodes: [{ nodeUuid: 'child-node' }, { nodePath: 'g9999/Missing' }, { nodePath: 'g9999/Root' }] }],
    ['scene_batch_node_properties', {
      nodes: [{ nodeUuid: 'root-node' }, { nodeUuid: 'child-node' }], maxNodes: 1,
      properties: ['name', '_components', '_parent', '__proto__', 'customData']
    }]
  ];
  return calls.map(([name, args], index) => ({
    jsonrpc: '2.0', id: 16 + index, method: 'tools/call',
    params: { name, arguments: { scenePath: SCENE_PATH, ...args } }
  }));
}

function savedSceneOutput(messages, id) {
  const result = toolResult(findById(messages, id));
  assert(!!result && !result.isError && !!result.structuredContent, `saved-scene call ${id} failed: ${JSON.stringify(findById(messages, id))}`);
  return result && result.structuredContent ? result.structuredContent : {};
}

function assertNodeComponents(messages) {
  const output = savedSceneOutput(messages, 16);
  const components = output.components || [];
  assert(output.node && output.node.nodeUuid === 'root-node' && output.node.path === 'g9999/Root', 'node components must resolve the exact Root path');
  assert(output.count === 2 && output.truncated === false && components.length === 2, 'Root must expose both attached Sprite components');
  assert(components.every((component) => component.type === 'cc.Sprite'), 'node components must not include the Child Label');
  const first = components[0];
  assert(first && first.enabled === false && first.fields._sizeMode === 2, 'node components must preserve serialized enabled/scalar values');
  assert(first && !Object.prototype.hasOwnProperty.call(first.fields, '_spriteFrame') && first.fieldsTruncated, 'node components must omit non-scalar asset references and report omitted fields');
  const capped = savedSceneOutput(messages, 17);
  assert(capped.count === 2 && capped.truncated === true && capped.components && capped.components.length === 1, 'component cap must preserve total count and signal truncation');
  assert(capped.components && JSON.stringify(capped.components[0]) === JSON.stringify(first), 'UUID selector and cap must return the same first component as path selection');
}

function assertComponentsCatalog(messages) {
  const output = savedSceneOutput(messages, 18);
  const entries = output.entries || [];
  assert(output.parsed === true && output.totalMatches === 3 && output.returned === 2 && output.truncated === true, 'catalog must bound references while retaining total matches');
  const identities = entries.map((entry) => [entry.type, entry.nodePath, entry.componentIndex]);
  assert(JSON.stringify(identities) === JSON.stringify([['cc.Label', 'g9999/Root/Child', 0], ['cc.Sprite', 'g9999/Root', 0]]), 'catalog must order by type then serialized component order');
  assert(entries.every((entry) => !Object.prototype.hasOwnProperty.call(entry, 'fields') && !Object.prototype.hasOwnProperty.call(entry, '_spriteFrame')), 'catalog must not expose component payloads');
  const filtered = savedSceneOutput(messages, 19);
  assert(filtered.totalMatches === 2 && filtered.returned === 1 && filtered.truncated === true, 'catalog type filter must be case-insensitive and preserve bounded totals');
  assert(filtered.entries && filtered.entries.length === 1 && JSON.stringify(filtered.entries[0]) === JSON.stringify(entries[1]), 'filtered catalog must select the first matching Sprite deterministically');
}

function assertBatchProperties(messages) {
  const output = savedSceneOutput(messages, 20);
  const results = output.results || [];
  assert(output.requested === 3 && output.processed === 3 && output.truncated === false && results.length === 3, 'batch must preserve all mixed hit/miss results');
  assert(JSON.stringify(results.map((result) => [result.index, result.ok])) === JSON.stringify([[0, true], [1, false], [2, true]]), 'batch results must retain selector order across a miss');
  assert(results[0] && results[0].nodeUuid === 'child-node' && results[0].properties.name === 'Child', 'batch UUID selector must resolve Child');
  assert(results[1] && results[1].code === 'not_found', 'missing batch node must produce an individual not_found error');
  const root = results[2];
  const expected = { name: 'Root', active: false, position: { x: 1, y: 2, z: 3 }, rotation: { w: 1, x: 0, y: 0, z: 0 }, scale: { x: 2, y: 2, z: 2 }, layer: 33554432 };
  assert(root && root.nodeUuid === 'root-node' && JSON.stringify(root.properties) === JSON.stringify(expected) && root.propertyErrors.length === 0, 'default batch properties must expose only safe names/scalars/transforms, preserving false');
  const capped = savedSceneOutput(messages, 21);
  assert(capped.requested === 2 && capped.processed === 1 && capped.truncated === true && capped.results && capped.results.length === 1, 'batch cap must retain requested count and signal truncation');
  const safe = capped.results && capped.results[0];
  assert(safe && safe.ok === true && JSON.stringify(safe.properties) === JSON.stringify({ name: 'Root' }), 'explicit batch properties must not leak references, prototype fields, or deep objects');
  assert(safe && JSON.stringify(safe.propertyErrors.map((error) => error.property)) === JSON.stringify(['_components', '_parent', '__proto__', 'customData']), 'unsafe batch properties must report individual errors');
}

function writeReviewFixtures(projectRoot) {
  fs.mkdirSync(path.join(projectRoot, 'selected'));
  fs.mkdirSync(path.join(projectRoot, 'directory.scene'));
  fs.copyFileSync(path.join(projectRoot, SCENE_PATH), path.join(projectRoot, 'arbitrary.json'));
  fs.copyFileSync(path.join(projectRoot, SCENE_PATH), path.join(projectRoot, 'selected', 'valid.prefab'));
  const identities = ['plugin.NamedComponent', FOO_UUID, FOO_UUID.replace(/-/g, ''), FOO_UUID_COMPRESSED, '0e' + 'A'.repeat(20)];
  const components = identities.map((type) => ({ __type__: type }));
  components.push({ __type__: 'plugin.ExplicitScript', _script: { __uuid__: FOO_UUID } });
  components.push({ __type__: 'plugin.InvalidUuid', _script: {} });
  const node = { __type__: 'cc.Node', _id: 'plugins', _name: 'Plugins', _components: components.map((_, index) => ({ __id__: index + 1 })) };
  fs.writeFileSync(path.join(projectRoot, 'plugins.prefab'), JSON.stringify([node, ...components]));
  writeCatalogIdentityFixture(projectRoot);
}

function writeCatalogIdentityFixture(projectRoot) {
  const huge = '\u0001'.repeat(10000);
  const entries = Array.from({ length: 20 }, (_, index) => ({
    __type__: 'cc.Node', _name: huge, _id: huge,
    _parent: index ? { __id__: index - 1 } : null, _components: []
  }));
  entries[0]._components.push({ __id__: 20 });
  entries[19]._components.push({ __id__: 20 }, { __id__: 20 }, { __id__: 20 });
  entries.push({ __type__: huge, _script: { __uuid__: huge } });
  fs.writeFileSync(path.join(projectRoot, 'identities.scene'), JSON.stringify(entries));
  const exact = 'x'.repeat(256);
  fs.writeFileSync(path.join(projectRoot, 'exact.scene'), JSON.stringify([
    { __type__: 'cc.Node', _name: exact, _id: exact, _components: [{ __id__: 1 }] },
    { __type__: exact, _script: { __uuid__: exact } }
  ]));
}

function reviewRequests(projectRoot) {
  const tools = ['scene_query_node_components', 'scene_query_components_catalog', 'scene_batch_node_properties'];
  const invalidScopes = [
    { scenePath: 'arbitrary.json' },
    { projectPath: SCENE_PATH, scenePath: path.join(projectRoot, SCENE_PATH) },
    { projectPath: 'selected', scenePath: path.join(projectRoot, SCENE_PATH) },
    { scenePath: 'directory.scene' }
  ];
  const cases = [];
  for (const name of tools) {
    const selectors = name === tools[0] ? { nodeUuid: 'root-node' } : name === tools[2] ? { nodes: [{ nodeUuid: 'root-node' }] } : {};
    for (const scope of invalidScopes) cases.push({ name, args: { ...scope, ...selectors }, reject: true });
    cases.push({ name, args: { projectPath: 'selected', scenePath: 'valid.prefab', ...selectors } });
  }
  cases.push({ name: tools[1], args: { scenePath: 'identities.scene', maxResults: 3 }, check: assertCatalogIdentities });
  cases.push({ name: tools[1], args: { scenePath: 'exact.scene' }, check: assertExactIdentities });
  cases.push({ name: tools[0], args: { scenePath: 'plugins.prefab', nodeUuid: 'plugins' }, check: assertPluginIdentities });
  cases.push({ name: tools[1], args: { scenePath: 'plugins.prefab' }, check: assertPluginIdentities });
  return cases.map((test, index) => ({ ...test, id: 200 + index }));
}

function assertCatalogIdentities(output, message) {
  const entries = output.entries || [];
  assert(output.totalMatches === 4 && output.returned === 3 && output.truncated, 'adversarial catalog must preserve count and result cap');
  assert(output.identityTruncated && entries.every((entry) => entry.identityTruncated), 'adversarial catalog must report every truncated identity');
  assert(entries.every((entry) => entry.nodePath.length <= 4096 && entry.nodePath.split('/').every((segment) => segment.length <= 256)), 'catalog must cap both hierarchy segments and final paths');
  assert(entries.every((entry) => ['nodeUuid', 'type', 'scriptUuid'].every((key) => entry[key].length === 256)), 'catalog must cap all non-path identities');
  assert(entries[0] && entries[0].nodePath.length === 256 && entries[1] && entries[1].nodePath.length === 4096, 'catalog fixture must exercise independent segment and final-path bounds');
  assert(Buffer.byteLength(JSON.stringify(message), 'utf8') < 200000, 'entire MCP response must remain bounded even with JSON-escaped oversized identities');
}

function assertExactIdentities(output) {
  const entry = output.entries && output.entries[0];
  assert(output.identityTruncated === false && entry && entry.identityTruncated === false, 'exact-limit identities must not falsely signal truncation');
  assert(entry && ['nodePath', 'nodeUuid', 'type', 'scriptUuid'].every((key) => entry[key] === 'x'.repeat(256)), 'exact-limit identity strings must remain intact');
}

function assertPluginIdentities(output) {
  const entries = output.components || output.entries || [];
  const expected = [null, FOO_UUID, FOO_UUID.replace(/-/g, ''), FOO_UUID_COMPRESSED, '0e' + 'A'.repeat(20), FOO_UUID, null];
  assert(entries.length === expected.length, 'plugin fixture must expose all encoded and named component types');
  for (const entry of entries) {
    const index = entry.componentIndex === undefined ? entry.index : entry.componentIndex;
    assert(entry.scriptUuid === expected[index], `scriptUuid must distinguish explicit/encoded UUIDs from named plugins at index ${index}`);
  }
}

function assertReviewResults(messages, cases) {
  for (const test of cases) {
    const message = findById(messages, test.id);
    const result = toolResult(message);
    if (test.reject) {
      assert(result && result.isError === true, `${test.name} must reject invalid saved-scene scope ${JSON.stringify(test.args)}`);
    } else {
      const output = savedSceneOutput(messages, test.id);
      if (test.check) test.check(output, message);
    }
  }
}

function assertAssetRefBounds(projectRoot) {
  for (const count of [20, 21]) {
    const refs = Array.from({ length: count }, (_, index) => ({ __uuid__: `asset-${index}` }));
    const scenePath = `refs-${count}.scene`;
    fs.writeFileSync(path.join(projectRoot, scenePath), JSON.stringify([
      { __type__: 'cc.Node', _name: 'Refs', _components: [{ __id__: 1 }] },
      { __type__: 'cc.Sprite', refs, ignored: { __id__: 0 } }
    ]));
    const tree = buildSceneTree(projectRoot, scenePath);
    const node = tree.nodes[0];
    const component = node.components[0];
    assert(component.assetRefs.length === 20 && node.assetRefs.length === 20, 'asset refs must remain capped at 20');
    assert(component.assetRefsTruncated === (count > 20) && node.assetRefsTruncated === (count > 20) && tree.assetRefs.truncated === (count > 20), `asset-ref truncation must reflect an actual extra qualifying ref for count ${count}`);
  }
}

function assertManifestSentinel(projectRoot) {
  const manifest = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'manifest.json'), 'utf8'));
  const createNode = manifest.tools.find((tool) => tool.name === 'scene_create_node');
  const sentinel = createNode.description.match(/create a (\S+) sentinel file/);
  fs.mkdirSync(path.join(projectRoot, '.mcp-control'));
  fs.writeFileSync(path.join(projectRoot, '.mcp-control', 'mcp-write-enabled'), '');
  assert(sentinel && fs.existsSync(path.join(projectRoot, sentinel[1])), 'manifest write opt-in path must resolve to the project control sentinel');
}

function liveFixtureNodes() {
  const missing = { __uuid__: 'missing-asset@frame', __expectedType__: 'cc.SpriteFrame' };
  return [
    { uuid: 'healthy-node', path: 'Scene/Healthy', components: [
      { cid: 'demo-module', name: 'DemoModule', index: 0, properties: {
        frame: missing, frames: [missing], valid: { __uuid__: FOO_UUID },
        ignored: { __id__: 7, nested: { __uuid__: 'ignored-asset' } }
      }, propertiesTruncated: false },
      { cid: 'demo-config', name: 'DemoConfig', index: 1, properties: {}, propertiesTruncated: false }
    ], componentsTruncated: false },
    { uuid: 'broken-node', path: 'Scene/Broken', components: [
      { cid: 'bad-module', name: 'BadModule', index: 0, properties: {}, propertiesTruncated: false },
      { cid: 'framework-module', name: 'FrameworkModule', index: 1, properties: {}, propertiesTruncated: false },
      { cid: 'unresolved-cid', name: null, index: 2, properties: { icon: { __uuid__: 'missing-asset@frame' } }, propertiesTruncated: false }
    ], componentsTruncated: false }
  ];
}

function liveBridgePayload(state, url) {
  const nodes = liveFixtureNodes();
  const base = { projectPath: state.projectRoot, truncated: state.mode === 'truncated' };
  if (url.pathname === '/scene/node-tree') {
    return { ...base, nodes: [nodes[0], nodes[0], nodes[1]].map((node) => ({ uuid: node.uuid, path: node.path })) };
  }
  if (url.pathname === '/scene/component-catalog') {
    return { entries: [{ cid: 'demo-module', name: 'DemoModule' }, { cid: 'demo-config', name: 'DemoConfig' }, { cid: 'bad-module', name: 'BadModule' }, { cid: 'framework-module', name: 'FrameworkModule' }], truncated: false };
  }
  const uuids = (url.searchParams.get('uuids') || '').split(',');
  if (url.pathname === '/scene/node') {
    const selected = nodes.filter((node) => uuids.includes(node.uuid));
    if (state.mode === 'old-extension') delete selected[0].components[0].properties;
    return { ...base, nodes: selected.concat(selected[0] ? [selected[0]] : []) };
  }
  if (url.pathname === '/asset/info') {
    state.assetQueries.push(uuids);
    const results = uuids.map((uuid) => ({ uuid, exists: uuid === FOO_UUID, url: null, type: null }));
    if (state.mode === 'incomplete') results.pop();
    return { requested: uuids.length, resolved: results.filter((item) => item.exists).length, truncated: false, results };
  }
  throw new Error(`Unexpected bridge route ${url.pathname}`);
}

async function startLiveBridge(projectRoot) {
  const state = { projectRoot, mode: 'normal', assetQueries: [], requests: [] };
  const token = 'a'.repeat(64);
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    state.requests.push({ method: request.method, route: url.pathname });
    assert(request.method === 'GET', 'live READ tools must never issue a write request');
    assert(request.headers.authorization === `Bearer ${token}`, 'live bridge must receive discovery authentication');
    assert(url.searchParams.get('projectPath') === projectRoot, 'live bridge calls must retain exact project identity');
    response.setHeader('Content-Type', 'application/json');
    if (state.mode === 'asset-error' && url.pathname === '/asset/info') {
      response.writeHead(503);
      response.end(JSON.stringify({ error: 'asset_database_unavailable' }));
      return;
    }
    response.end(JSON.stringify(liveBridgePayload(state, url)));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  fs.mkdirSync(path.join(projectRoot, 'temp'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'temp', 'mcp-editor-server.json'), JSON.stringify({
    extension: 'cc30-mcp-server-extension', bridgeVersion: 1, projectPath: projectRoot,
    port: server.address().port, token, instanceId: 'b'.repeat(32)
  }), { mode: 0o600 });
  return { state, server };
}

function liveReadCases() {
  const moduleArgs = { projectPath: '.', gamePath: 'assets/cc-release-slot/cc-demo-9999', includeCommon: false };
  return [
    { name: 'module_triple_wiring_check_live', args: moduleArgs, check: assertLiveModules },
    { name: 'module_triple_wiring_check_live', args: { ...moduleArgs, maxNodes: 1 }, check: assertHealthyLiveModule },
    { name: 'scene_missing_refs_live', args: { projectPath: '.' }, check: assertLiveMissingRefs },
    { name: 'scene_missing_refs_live', args: { projectPath: '.', maxRefs: 1 }, check: assertCappedLiveRefs },
    { name: 'scene_missing_refs_live', args: { projectPath: '.' }, mode: 'truncated', check: assertTruncatedLiveRefs },
    { name: 'scene_missing_refs_live', args: { projectPath: '.' }, mode: 'asset-error', error: '503' },
    { name: 'scene_missing_refs_live', args: { projectPath: '.' }, mode: 'old-extension', error: 'properties unavailable' },
    { name: 'scene_missing_refs_live', args: { projectPath: '.' }, mode: 'incomplete', error: 'incomplete asset-info' }
  ];
}

function assertLiveModules(output) {
  assert(output.scanned.nodes === 2 && output.scanned.moduleComponents === 3 && output.scanned.auditedModuleComponents === 2 &&
    output.scanned.healthyModuleComponents === 1 && output.scanned.skippedModuleComponents === 1,
    'live module audit must count distinct nodes, all *Module* components, audited vs skipped, and healthy triples');
  assert(output.truncated === false && output.findings.length === 2, 'live module audit must return only the two broken-triple findings');
  assert(JSON.stringify(output.findings.map((row) => [row.moduleName, row.severity, row.hasConfigOnNode, row.dataClassFound])) === JSON.stringify([
    ['BadModule', 'error', false, false], ['BadModule', 'warn', false, false]
  ]), 'missing live Config must be error and missing scoped Data must be warn, only for evidence-backed modules');
  assert(output.findings.every((row) => row.nodeUuid === 'broken-node' && row.nodePath === 'Scene/Broken' && row.expectedConfigName === 'BadConfig' && row.registeredKeysCount === null), 'live audit findings must provide actionable node and expected Config identities');
  assert(output.unresolvedCids.length === 1 && output.unresolvedCids[0].cid === 'unresolved-cid', 'unresolved component CIDs must be separate from module findings');
  assert(output.skipped.length === 1 && output.skipped[0].moduleName === 'FrameworkModule' && output.skipped[0].reason === 'no_config_dependency_in_source',
    'a Module with no getComponent(Config) evidence in its own source must be skipped, not flagged as a finding');
}

function assertHealthyLiveModule(output) {
  assert(output.scanned.nodes === 1 && output.scanned.auditedModuleComponents === 1 && output.scanned.healthyModuleComponents === 1 &&
    output.scanned.skippedModuleComponents === 0 && output.findings.length === 0, 'healthy live Module/Config/Data must not produce a finding');
  assert(output.truncated === true, 'maxNodes must flag omitted live nodes');
}

function assertLiveMissingRefs(output, state) {
  assert(output.scannedNodes === 2 && output.scannedRefs === 4 && output.missing.length === 3, 'live refs must dedupe repeated nodes but retain distinct missing occurrences');
  assert(output.truncated === false, 'complete live refs must not claim truncation');
  assert(JSON.stringify(output.missing.map((ref) => [ref.nodeUuid, ref.propertyPath, ref.assetUuid])) === JSON.stringify([
    ['healthy-node', 'frame', 'missing-asset@frame'], ['healthy-node', 'frames[0]', 'missing-asset@frame'], ['broken-node', 'icon', 'missing-asset@frame']
  ]), 'live missing refs must identify exact component property paths and exclude __id__ links');
  assert(output.missing[0].componentName === 'DemoModule' && output.missing[0].expectedType === 'cc.SpriteFrame', 'live refs must preserve available component/type evidence');
  assert(output.missing[2].componentName === null && output.missing[2].expectedType === null, 'live refs must not invent missing component names or expected types');
  assert(JSON.stringify(state.assetQueries) === JSON.stringify([['missing-asset@frame', FOO_UUID]]), 'live refs must query each distinct asset once and never follow __id__');
}

function assertCappedLiveRefs(output) {
  assert(output.truncated === true && output.scannedRefs === 1 && output.missing.length === 1 && output.missing[0].propertyPath === 'frame', 'maxRefs must preserve first missing occurrence and explicitly report incomplete scan');
}

function assertTruncatedLiveRefs(output) {
  assert(output.truncated === true && output.missing.length === 3, 'bridge truncation must propagate without discarding observed missing refs');
}

async function runLiveReadSmoke(projectRoot) {
  const { state, server } = await startLiveBridge(projectRoot);
  const cases = liveReadCases();
  let responseCount = 0;
  try {
    for (const [index, test] of cases.entries()) {
      state.mode = test.mode || 'normal';
      state.assetQueries = [];
      const id = 300 + index;
      const request = { jsonrpc: '2.0', id, method: 'tools/call', params: { name: test.name, arguments: test.args } };
      const session = await runSession(projectRoot, [request]);
      responseCount += session.responses.length;
      assert(session.code === 0 && session.responses.length === 1 && session.danglingStdout === '', `live JSON-RPC case ${id} must return one complete response and exit cleanly`);
      const result = toolResult(findById(parseResponses(session.responses), id));
      if (test.error) {
        assert(result && result.isError === true && result.content[0].text.includes(test.error), `live bridge failure ${test.mode} must be a tool error, not empty success`);
      } else {
        assert(result && !result.isError && result.structuredContent, `live JSON-RPC case ${id} failed: ${JSON.stringify(result)}`);
        if (result && result.structuredContent) test.check(result.structuredContent, state);
      }
    }
    assert(state.requests.every((request) => request.method === 'GET' && request.route !== '/scene/create-node'), 'live audit smoke must remain read-only');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(path.join(projectRoot, 'temp', 'mcp-editor-server.json'));
  }
  return { requests: cases.length, responses: responseCount };
}

function assertCatalogContracts(toolNames) {
  const manifest = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'manifest.json'), 'utf8'));
  assert(JSON.stringify(manifest.tools.map((tool) => tool.name).sort()) === JSON.stringify(toolNames), 'manifest and JSON-RPC catalog must expose identical tool names');
  assert(manifest.tools.filter((tool) => tool.tier === 'read-only' && tool.writes === false).length === 13, 'catalog must have exactly 13 read-only tools');
  assert(manifest.tools.filter((tool) => !tool.editorRequired).length === 9 && manifest.tools.filter((tool) => tool.editorRequired).length === 5, 'catalog must have 9 filesystem and 5 Editor tools');
  for (const name of ['module_triple_wiring_check_live', 'scene_missing_refs_live']) {
    const entry = manifest.tools.find((tool) => tool.name === name);
    assert(entry && entry.tier === 'read-only' && entry.writes === false && entry.editorRequired === true, `${name} must declare the live read-only contract`);
  }
}

async function main() {
  const { tmpRoot, projectRoot } = buildFixture();
  writeReviewFixtures(projectRoot);
  assertAssetRefBounds(projectRoot);
  assertManifestSentinel(projectRoot);
  const reviewCases = reviewRequests(projectRoot);

  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'project_map', arguments: {} } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'resolve_game', arguments: { gameId: '9999' } } },
    {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'scene_inspect', arguments: { scenePath: 'assets/cc-release-slot/cc-demo-9999/g9999.scene' } }
    },
    {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'asset_refs_check', arguments: { scenePath: 'assets/cc-release-slot/cc-demo-9999/g9999.scene' } }
    },
    {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'es5_scan', arguments: { path: 'assets/cc-release-slot/cc-demo-9999/scripts/Violations.ts' } }
    },
    {
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'module_triple_check', arguments: { modulePath: 'assets/cc-release-slot/cc-demo-9999/scripts' } }
    },
    { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } },
    { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'resolve_game', arguments: { gameId: '12' } } },
    {
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'scene_inspect', arguments: { scenePath: '../outside-secret.txt' } }
    },
    {
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: { name: 'es5_scan', arguments: { path: 'assets/cc-release-slot/cc-demo-9999/scripts/MaskedViolations.ts' } }
    },
    { jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'editor_status', arguments: { projectPath: '.' } } },
    { jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name: 'scene_query_node_tree', arguments: { projectPath: '.' } } },
    {
      jsonrpc: '2.0',
      id: 15,
      method: 'tools/call',
      params: {
        name: 'scene_create_node',
        arguments: { projectPath: '.', parentUuid: 'aBcD1234efGH5678ijKL9012mnOP3456', name: 'MCPProbe', confirm: true }
      }
    },
    { jsonrpc: '2.0', id: 22, method: 'tools/call', params: { name: 'module_triple_wiring_check_live', arguments: { projectPath: '.' } } },
    { jsonrpc: '2.0', id: 23, method: 'tools/call', params: { name: 'scene_missing_refs_live', arguments: { projectPath: '.' } } },
    ...savedSceneRequests(),
    ...reviewCases.map((test) => ({ jsonrpc: '2.0', id: test.id, method: 'tools/call', params: { name: test.name, arguments: test.args } })),
    [
      { jsonrpc: '2.0', id: 100, method: 'tools/list' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 101, method: 'ping' }
    ],
    [],
    '{this is not valid json'
  ];

  const session = await runSession(projectRoot, requests);
  const messages = parseResponses(session.responses);

  assert(session.danglingStdout.trim() === '', `stdout had a trailing non-newline-terminated fragment: ${session.danglingStdout}`);

  const notificationResponse = messages[1];
  assert(session.responses.length === requests.length - 1, `expected ${requests.length - 1} response lines (no reply to the notification), got ${session.responses.length}`);

  const initResult = toolResult(findById(messages, 1));
  assert(!!initResult && typeof initResult.protocolVersion === 'string', 'initialize did not return a protocolVersion');
  assert(!!initResult && initResult.serverInfo && initResult.serverInfo.name === 'cocos-slot-mcp', 'initialize serverInfo.name mismatch');

  const listResult = toolResult(findById(messages, 2));
  const toolNames = (listResult && listResult.tools ? listResult.tools : []).map((t) => t.name).sort();
  const expectedNames = ['asset_refs_check', 'editor_status', 'es5_scan', 'module_triple_check', 'module_triple_wiring_check_live', 'project_map', 'resolve_game', 'scene_batch_node_properties', 'scene_create_node', 'scene_inspect', 'scene_missing_refs_live', 'scene_query_components_catalog', 'scene_query_node_components', 'scene_query_node_tree'];
  assert(JSON.stringify(toolNames) === JSON.stringify(expectedNames), `tools/list names mismatch: ${JSON.stringify(toolNames)}`);
  assertCatalogContracts(toolNames);

  const projectMapResult = toolResult(findById(messages, 3));
  const projectMapOutput = projectMapResult && projectMapResult.structuredContent;
  assert(!!projectMapOutput && projectMapOutput.projects.length === 1, `project_map expected exactly 1 project, got ${JSON.stringify(projectMapOutput)}`);
  const project = projectMapOutput && projectMapOutput.projects[0];
  assert(!!project && project.creatorVersion === '3.7.3', 'project_map creatorVersion mismatch');
  assert(!!project && project.games.some((g) => g.gameId === '9999'), 'project_map did not find fixture game 9999');
  assert(!!project && project.scripts.includes('build'), 'project_map did not report package.json scripts');

  const resolveGameResult = toolResult(findById(messages, 4));
  const resolveGameOutput = resolveGameResult && resolveGameResult.structuredContent;
  assert(!!resolveGameOutput && resolveGameOutput.matches.length === 1, `resolve_game expected exactly 1 match (denylist must exclude node_modules decoy), got ${JSON.stringify(resolveGameOutput)}`);
  assert(!!resolveGameOutput && resolveGameOutput.matches[0].project.creatorVersion === '3.7.3', 'resolve_game ancestor project info mismatch');

  const sceneInspectResult = toolResult(findById(messages, 5));
  const sceneInspectOutput = sceneInspectResult && sceneInspectResult.structuredContent;
  assert(!!sceneInspectOutput && sceneInspectOutput.parsed === true, 'scene_inspect failed to parse fixture scene');
  assert(!!sceneInspectOutput && sceneInspectOutput.nodeCount === 2, `scene_inspect expected nodeCount 2, got ${sceneInspectOutput && sceneInspectOutput.nodeCount}`);
  assert(!!sceneInspectOutput && sceneInspectOutput.totalComponents === 3, `scene_inspect expected totalComponents 3, got ${sceneInspectOutput && sceneInspectOutput.totalComponents}`);

  const assetRefsResult = toolResult(findById(messages, 6));
  const assetRefsOutput = assetRefsResult && assetRefsResult.structuredContent;
  assert(!!assetRefsOutput && assetRefsOutput.resolvedCount === 1, `asset_refs_check expected resolvedCount 1, got ${JSON.stringify(assetRefsOutput)}`);
  assert(!!assetRefsOutput && assetRefsOutput.unresolvedCount === 1, `asset_refs_check expected unresolvedCount 1, got ${JSON.stringify(assetRefsOutput)}`);
  assert(!!assetRefsOutput && assetRefsOutput.unresolved.some((u) => u.ref.startsWith('deadbeef')), 'asset_refs_check did not flag the broken uuid ref');

  const es5ScanResult = toolResult(findById(messages, 7));
  const es5ScanOutput = es5ScanResult && es5ScanResult.structuredContent;
  const foundRules = new Set((es5ScanOutput && es5ScanOutput.findings ? es5ScanOutput.findings : []).map((f) => f.rule));
  const expectedRules = [
    'optional-chaining', 'nullish-coalescing', 'object-from-entries', 'array-flat', 'array-flatmap',
    'string-replaceall', 'promise-allsettled', 'globalthis', 'bigint-literal', 'private-field', 'top-level-await'
  ];
  for (const rule of expectedRules) {
    assert(foundRules.has(rule), `es5_scan missed rule ${rule}; found ${JSON.stringify([...foundRules])}`);
  }
  const bigintFindings = (es5ScanOutput && es5ScanOutput.findings ? es5ScanOutput.findings : []).filter((f) => f.rule === 'bigint-literal');
  assert(bigintFindings.length === 4, `es5_scan expected 4 bigint-literal findings (decimal/hex/octal/binary), got ${bigintFindings.length}`);

  const moduleTripleResult = toolResult(findById(messages, 8));
  const moduleTripleOutput = moduleTripleResult && moduleTripleResult.structuredContent;
  const demoGroup = moduleTripleOutput && moduleTripleOutput.groups.find((g) => g.baseName === 'Demo');
  const badGroup = moduleTripleOutput && moduleTripleOutput.groups.find((g) => g.baseName === 'Bad');
  assert(!!demoGroup && demoGroup.files.Module && demoGroup.files.Data && demoGroup.files.Config, 'module_triple_check Demo group missing a sibling file');
  assert(!!demoGroup && demoGroup.onDestroy.targetOff === true, 'module_triple_check Demo group should detect targetOff(this)');
  assert(!!demoGroup && demoGroup.onDestroy.missing.includes('releaseAll('), 'module_triple_check Demo group should flag missing releaseAll(');
  assert(!!badGroup && badGroup.files.Data === null && badGroup.files.Config === null, 'module_triple_check Bad group should have no Data/Config siblings');
  assert(!!badGroup && badGroup.onDestroy.missing.length === 3, 'module_triple_check Bad group should flag all three missing cleanup calls');
  const noDestroyGroup = moduleTripleOutput && moduleTripleOutput.groups.find((g) => g.baseName === 'NoDestroy');
  assert(!!noDestroyGroup && noDestroyGroup.onDestroy.methodFound === false, 'module_triple_check should not treat a JSDoc mention of onDestroy() as a real declaration');
  assert(!!noDestroyGroup && noDestroyGroup.onDestroy.missing.includes('onDestroy() method'), 'module_triple_check JSDoc-only fixture should report onDestroy() method missing');

  const unknownToolMsg = findById(messages, 9);
  assert(!!unknownToolMsg && !!unknownToolMsg.error && unknownToolMsg.error.code === -32602, `unknown tool should be a JSON-RPC -32602 error, got ${JSON.stringify(unknownToolMsg)}`);

  const invalidArgsMsg = findById(messages, 10);
  assert(!!invalidArgsMsg && !!invalidArgsMsg.error && invalidArgsMsg.error.code === -32602, `invalid gameId should be a JSON-RPC -32602 error, got ${JSON.stringify(invalidArgsMsg)}`);

  const rootEscapeMsg = findById(messages, 11);
  const rootEscapeResult = toolResult(rootEscapeMsg);
  assert(!!rootEscapeResult && rootEscapeResult.isError === true, `root escape should be a tool isError result, got ${JSON.stringify(rootEscapeMsg)}`);
  assert(
    !!rootEscapeResult && rootEscapeResult.content[0].text.includes('escapes project root'),
    `root escape message should mention escaping the project root, got ${JSON.stringify(rootEscapeResult)}`
  );

  const maskedScanResult = toolResult(findById(messages, 12));
  const maskedScanOutput = maskedScanResult && maskedScanResult.structuredContent;
  assert(!!maskedScanOutput && maskedScanOutput.findings.length === 1, `es5_scan masked-violations expected exactly 1 finding (comment/string content must not match), got ${JSON.stringify(maskedScanOutput)}`);
  assert(!!maskedScanOutput && maskedScanOutput.findings[0].rule === 'optional-chaining', `es5_scan masked-violations expected an optional-chaining finding, got ${JSON.stringify(maskedScanOutput)}`);

  const editorResult = toolResult(findById(messages, 13));
  assert(editorResult && editorResult.isError === true, 'editor_status must fail when no Editor bridge is loaded');

  const nodeTreeResult = toolResult(findById(messages, 14));
  assert(nodeTreeResult && nodeTreeResult.isError === true, 'scene_query_node_tree must fail when no Editor bridge is loaded');

  const createNodeResult = toolResult(findById(messages, 15));
  assert(createNodeResult && createNodeResult.isError === true, 'scene_create_node must fail when no Editor bridge is loaded');
  for (const id of [22, 23]) {
    const result = toolResult(findById(messages, id));
    assert(result && result.isError === true, `new live read ${id} must fail when no Editor bridge is loaded`);
  }

  assertNodeComponents(messages);
  assertComponentsCatalog(messages);
  assertBatchProperties(messages);
  assertReviewResults(messages, reviewCases);

  const batchResponse = messages.find((msg) => Array.isArray(msg));
  assert(Array.isArray(batchResponse) && batchResponse.length === 2, `batch request expected a 2-element response array (notification omitted), got ${JSON.stringify(batchResponse)}`);
  const batchListResult = toolResult(findById(messages, 100));
  assert(!!batchListResult && Array.isArray(batchListResult.tools), 'batch tools/list did not return a tools array');
  const batchPingMsg = findById(messages, 101);
  assert(!!batchPingMsg && batchPingMsg.result !== undefined, `batch ping should return a result, got ${JSON.stringify(batchPingMsg)}`);

  const emptyBatchMsg = messages.find((msg) => msg && !Array.isArray(msg) && msg.id === null && msg.error && msg.error.code === -32600);
  assert(!!emptyBatchMsg, `empty batch should return a single Invalid Request error, got ${JSON.stringify(messages)}`);

  const parseErrorMsg = messages.find((msg) => msg && !Array.isArray(msg) && msg.error && msg.error.code === -32700);
  assert(!!parseErrorMsg && parseErrorMsg.id === null, `malformed JSON line should produce a -32700 Parse error with id null, got ${JSON.stringify(parseErrorMsg)}`);

  const liveCounts = await runLiveReadSmoke(projectRoot);
  fs.rmSync(tmpRoot, { recursive: true, force: true });

  if (failures.length > 0) {
    console.error(`SMOKE FAILED (${failures.length}):`);
    for (const failure of failures) console.error(` - ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(`SMOKE OK: ${requests.length + liveCounts.requests} requests, ${session.responses.length + liveCounts.responses} responses, 0 failures.`);
}

main().catch((err) => {
  console.error('SMOKE CRASHED:', err.stack || err.message);
  process.exitCode = 1;
});
