# cocos-slot-mcp-server

Zero-dependency MCP server for repeated Cocos Creator slot-game inspection
tasks in a Cocos Creator slot-game repo. Node `>=20`, ESM, no npm install required (no
runtime dependencies, no build step, no lockfile). Thirteen of fourteen tools are
read-only; `scene_create_node` is the single opt-in write tool, disabled by
default (see "Optional live Editor connection").

- Filesystem-first MCP server. It never runs Git, writes project assets, or
  launches the Cocos Editor. Nine tools inspect saved files. Four tools
  (`editor_status`, `scene_query_node_tree`, `module_triple_wiring_check_live`,
  `scene_missing_refs_live`) query a companion extension read-only. A fifth live
  tool (`scene_create_node`) can create a node in an already-open Editor scene,
  only when the project owner explicitly enables write mode; it never saves
  the `.scene` file. The extension writes discovery and write-audit files in `temp/`.
- Stdio is the default transport for MCP clients that own process lifecycle.
- An optional loopback-only HTTP daemon is available for clients that connect to
  a persistent local endpoint; it uses the same protocol dispatcher and tools.
- Generic: no hardcoded game ids or project-specific paths. Project/profile
  and game discovery are heuristic (package.json + `assets/` sibling for
  project roots; `-<4 digits>` directory-name suffix for game dirs).

## Transport
### Stdio (default)

Newline-delimited JSON-RPC 2.0 over stdin/stdout. The client owns the process
lifecycle: spawn, write requests to stdin (one JSON object per line, no embedded
newlines), read responses from stdout, then close stdin or send SIGTERM. `stdout`
carries only protocol frames; diagnostics go to `stderr`.

### Loopback HTTP daemon

Start a persistent daemon:

```bash
node src/index.js --http --root /absolute/path/to/repo --port 9750
```

It listens on `http://127.0.0.1:9750/mcp`. Send one JSON-RPC request or batch per
`POST`; the response is one JSON body. `GET /health` provides liveness. The daemon
binds to `127.0.0.1` only, has no write or arbitrary-file endpoint, and reuses the
same `handleRequest` dispatcher as stdio. It does not require the Cocos Editor.

Supports the legacy `initialize` handshake plus `tools/list` and
`tools/call`. A line may also be a JSON-RPC batch (a top-level JSON array of
request/notification objects, per JSON-RPC 2.0 §6): each item is dispatched
independently and the results are returned as a single JSON array on one
output line, in item order, with notification results omitted; an empty
batch (`[]`) returns a single `Invalid Request` (`-32600`) error. A line that
fails to parse as JSON returns `{"jsonrpc":"2.0","id":null,"error":{"code":
-32700,"message":"Parse error"}}` on stdout (diagnostics for it still go to
stderr). Unknown JSON-RPC methods, unknown tool names, and schema
violations return a JSON-RPC error (`isError`-style tool failures are
reserved for business failures like a path escaping the project root,
i.e. failures that happen *while executing* an otherwise valid call).

## Startpoint

`POST http://127.0.0.1:9750/mcp` is the single entry point for all 14 tools
(9 filesystem-only, 5 live Editor; 13 read-only, 1 opt-in write) once the HTTP
daemon is running — there is no second endpoint to remember. Two independent
things feed that one endpoint, and
only one of them needs a manual step:

1. **HTTP daemon (manual, once per machine reboot)** — this repo's server process. Recommended as a managed, auto-restarting process:
   ```
   hub start name=cocos-mcp-http application=node \
     args=["<cocos-slot-mcp>/server/src/index.js","--http","--root","<repo-root>","--port","9750"] \
     restart=on-failure ready={"log":"listening on","port":9750}
   ```
   or run it directly: `node <cocos-slot-mcp>/server/src/index.js --http --root "$(pwd)" --port 9750`.
2. **Companion Editor extension (automatic, no manual step)** — the five live
   tools call
   `v373/cc30-new-all-in-one/extensions/cc30-mcp-server-extension/`, which
   Cocos Creator loads on its own whenever that project is opened in the Editor.
   Nothing needs to be clicked or started for this half.

