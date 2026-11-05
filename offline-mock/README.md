# Offline Mock Network

A **dev-only** drop-in replacement for `globalThis.GameNetwork` that lets a slot game run
**fully offline** — login, join, normal spins, and features — with **no backend and no real
sockets**. Useful for developing/smoke-testing the UI ↔ slotlib-core pipeline before the BE
exists.

- Core pipeline (`cc-slotbase-core/src/GameNetwork/*`) is **not modified** — the mock duck-types
  what the core calls.
- `GameInit` is **not modified** — wiring is done by a component at runtime.
- When offline is OFF, nothing here runs → **zero regression** to the real network path.

---

## Quick start

1. In the game scene, add the **`OfflineMockBootstrap`** component to an active node (e.g. the
   `GameInit` node) and make sure it is enabled.
2. Turn offline ON with any of:
   - URL param **`?offline=1`**, or
   - the component's **`Force Offline`** checkbox, or
   - config **`OFFLINE_MOCK: true`** (`loadModuleConfigAsync`).
3. Run the scene. Console should show:
   `[OfflineMock] OfflineMockBootstrap ACTIVE — mock network wired, login bypassed`
4. Play. To control the next spin's outcome, in the console:
   ```js
   __setMockScenario('win'); // then press spin — 'lose'/'win'/'jackpot'/'respin'/... work out of the box
   ```
   For `freespin`/`bonus`/`topup`, first assign the sample JSON to the component (see "Loading your
   own data").

If you see `offline OFF (skip)`, offline wasn't detected — add `?offline=1` or tick `Force Offline`.

**Skip the console entirely:** the component's **`Default Scenario`** field (default:
`prototype`) auto-selects that scenario on load, provided a `Sequences` entry with that exact
name was registered (or it's a built-in name like `win`). Swap which JSON is assigned to the
`prototype` entry, re-run, and the first spin already uses it — no `__setMockScenario` needed.
An explicit `?scenario=` URL param always wins over this default.

---

## Scenarios

Set with `__setMockScenario('<name>')` (console), `?scenario=<name>` (URL), or leave it to the
component's `Default Scenario` field (see above). Applies to the **next** normal spin; a
feature then runs to completion and returns to normal.

| Scenario | Result | Source |
|---|---|---|
| `lose` (default) | Normal spin, no win | generated |
| `win` | Normal spin with a line win | generated |
| `freespin` | Free-game feature, runs all spins | **sample JSON** `data/samples/freespin.json` |
| `bonus` | Bonus / mini-game | **sample JSON** `data/samples/bonus.json` |
| `topup` | Top-up free-game | **sample JSON** `data/samples/topup.json` |
| `respin` | Respin feature | procedural (best-guess, **UNVERIFIED**) |
| `lightning` | Lightning feature | procedural (best-guess, **UNVERIFIED**) |
| `gamble` | Gamble feature | procedural (best-guess, **UNVERIFIED**) |
| `jackpot` | Win spin + `jackpot-win` event | generated |
| *custom* | Your JSON (see below) | JsonAsset |

`lose` / `win` / `jackpot` and the procedural features (`respin` / `lightning` / `gamble`) work
out of the box. **`freespin` / `bonus` / `topup` are data-driven** — they need a captured sequence
JSON assigned to the `OfflineMockBootstrap` component under those scenario names (see below).

> **No sample data ships with this repo.** Captured server responses are game-specific and are
> not published here. Capture your own (see *Loading your own data* below) and keep them under
> `data/samples/` — that directory is gitignored. Procedural features have best-guess fields and
> may need in-editor tuning.

---

## Loading your own data (JSON)

Author realistic sequences and load them via the editor — no terminal.

1. Create a `.json` file anywhere under `assets/` (it becomes a Cocos `JsonAsset`).
2. On the `OfflineMockBootstrap` component, add a `Sequences` entry:
   - `Scenario Name` — e.g. `my-freespin`
   - `Json` — drag your `.json` file in
3. Run, then `__setMockScenario('my-freespin')` → spin.

### JSON format

Accepted shapes (auto-normalized):

```jsonc
// tutorial-native (recommended — matches GUI/TrialMode/*.json)
[[
  { "<gameId>": { "data": { /* PS step 0 */ } } },
  { "<gameId>": { "data": { /* PS step 1 */ } } }
]]

// or a raw array of PS steps
[ { /* PS 0 */ }, { /* PS 1 */ } ]

// or a single PS object (a 1-step normal spin)
{ /* PS */ }
```

### Custom join-game response

To override what join returns (bet ladder, starting wallet, currency, jackpot, promotion…),
assign a JSON to the component's **`Join Data`** slot. Template: `data/samples/join.json`.

```json
{
  "exD": {
    "mb": "1;1000,2;2000,3;5000,4;10000,5;25000,6;50000",
    "metaDataUser": { "currentWalletAmount": 9780000 }
  }
}
```
- `exD.mb` = bet ladder `"key;total,..."` (betKey = first char). `exD.metaDataUser.currentWalletAmount`
  = starting balance; the mock syncs its wallet to this so the first spin's math is correct.
- `cId` is set automatically. Optional: `exD.eb` (extra bet), `exD.ec` (`"c:vnd#v:1"` — only add if
  the currency is in the game's `CURRENCY_CONFIG`), `jp` (jackpot), `mDP` (promotion), `dataResume`.
- Accepts a plain object, `{ "<gid>": { "data": {…} } }`, or a `[[ … ]]` wrapper.
- **A custom `exD.mb` also becomes the ladder the mock deducts from.** Changing the bet
  levels here is not just cosmetic: every internal "how much does this bet cost" lookup
  (`_totalBet()` in `mock-response-engine.ts`) reads this same ladder once it is registered,
  instead of the built-in default. So the UI-visible bet levels and the amount actually taken
  out of the wallet never disagree with each other.

### Custom spin sequences

A **sequence = one play session**. Put your own captured sequences in `data/samples/`
(gitignored, nothing ships here) — e.g. `freespin.json`, `bonus.json`, `topup.json` for the
multi-step features, `normal-win.json` for a 1-step case. Assign them in the component
(e.g. name `freespin` → `freespin.json`). The format is documented below.

**Advancing a multi-step sequence:** once `__setMockScenario('<name>')` + a Spin starts it,
the sequence stays active until its last step (`isF: "T"`). While active, **both** an
automatic feature-continuation request from the client **and a manual re-click of Spin**
serve the *next* step — a manual re-Spin does **not** restart the sequence from step 0.
Only the step that *starts* the sequence deducts a bet; every step after that is free (same
as a real feature spin). This only applies to a registered custom sequence (`Sequences` /
the built-in samples) — the procedural `respin`/`lightning`/`gamble` scenarios are unaffected
and still only advance on the client's own feature-continuation request.

**A pool of independent single spins (round-robin), instead of one multi-step round:** when
**every** step in a registered sequence has `isF: "T"` (none in the middle is `"F"`), the
mock treats it as a *pool* of standalone spins rather than one feature round — each manual
Spin deducts a bet and serves the **next entry** in the file, wrapping back to the first
after the last (a separate pointer per scenario name, so switching scenarios does not lose
your place). This is for authoring many independent test outcomes (e.g. one entry per
simulated cascade result) that you want to click through one at a time — not a multi-step
feature. Give the last step `isF: "F"` instead of `"T"` if you actually meant a multi-step
feature round; a pool with only one entry behaves like an ordinary 1-step sequence.

Like `cId`, the mock **overwrites `id` and `v` on every entry it serves** from a pool — each
entry starts a brand-new play session, so it always gets a fresh `id` and `v: 1` regardless
of what the file says. Do not hand-craft these as one continuous sequence with a shared `id`
and an incrementing `v` (1, 2, 3…) across entries — that shape is for a real multi-step
feature (see the invariants table below), and if it were left as-is on a pool the core's
`GameStateManager` would see `version > 1` on what it treats as a brand-new spin and kill the
session with "Data sync error" (`MISMATCH_DATA_VERSION`) starting on the second Spin.

**Win amounts scale to whatever bet is currently selected**, using the step's own `bId` as
the bet it was captured/authored at: if `bId`'s ladder key differs from the bet the player
has selected for this Spin, the mock multiplies `wa` (and `wat`, and every amount inside
`pl`) by `currentBet / baseBet` before serving the step. This means one authored file plays
correctly no matter which bet level is active, instead of always paying out the exact amount
it happened to be written for. A step with no `bId`, or a `bId` whose first character is not
a key in the active ladder (see "Custom join-game response" above), is served **unscaled** —
the mock refuses to guess a base it cannot resolve rather than silently produce a wrong
amount; a console warning names the offending `bId` when this happens.

### Invariants you MUST keep

| Field | Rule |
|---|---|
| `id` | **Same value for every step** of the sequence |
| `v` | **1, 2, 3 … N** (increment by exactly 1) — the core DIEs on a version gap |
| last step | `isF: "T"` and `ac: "1"` (return to normal game) |
| feature step | `ac` = next mode: `2` free, `4` bonus, `5` lightning, `7` gamble, `8` respin; `isF: "F"` |
| `cId` | anything — the mock **overwrites** it per request |
| `bId` | the bet level this step's `wa`/`pl` were written for — drives the win-scaling above; omit it to opt out of scaling |
| `wa` | per-step win amount; the mock credits the wallet from this (after scaling, if `bId` applies) |
| `wallet` | **ignored** — the mock drives balance itself (put anything) |
| `mx` / `pl` / `s0` | the visual data (reels / paylines / scatter) — this is where "realistic" matters |

A normal single spin = a 1-step sequence with `isF: "T"`, `ac: "1"`.

---

## How it works

- **Network selection:** `OfflineMockNetwork.create()` sets `globalThis.GameNetwork = mock`.
  Core reads this at runtime (`connectNetwork.setGameNetwork`, `NetworkBridge`), so join/spin
  use the mock without editing `GameInit` (whose module-const is only a fallback).
- **Login bypass:** the bootstrap monkey-patches `eno.connectNetwork` (the same instance
  `GameInit` uses) so `loginScene` immediately calls its callback — no real auth/socket.
- **Request → response contract** (short-param, `useShortParam=true` always):
  - `executeCommand` returns a `cId`, fires the ACK `COMMAND_SEND_SUCCESSFULLY {cId}`, then the
    router dispatches the state event(s).
  - Every response's `cId` equals that request's command id (the core verifies it).
  - `waitForEvent` waiters are resolved **before** handlers (verify reads state the handlers
    clear).
  - Responses use short keys (`cId`, `v`, `mx`, `pl`, `wa`, …); the core expands them via
    `mapObjectKey`.

---

## Files

| File | Role |
|---|---|
| `OfflineMockBootstrap.ts` | **The only thing you add to a scene.** Wires the mock, bypasses login, loads custom data. |
| `OfflineMockNetwork.ts` | Factory — builds the mock network object + hub; owns `globalThis.GameNetwork`. |
| `MockCommandManager.ts` | `executeCommand` → cId + ACK. |
| `MockEventManager.ts` | `registerEvent` / `onEvent` / `waitForEvent` (waiters before handlers). |
| `MockMessageManager.ts` | `registerGame` → `onConnected`; socket no-ops. |
| `MockPlayerInfoStateManager.ts` | Wallet balance, fake identity, `wallet-updated` listener. |
| `mock-response-engine.ts` | Builds join + spin PS; owns feature state (replay + procedural). |
| `mock-response-router.ts` | Schedules dispatch of the engine's events + applies wallet. |
| `mock-sequence-format.ts` | `normalizeSequence` — parses authored JSON into PS steps. |
| `mock-feature-builders.ts` | Procedural respin/lightning/gamble + jackpot-win (best-guess). |
| `mock-scenario.ts` | Scenario read/set. |
| `mock-config.ts` | Bet ladder, wallet, symbol pool, timings. |
| `reel-generator.ts` | Random matrix. |
| `mock-hub.ts`, `mock-uuid.ts`, `mock-log.ts` | Shared hub, uuid, logger. |
| `data/samples/*.json` | **Your** captured sequences (gitignored; none shipped). |

---

## Limitations / notes

- Defaults in `mock-config.ts` (symbol pool, bet ladder, timings) were tuned against one
  slot-game family in VND. Another game will likely need different values — sequences can be
  captured from that project's own `GUI/TrialMode/*.json`.
- **Procedural features** (respin / lightning / gamble) and the **jackpot-win** amount key are
  best-guess (no captured template) — verify/tune in-editor for your game.
- Payline/win only need to be **UI-valid, not RTP-correct**.
- This is a **dev tool**: it is runtime-guarded (off = inert) but still compiled into the bundle.
  Strip it from production release builds if bundle size matters.
