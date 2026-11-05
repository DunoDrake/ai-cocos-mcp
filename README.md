# cocos-slot-mcp

Two tools for working on **Cocos Creator slot games** with an AI coding agent:
an MCP server that inspects the project, and an offline mock that lets the game
run with no backend.

They are independent — use either on its own.

| Directory | What | Runs where |
|---|---|---|
| [`server/`](server/) | MCP server. 14 tools for project/scene/prefab inspection. Zero dependencies, no build step, no lockfile. | Node >= 20, outside the editor |
| [`offline-mock/`](offline-mock/) | Mock network layer. Replays captured spin sequences so a slot scene runs without a server. | Inside the game, as Cocos scripts |

---

## `server/` — MCP inspection server

Filesystem-first. It never runs Git, never writes project assets, never
launches the editor. Nine tools read saved files; five talk to a companion
editor extension. **Thirteen of fourteen are read-only** — `scene_create_node`
is the only writer, and it is off unless you explicitly enable write mode.

### Tools

Saved-file tools (no editor needed):

| Tool | Reads |
|---|---|
| `project_map` | Candidate project roots, creator version, profile |
| `resolve_game` | A 4-digit game id → matching game directories |
| `scene_inspect` | A saved `.scene` / `.prefab` |
| `asset_refs_check` | `__uuid__` refs that resolve to nothing |
| `es5_scan` | Source constructs banned by an ES5-safety rule |
| `module_triple_check` | A Module/Data/Config group: naming + `onDestroy` cleanup |
| `scene_query_node_components` | Serialized components of one node |
| `scene_query_components_catalog` | Component catalog of a scene/prefab |
| `scene_batch_node_properties` | A bounded batch of nodes |

Live tools (need the companion editor extension loaded):

| Tool | Does |
|---|---|
| `editor_status` | Is the bridge up for this project |
| `scene_query_node_tree` | Live node hierarchy |
| `module_triple_wiring_check_live` | Module ↔ Config ↔ Data wiring on live components |
| `scene_missing_refs_live` | Missing asset UUIDs on live components |
| `scene_create_node` | **Write, opt-in.** Creates one empty node; never saves the `.scene` |

Every live tool returns `isError` when the extension is not loaded — it never
falls back silently to stale file data.

### Run it

```bash
# stdio — what most MCP clients want
node server/src/index.js --root /path/to/your/cocos/repo

# or a loopback-only HTTP daemon
node server/src/index.js --http --root /path/to/your/cocos/repo --port 9750
```

Register with an MCP client:

```json
{
  "mcpServers": {
    "cocos-slot": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/absolute/path/to/cocos-slot-mcp/server/src/index.js",
        "--root",
        "${CLAUDE_PROJECT_DIR:-.}"
      ],
      "timeout": 30000
    }
  }
}
```

Smoke test (54 requests, no network, no project needed):

```bash
cd server && npm run smoke
```

Discovery is heuristic and generic — project roots from `package.json` + a
sibling `assets/`, game directories from a `-<4 digits>` name suffix. No game
ids or project paths are hardcoded.

Full detail: [`server/README.md`](server/README.md).

---

## `offline-mock/` — run a slot game with no backend

Drop `OfflineMockBootstrap` on a node in your scene, and the game joins, spins
and pays out against a mock instead of a real server. Useful for UI work,
cutscene timing, and reproducing a specific feature outcome on demand.

```
?offline=1              enable the mock
?scenario=freespin      pick what the next spin does
```

Scenarios `lose` / `win` / `jackpot` and the procedural ones (`respin`,
`lightning`, `gamble`) are generated and work out of the box. `freespin`,
`bonus` and `topup` are **data-driven** — they replay a captured sequence you
supply.

### This is not drop-in generic

The mock owns `globalThis.GameNetwork` and monkey-patches the game's
`connectNetwork` to bypass login. It expects a host framework that exposes
`eno.connectNetwork`, `eno.getUrlParam` and `eno.logger`, plus a
`GameInit` / `NetworkBridge` pair that resolve the network off `globalThis`.
On a different codebase you will have to rewrite those seams — read
[`offline-mock/README.md`](offline-mock/README.md) before assuming it fits.

### No captured data ships here

`offline-mock/data/` and `offline-mock/template/` are gitignored. Captured
server responses are specific to one game and are not published. Capture your
own; the sequence format is documented in the mock's README.

Defaults in `mock-config.ts` (symbol pool, bet ladder, timings) were tuned
against one slot-game family in VND — expect to change them.

It is a dev tool: runtime-guarded (off = inert), but still compiled into the
bundle. Strip it from production builds if size matters.

---

## License

MIT — see [LICENSE](LICENSE).