All five live tools return `isError` (not a silent fallback) whenever the
Editor extension is not loaded — the daemon itself has no dependency on the
Editor being open, so the other 9 tools keep working either way. The two live
audits require the updated companion extension (0.4.1 or later).

## Root resolution

1. `--root <absolute path>` argv flag (highest priority)
2. `CLAUDE_PROJECT_DIR` environment variable (Claude Code sets this on the
   spawned server process)
3. `process.cwd()`

The resolved root is `realpath`-ed once at startup. Every tool path
argument is re-resolved through the same `resolveInRoot` chokepoint
(`src/root.js`): `realpath` first, then a prefix check against the root, so
a symlink inside the project that points outside it cannot escape the
check. Paths under `.git/`, `node_modules/`, common build/generated
directories (`dist`, `dist-prod`, `build`, `library`, `temp`, `out`), and
any path segment matching `core-lib` (the compiled Layer-1 bundle
convention in this repo, matched generically by name rather than a
hardcoded path) are rejected regardless of the flag used to reach them.

## Output limits

Every tool bounds its own output: capped file/dir traversal (depth and
visited-node ceilings), capped result lists (e.g. 200 findings, 25 project
roots, 200 unresolved asset refs), and a `*Truncated` boolean whenever a
cap was hit. No tool ever dumps a whole scene/prefab file.

## Tool catalog

| Tool | Required args | Purpose |
|---|---|---|
| `project_map` | — | Discover Cocos project roots (package.json + `assets/` sibling), creator version, actual npm scripts, and bounded game-like subdirectories per project. |
| `resolve_game` | `gameId` (`^[0-9]{4}$`) | Find every directory under root whose name ends in that 4-digit id. Returns all matches with nearest-ancestor project info; never guesses. |
| `scene_inspect` | `scenePath` | Parse a `.scene`/`.prefab` JSON file (array or object root), report node/component counts, bounded node names/paths, and parse errors. |
| `asset_refs_check` | `scenePath` | Collect `__uuid__` refs in a scene/prefab and report which ones cannot be resolved against the `.meta` asset index of the owning project (handles both canonical and Cocos-compressed uuid forms; see `src/uuid.js`). |
| `es5_scan` | `path` | Recursively scan `.ts/.tsx/.js/.jsx` files for `?.`, `??`, `Object.fromEntries`, `.flat(`/`.flatMap(`, `.replaceAll(`, `Promise.allSettled(`, `globalThis`, top-level `await` (heuristic), private `#fields`, and BigInt literals. |
| `module_triple_check` | `modulePath` | Given a `*Module.ts` file or a directory, group sibling `Module`/`Data`/`Config` files by base name + trailing digits, and report `onDestroy()` cleanup evidence (`targetOff(this)`, `releaseAll(`, `super.onDestroy()`). |
| `scene_query_node_components` | `scenePath`, exactly one of `nodePath` / `nodeUuid` | **Read-only, no Editor required.** Extract serialized component summaries for one node in a saved `.scene`/`.prefab`. Optional `projectPath`, `maxComponents` (default 50, clamped 1–200); up to 32 scalar fields per component, strings capped at 256 characters, with truncation indicators. |
| `scene_query_components_catalog` | `scenePath` | **Read-only, no Editor required.** Catalog component references from a saved `.scene`/`.prefab`, sorted by full type then serialized node/component order, without component payloads. Optional `projectPath`, `typeFilter` (case-insensitive substring), `maxResults` (default 200, clamped 1–1000); reports total matches and result truncation. Identity strings/path segments cap at 256 characters, final node paths at 4096; per-entry and aggregate `identityTruncated` flags report clipping independently of result truncation. |
| `scene_batch_node_properties` | `scenePath`, `nodes` (each exactly one of `nodePath` / `nodeUuid`) | **Read-only, no Editor required.** Read safe properties from a saved `.scene`/`.prefab`, preserving selector order and per-node errors. Optional `projectPath`, `properties` (first 50; defaults to name, active, position, rotation/quaternion, scale, layer), `maxNodes` (default 100, clamped 1–500). Only bounded primitives and small numeric vectors/colors; no internal references or deep objects. |
| `editor_status` | `projectPath` | Check live Editor project identity through the companion extension. Requires Editor; no scene access or writes. |
| `scene_query_node_tree` | `projectPath` (optional `rootUuid`) | Read the live scene node hierarchy (uuid, name, path, parent/child links) through the companion Editor extension. Requires Editor; no scene mutation or save. |
| `module_triple_wiring_check_live` (R2) | `projectPath` | **Read-only, Editor required.** Audit live `*Module<digits>` components that provably call `getComponent()` on a compatible `Config` identifier in their own class source — naming alone is never evidence, so framework modules without that call are skipped (`skipped[]`), not flagged. Optional `gamePath` (relative to server root, not projectPath), `includeCommon` (default true), `maxNodes` (default 400, clamped 1–1000). Among audited modules: missing Config on the node → error; missing Data class → warn; healthy triples are counted, not findings. Unresolved CIDs stay separate, never guessed. No per-game whitelist. |
| `scene_missing_refs_live` (R3) | `projectPath` | **Read-only, Editor required.** Walk bounded live component properties and resolve asset UUIDs through the Editor asset database. Optional `rootUuid`, `maxNodes` (default 400, clamped 1–1000), `maxRefs` (default 1000, clamped 1–5000). Returns `scannedNodes`, `scannedRefs`, `missing`, `truncated`; never follows `__id__` links or saves scenes. |
| `scene_create_node` | `projectPath`, `parentUuid`, `name`, `confirm:true` | **WRITE** — the only write tool in this server. Creates ONE empty node live in the open Editor scene via `create-node` IPC. Disabled unless the project owner creates a `.mcp-control/mcp-write-enabled` sentinel file in the Cocos project; the agent cannot enable it. Never saves the scene; the change is undoable with Ctrl+Z in the Editor. See "Optional live Editor connection". |

