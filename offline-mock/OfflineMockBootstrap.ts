import { _decorator, Component, JsonAsset } from 'cc';
import { OfflineMockNetwork } from './OfflineMockNetwork';
import { getMockHub } from './mock-hub';
import { normalizeSequence, normalizeJoin } from './mock-sequence-format';
import { mockLog, mockWarn } from './mock-log';
import { setScenario, ALL_SCENARIOS, MockScenario } from './mock-scenario';

const { ccclass, property, executionOrder } = _decorator;

/** One custom scenario = a name + a JSON file (drag-drop in the editor). */
@ccclass('MockSequenceEntry')
export class MockSequenceEntry {
    @property({ tooltip: 'Scenario name — use with __setMockScenario("name") or ?scenario=name' })
    scenarioName: string = '';

    @property({ type: JsonAsset, tooltip: 'Sequence JSON (short-param PS steps; tutorial or raw format)' })
    json: JsonAsset = null;
}

/**
 * Zero-touch offline mock wiring — no code edit to GameInit. Put this component on any active
 * node in the game scene (e.g. the GameInit node) and enable it.
 *
 * In onLoad (before GameInit.start() -> connect()) it:
 *  1. OfflineMockNetwork.create() -> sets globalThis.GameNetwork = mock (core reads it at runtime
 *     in connectNetwork.setGameNetwork + NetworkBridge, so join/spin use the mock).
 *  2. Monkey-patches eno.connectNetwork (the SAME instance GameInit destructured) so loginScene
 *     immediately calls its callback -> no real auth / socket. This is the deterministic bypass;
 *     it does NOT rely on tokens or IS_FINISHED_REMOTE.
 *  3. Registers any custom JSON sequences.
 * When offline is OFF this component is inert (real network, 0 regression).
 */
@ccclass('OfflineMockBootstrap')
@executionOrder(-9999)
export class OfflineMockBootstrap extends Component {
    @property({ tooltip: 'Force offline even without ?offline=1 / OFFLINE_MOCK config' })
    forceOffline: boolean = false;

    @property({ type: [MockSequenceEntry], tooltip: 'Optional custom mock sequences (your JSON)' })
    sequences: MockSequenceEntry[] = [];

    @property({
        tooltip: 'Auto-select this scenario on load if a Sequences entry with this exact '
            + 'name was registered (or it is a built-in scenario) — skips typing '
            + '__setMockScenario(...) in console. Leave empty to require manual selection.',
    })
    defaultScenario: string = 'prototype';

    @property({ tooltip: 'Override the join-game response with custom JSON (else: default join)' })
    useCustomJoin: boolean = false;

    @property({
        type: JsonAsset,
        visible(this: OfflineMockBootstrap): boolean {
            return this.useCustomJoin;
        },
        tooltip: 'Custom join-game response JSON',
    })
    joinData: JsonAsset = null;

    onLoad(): void {
        if (!this._isOffline()) {
            mockLog('OfflineMockBootstrap: offline OFF (skip). Use ?offline=1 or tick Force Offline.');
            return;
        }
        OfflineMockNetwork.create(); // globalThis.GameNetwork = mock
        this._bypassLogin();
        this._loadJoin();
        const registered = this._loadSequences();
        this._applyDefaultScenario(registered);
        mockLog('OfflineMockBootstrap ACTIVE — mock network wired, login bypassed');
    }

    private _isOffline(): boolean {
        if (this.forceOffline) {
            return true;
        }
        const eno: any = (globalThis as any).eno;
        if (eno && eno.getUrlParam && eno.getUrlParam('offline') === '1') {
            return true;
        }
        const cfg = this._config();
        return !!(cfg && cfg.OFFLINE_MOCK);
    }

    /** Replace core login with an instant success so no real auth/socket runs. */
    private _bypassLogin(): void {
        const eno: any = (globalThis as any).eno;
        const cn = eno && eno.connectNetwork;
        if (!cn) {
            mockWarn('eno.connectNetwork not found — cannot bypass login');
            return;
        }
        cn.setGameNetwork = (): void => { /* mock already on globalThis */ };
        cn.loginScene = (opts: any): void => {
            setTimeout(() => {
                if (opts && typeof opts.callback === 'function') {
                    opts.callback();
                }
            }, 0);
        };
    }

    private _loadJoin(): void {
        if (!this.useCustomJoin || !this.joinData) {
            return; // not enabled -> default join
        }
        try {
            const data = normalizeJoin(this.joinData.json);
            if (data) {
                getMockHub().engine.registerJoin(data);
                mockLog('registered custom join-game response');
            }
        } catch (e) {
            mockWarn('OfflineMockBootstrap: invalid join JSON');
        }
    }

    /** Returns the scenario names actually registered (skips missing/invalid entries). */
    private _loadSequences(): Set<string> {
        const registered = new Set<string>();
        let hub: any;
        try {
            hub = getMockHub();
        } catch (e) {
            return registered;
        }
        this.sequences.forEach((entry) => {
            if (!entry || !entry.scenarioName || !entry.json) {
                return;
            }
            const steps = normalizeSequence(entry.json.json);
            if (steps.length === 0) {
                mockWarn('OfflineMockBootstrap: empty/invalid JSON for', entry.scenarioName);
                return;
            }
            hub.engine.registerSequence(entry.scenarioName, steps);
            registered.add(entry.scenarioName);
            mockLog('registered custom scenario', entry.scenarioName, '(', steps.length, 'steps )');
        });
        return registered;
    }

    /** Auto-select `defaultScenario` on load so a manual __setMockScenario isn't needed every
     *  run. Two guards: an explicit `?scenario=` URL param always wins (readScenario() would
     *  otherwise be overridden, since __mockScenario outranks the URL param), and the name
     *  must actually resolve (a registered custom sequence or a built-in) so a stale/misspelled
     *  value doesn't silently force a no-op 'lose'. */
    private _applyDefaultScenario(registered: Set<string>): void {
        if (!this.defaultScenario) {
            return;
        }
        const eno: any = (globalThis as any).eno;
        const urlScenario = eno && eno.getUrlParam ? eno.getUrlParam('scenario') : '';
        if (typeof urlScenario === 'string' && urlScenario.length > 0) {
            return; // explicit ?scenario= always wins over the component default
        }
        if (!registered.has(this.defaultScenario) && !ALL_SCENARIOS.includes(this.defaultScenario as MockScenario)) {
            mockWarn('OfflineMockBootstrap: defaultScenario', this.defaultScenario, 'is not a registered sequence or a built-in scenario — ignored');
            return;
        }
        setScenario(this.defaultScenario);
        mockLog('default scenario auto-selected:', this.defaultScenario);
    }

    private _config(): any {
        const loader: any = (globalThis as any).loadModuleConfigAsync;
        return loader && loader.getConfig ? loader.getConfig() : {};
    }
}