Full JSON Schemas are declared in each `src/tools/*.js` module and served
verbatim via `tools/list`.

The three saved-scene queries above read files on disk only: they do not reflect
unsaved Editor changes. Paths include the serialized scene root name; UUID
selectors match the serialized node `_id`. `scenePath` is relative to optional
`projectPath` (or the server root), or absolute within that scope. `projectPath`
must be a directory, and the resolved `scenePath` must be a regular `.scene` or
`.prefab` file inside it; arbitrary JSON files and scope escapes are rejected.
Component `scriptUuid` uses explicit `_script.__uuid__` when present, otherwise
only canonical, 32-hex, or Cocos 22/23-character UUID/CID encodings; named plugin
types return `null`. Truncated catalog identities are display-only and may not
be unique or usable as exact selectors. Aggregate identity truncation describes
returned entries, not omitted matches. None of these three tools requires the
companion extension (`editorRequired: false`).

R2 searches only supplied `gamePath` and, unless disabled, `projectPath/assets/cc-common`.
It does not infer a game or prove runtime inheritance/initialization. Numeric suffix
compatibility allows the same suffix or an unsuffixed class, not another game's
suffix. `registeredKeysCount` is a provable literal string-array initializer count
or `null`; it is not a runtime key count. Each finding carries node identity and
expected Config; a missing Config and Data can produce two rows for one Module.
`scanned.healthyModuleComponents` counts healthy modules. Source reads and findings
are bounded; `truncated:true` means the audit is incomplete, not clean.

R3 preserves each distinct node/component/property/asset occurrence while querying
each unique asset UUID once (100 UUIDs per asset request, 10 nodes per node request).
`missing` rows include `nodeUuid`, `nodePath`, `componentName`, `propertyPath`,
`assetUuid`, `expectedType`; unavailable names/types stay `null`. `__id__` objects
are excluded entirely. The updated bridge projects at most 32 components/node,
64 entries/object, depth 12, and 256 visited values/component; it caps node responses
at 245760 bytes and reports truncation. Bridge truncation propagates to R3. Missing
property support, failed asset queries, or incomplete asset statuses produce
`isError`, never an empty successful audit. A zero missing count with truncation is
not evidence of a clean whole scene.



## Registration

### Global MCP config (`mcp.json`)

The global registration owns the server code while `--root` selects the active
project. It registers the process-owned stdio entry and the independent graph server:

```json
{
  "mcpServers": {
    "cocos-slot": {
      "type": "stdio",
      "command": "node",
      "args": [
        "<cocos-slot-mcp>/server/src/index.js",
        "--root",
        "${CLAUDE_PROJECT_DIR:-.}"
      ],
      "timeout": 30000
    },
    "codebase-memory-mcp": {
      "type": "stdio",
      "command": "codebase-memory-mcp",
      "args": []
    }
  }
}
```

Start the optional persistent HTTP daemon from any project root:

```bash
node <cocos-slot-mcp>/server/src/index.js \
  --http --root "$(pwd)" --port 9750
```

The HTTP endpoint binds to loopback only. Keep `cocos-slot` for clients that
spawn stdio processes; use the HTTP endpoint only for clients that connect to
the already-running daemon.

The `codebase-memory-mcp` entry requires the installed executable. Keep it
separate from `cocos-slot`: the Cocos server performs bounded filesystem
inspection, while codebase-memory owns the indexed knowledge graph and call-graph tools.


### Claude Code project config (`.mcp.json` at repo root)

Use the same two entries when registering MCP servers for Claude Code. The
project-scoped file requires approval on first use; this global setup does
not create it automatically. `${CLAUDE_PROJECT_DIR}` has no default outside a
running Claude Code session, so use the `${CLAUDE_PROJECT_DIR:-.}` form or an
absolute `--root` for other clients.

The `codebase-memory-mcp` entry requires the executable to be installed and
available on `PATH`. If it is unavailable, Cocos inspection remains usable and
the `cbm-*` commands must fall back to ordinary source search rather than
claiming graph evidence.

## Portability to another project

Use the global server path `<cocos-slot-mcp>/server/`
and point `--root`/`CLAUDE_PROJECT_DIR` at the target repo. No install step,
no lockfile, and no project-specific configuration inside the server itself —
discovery is generic (package.json + `assets/`, `-<4 digits>` game-dir suffix).

## Development

```bash
# syntax-check every module
find src -name '*.js' -exec node --check {} \;

# fixture-based protocol smoke test (writes a throwaway project tree
# under the OS temp dir, outside this repository, spawns the server
# against it, and exercises initialize/tools-list/tools-call plus the
# unknown-tool / invalid-args / root-escape error paths)
npm run smoke
```

## Optional live Editor connection

Nine filesystem tools work without Editor. The five live tools (`editor_status`,
`scene_query_node_tree`, `module_triple_wiring_check_live`, `scene_missing_refs_live`,
`scene_create_node`) additionally call the companion
`v373/cc30-new-all-in-one/extensions/cc30-mcp-server-extension/`
package inside Cocos Creator 3.7.3. Load/reload it in that project's
Extension Manager. Do not run its `main.js` with standalone Node: it needs
`Editor.Project`.

The extension binds an OS-assigned loopback port and publishes connection
details in `<project>/temp/mcp-editor-server.json` with owner-only
permissions. It exposes six authenticated routes; browser Origin
headers are rejected on all of them:

- `GET /health` — liveness plus `writeEnabled: <bool>` (see below).
- `GET /scene/node-tree` — read-only, accepts `?projectPath=<path>` (must
  match the bridge's own project) and an optional `?rootUuid=<uuid>` to
  scope the query to a subtree, and returns bounded node summaries
  (`{uuid, name, path, parentUuid, childUuids, childCount}`, capped at 2000
  nodes and depth 50, with a `truncated` flag).
- `GET /scene/node` — bounded node/component summaries and safe serialized
  property projection, with component/property/response truncation indicators.
- `GET /scene/component-catalog` — bounded registered component CID/name catalog;
  unresolved names remain unresolved rather than inferred.
- `GET /asset/info` — read-only asset database lookup for at most 100 distinct
  UUIDs per request; returns `{requested, resolved, truncated, results}` with
  `{uuid, exists, url, type}` rows. Supports `@subasset` UUID suffixes.
- `POST /scene/create-node` — the only write route (see below).

No save, build, or reload endpoint is provided anywhere in the extension.
Unload closes the listener and removes its own discovery file. This
internal HTTP route is not MCP.

### Write gate for `scene_create_node`

Write access is **off by default** and cannot be turned on by an agent or
MCP client over HTTP. The project owner enables it by creating an empty
sentinel file:

```bash
mkdir -p v373/cc30-new-all-in-one/.mcp-control
touch v373/cc30-new-all-in-one/.mcp-control/mcp-write-enabled
```

The extension checks this file fresh on every request (never cached), so
removing it turns writes back off immediately without reloading the
extension. `GET /health` reports the live state as `writeEnabled: <bool>`.

When enabled, `POST /scene/create-node` still requires, in order: `confirm:
true` in the JSON body (413/415 first for an oversized or non-JSON body,
400 if `confirm` is missing or the shape is invalid), a rate limit of at
most one node every 2 seconds and 20 nodes per Editor `load()` session
(`429` past either limit), the scene being ready and not dirty unless
`allowDirty: true` was sent (`409 scene_not_ready` / `409
scene_has_unsaved_changes`), and the `parentUuid` resolving to a real node
via `query-node` (`404 parent_not_found`). Only then does it call
`Editor.Message.request('scene', 'create-node', { parent, name, position,
nameIncrease, snapshot: true })` — never a hand-rolled `new Node()` — so
the new node goes through the Editor's node manager, undo stack, and
Hierarchy panel refresh like any manually created node. The scene is never
saved by this tool; the node exists only in the Editor's in-memory scene
until the user saves or discards it. Every attempt (success or failure) is
appended to `<project>/temp/mcp-write-audit.log` (mode `0600`, capped at 1
MiB with truncate-and-restart, token never logged).

The successful response is exactly `{uuid, path, undoable: true,
sceneSaved: false}` — `uuid` and `path` (Editor-computed, from the
post-create tree walk) identify the new node, `undoable: true` reflects
that `snapshot: true` was passed to `create-node`, and `sceneSaved: false`
is an explicit reminder that nothing was written to disk.

The MCP tools accept a project directory within the configured root. They
read only the fixed discovery file (a narrow exception to the
generated-directory denylist), reject symlinks, check project/instance
identity, and bound each HTTP request to five seconds. Health responses cap at
8 KiB; tree/R3 responses at 256 KiB; R2 catalog/node responses at 4 MiB;
`POST /scene/create-node` bodies at 4 KiB.
Tokens are not returned in tool output. Missing, obsolete, unreachable, or mismatched bridges
return `isError`, not a connected fallback.

Example requests to the external server's `POST /mcp`:

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"editor_status","arguments":{"projectPath":"v373/cc30-new-all-in-one"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"scene_query_node_tree","arguments":{"projectPath":"v373/cc30-new-all-in-one"}}}
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"module_triple_wiring_check_live","arguments":{"projectPath":"v373/cc30-new-all-in-one","gamePath":"v373/cc30-new-all-in-one/assets/cc-release-slot/cc30-mygame-1001","maxNodes":100}}}
{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"scene_missing_refs_live","arguments":{"projectPath":"v373/cc30-new-all-in-one","maxNodes":100,"maxRefs":200}}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"scene_create_node","arguments":{"projectPath":"v373/cc30-new-all-in-one","parentUuid":"<uuid-from-scene_query_node_tree>","name":"MCPProbe","confirm":true}}}
```

After code changes, restart the external MCP process to refresh its tools. A host
with a cached tool catalog may also need to reconnect. Deleting extension files
does not unload code already running inside Editor; use Extension Manager to
reload/unload it. A response from an old listener is not proof the new bridge loaded.

