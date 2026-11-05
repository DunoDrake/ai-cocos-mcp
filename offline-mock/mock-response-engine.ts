import { getMockHub } from './mock-hub';
import { generateMatrix } from './reel-generator';
import { mockUuid } from './mock-uuid';
import { mockWarn } from './mock-log';
import {
    buildMBetString, totalBetForBetId, parseBetLadder, buildWalletArray, MOCK_BET_LADDER,
} from './mock-config';
import { readScenario } from './mock-scenario';
import {
    MODE, buildFeatureTrigger, buildRespinStep, buildLightningStep, buildGambleStep, buildJackpotWinEvent,
} from './mock-feature-builders';

export interface IMockResponse {
    events: Array<{ event: string; data: any }>;
    newBalance: number;
}

interface IProcFeature {
    kind: 'respin' | 'lightning' | 'gamble';
    remaining: number;
    total: number;
    betId: string;
    win: number;
}

/**
 * Central response builder. Given a request (short event + data + cId) it returns the
 * network event(s) to dispatch plus the resulting wallet balance. Owns the active-feature
 * state so multi-step features (freespin/bonus/topup via tutorial replay; respin/lightning/
 * gamble procedurally) run to completion across successive feature requests.
 */
export class MockResponseEngine {
    private _activeSeq: any[] | null = null;
    private _seqIndex: number = 0;
    private _proc: IProcFeature | null = null;
    /** User-authored sequences (loaded from JSON via the bootstrap), keyed by scenario name. */
    private _customSeqs: { [name: string]: any[] } = {};
    /** Next index to serve for a round-robin pool (see `_isRoundRobinPool`), keyed by name. */
    private _customSeqPointer: { [name: string]: number } = {};
    /** Optional user-authored join-game response (short-param data object). */
    private _customJoin: any = null;
    /** Bet ladder parsed from `_customJoin.exD.mb`, when one was registered — keeps the
     *  amount deducted per spin in sync with whatever ladder the join response showed. */
    private _customBetLadder: { [key: string]: number } | null = null;
    /** Bet level the currently-active custom sequence was started with — feature-continuation
     *  steps are free (no new bet), but still need this to scale their win amounts (see
     *  `_scaleStepForBet`). */
    private _activeBetId: string = '10';

    /** Register a custom sequence so `__setMockScenario(name)` replays it. `steps` = array of short PS. */
    registerSequence(name: string, steps: any[]): void {
        if (!name || !Array.isArray(steps) || steps.length === 0) {
            mockWarn('registerSequence ignored — bad name/steps for', name);
            return;
        }
        this._customSeqs[name] = steps;
    }

    /** Register a custom join-game response (short-param data object). `cId` is set per request.
     *  If it carries `exD.mb`, that ladder also drives `totalBetForBetId()` from then on — see
     *  `_totalBet()` — so a custom bet ladder shown in the UI is the one actually charged. */
    registerJoin(data: any): void {
        if (!data || typeof data !== 'object') {
            mockWarn('registerJoin ignored — bad join data');
            return;
        }
        this._customJoin = data;
        const mb = data.exD && data.exD.mb;
        this._customBetLadder = typeof mb === 'string' ? parseBetLadder(mb) : null;
    }

    buildResponseForRequest(event: string, reqData: any, cId: string): IMockResponse {
        const balance = getMockHub().playerInfo.getWalletBalance();
        if (event === 'jg') {
            return { events: [{ event: 'client-join-game-result', data: this.buildJoin(cId) }], newBalance: balance };
        }
        if (event === 'ng') {
            return this._handleNormalSpin(reqData, cId);
        }
        // glt = get-latest-state (panic recovery only). Never advance a feature on it.
        if (event === 'glt') {
            return { events: [], newBalance: balance };
        }
        // Any other event while a feature is active advances it. Robust to short/long event
        // names (e.g. 'fg' vs 'client-free-spin-event-request', which has no NEW_EVENT mapping).
        if (this._activeSeq || this._proc) {
            return this._handleFeatureRequest(cId);
        }
        mockWarn('request with no active feature:', event, '(expected fg/fo/mg/... after a trigger)');
        return this._singleState(this._buildNormalPS(reqData, cId, 'lose', balance), balance);
    }

    /** Fresh-join meta (short-param). Custom JSON overrides the generated default. */
    buildJoin(cId: string): any {
        if (this._customJoin) {
            const data = JSON.parse(JSON.stringify(this._customJoin));
            data.cId = cId;
            // Sync the mock wallet to the join balance so the first spin's math is consistent.
            const amt = data.exD && data.exD.metaDataUser && data.exD.metaDataUser.currentWalletAmount;
            if (typeof amt === 'number') {
                getMockHub().playerInfo.setBalance(amt);
            }
            return data;
        }
        const balance = getMockHub().playerInfo.getWalletBalance();
        // ec omitted -> game keeps its DEFAUT_CURRENCY (avoids CURRENCY_CONFIG mismatch).
        return { cId, exD: { mb: buildMBetString(), metaDataUser: { currentWalletAmount: balance } } };
    }

    // --- normal spin / scenario dispatch ---

    private _handleNormalSpin(reqData: any, cId: string): IMockResponse {
        const balance = getMockHub().playerInfo.getWalletBalance();

        // A custom sequence is already mid-playback: each manual Spin reveals its next
        // step instead of restarting the sequence from step 0.
        if (this._activeSeq) {
            return this._advanceActiveSeq(cId, balance);
        }

        this._resetFeature();
        const scenario = readScenario();
        const betId: string = (reqData && reqData.bId) || '10';
        const totalBet = this._totalBet(betId);

        // Custom sequences loaded from JSON (freespin/bonus/topup samples, or your own).
        const customSteps = this._customSeqs[scenario];
        if (customSteps) {
            if (this._isRoundRobinPool(customSteps)) {
                return this._startRoundRobinSpin(scenario, customSteps, cId, balance, totalBet, betId);
            }
            return this._startReplay(customSteps, cId, balance, totalBet, betId);
        }
        if (scenario === 'respin' || scenario === 'lightning' || scenario === 'gamble') {
            return this._startProcFeature(scenario, betId, cId, balance - totalBet);
        }
        if (scenario === 'jackpot') {
            return this._buildJackpotSpin(reqData, cId, betId, totalBet, balance);
        }
        const win = scenario === 'win' ? totalBet * 2 : 0;
        const newBalance = balance - totalBet + win;
        return this._singleState(this._buildNormalPS(reqData, cId, scenario, newBalance), newBalance);
    }

    private _buildJackpotSpin(reqData: any, cId: string, betId: string, totalBet: number, balance: number): IMockResponse {
        const win = totalBet * 2;
        const jackpot = 100000;
        const newBalance = balance - totalBet + win + jackpot;
        const ps = this._buildNormalPS(reqData, cId, 'win', newBalance);
        return {
            events: [
                { event: 'state-updated', data: ps },
                buildJackpotWinEvent(cId, jackpot),
            ],
            newBalance,
        };
    }

    // --- feature request (advance active feature) ---

    private _handleFeatureRequest(cId: string): IMockResponse {
        const balance = getMockHub().playerInfo.getWalletBalance();
        if (this._activeSeq) {
            return this._advanceActiveSeq(cId, balance);
        }
        if (this._proc) {
            return this._serveProcStep(cId, balance);
        }
        mockWarn('feature request with no active feature — returning safe normal PS');
        return this._singleState(this._buildNormalPS({}, cId, 'lose', balance), balance);
    }

    /** Serve the next step of the currently active custom sequence — shared by a manual
     *  re-Spin (`_handleNormalSpin`) and an automatic feature-continuation request
     *  (`_handleFeatureRequest`). Feature/replay steps are free: credit the step's win,
     *  keep balance continuous, no bet deducted. */
    private _advanceActiveSeq(cId: string, balance: number): IMockResponse {
        const step = this._serveSeqStep(cId);
        const newBalance = balance + this._winOf(step);
        step.wallet = buildWalletArray(newBalance);
        return this._singleState(step, newBalance);
    }

    // --- sequence replay (tutorial-backed + custom JSON) ---

    /** Start replaying a sequence on the trigger `ng`: deduct bet, credit step-0 win. */
    private _startReplay(steps: any[], cId: string, balance: number, totalBet: number, betId: string): IMockResponse {
        this._activeSeq = JSON.parse(JSON.stringify(steps));
        this._seqIndex = 0;
        this._activeBetId = betId;
        const step = this._serveSeqStep(cId);
        // Ignore any captured absolute `wallet` (belongs to whoever recorded it); drive balance
        // from the offline balance + this step's win.
        const newBalance = balance - totalBet + this._winOf(step);
        step.wallet = buildWalletArray(newBalance);
        return this._singleState(step, newBalance);
    }

    private _serveSeqStep(cId: string): any {
        const seq = this._activeSeq as any[];
        const step = seq[this._seqIndex];
        this._seqIndex++;
        step.cId = cId; // match this request's command id (verify + fireStateUpdated gate on it)
        // The whole feature round was started at `_activeBetId` (later steps are free, not a
        // new bet), so every step scales against that same bet level.
        this._scaleStepForBet(step, this._activeBetId);
        if (this._seqIndex >= seq.length || step.isF === 'T') {
            this._resetFeature();
        }
        return step;
    }

    /** A registered sequence is a round-robin POOL of independent single spins — not one
     *  multi-step feature round — when every step already carries `isF: "T"` (each one is
     *  already "round finished" on its own). A real feature sequence has `isF: "F"` on every
     *  step but the last, which is what `_startReplay` + `_serveSeqStep` are built for. */
    private _isRoundRobinPool(steps: any[]): boolean {
        return steps.length > 1 && steps.every((s: any) => s && s.isF === 'T');
    }

    /** Serve the NEXT entry of a round-robin pool (wrapping back to the start), advancing a
     *  per-scenario pointer so repeated manual Spins walk through the pool in order instead of
     *  always replaying entry 0 — which is what `_startReplay` would do here, since every
     *  entry's own `isF: "T"` would make `_serveSeqStep` reset `_activeSeq` immediately after
     *  serving it. Each entry is a complete, independent spin: a bet is deducted every time. */
    private _startRoundRobinSpin(name: string, steps: any[], cId: string, balance: number, totalBet: number, betId: string): IMockResponse {
        const idx = this._customSeqPointer[name] ?? 0;
        this._customSeqPointer[name] = (idx + 1) % steps.length;
        const step = JSON.parse(JSON.stringify(steps[idx]));
        step.cId = cId;
        // Each pool entry is its own independent play session, not a continuation of the
        // previous one — the core sets requestingNewPS=true on every manual Spin and DIEs
        // with "Mismatch data new PS" if the response version is not exactly 1. Authored
        // pool files (e.g. one entry per simulated outcome) typically keep the *file's own*
        // incrementing `v`/shared `id` from when it was captured as one continuous sequence,
        // so those must be overwritten here rather than trusted verbatim.
        step.id = mockUuid();
        step.v = 1;
        // Scale the step's win to whatever bet is currently selected — see `_scaleStepForBet`.
        this._scaleStepForBet(step, betId);
        const newBalance = balance - totalBet + this._winOf(step);
        step.wallet = buildWalletArray(newBalance);
        return this._singleState(step, newBalance);
    }

    // --- procedural features (best-guess, UNVERIFIED) ---

    private _startProcFeature(kind: IProcFeature['kind'], betId: string, cId: string, newBalance: number): IMockResponse {
        const total = kind === 'gamble' ? 1 : 3;
        this._proc = { kind, remaining: total, total, betId, win: this._totalBet(betId) };
        const mode = kind === 'respin' ? MODE.RESPIN : kind === 'lightning' ? MODE.LIGHTNING : MODE.GAMBLE;
        const extra = kind === 'respin' ? { rMx: generateMatrix(), rRe: total, rta: total, ra: 0 }
            : kind === 'lightning' ? { lRe: total }
                : { gbc: ['0', '1', '2', '3'] };
        const trigger = buildFeatureTrigger(cId, getMockHub().serviceId, betId, mode, extra);
        trigger.wallet = buildWalletArray(newBalance);
        return this._singleState(trigger, newBalance);
    }

    private _serveProcStep(cId: string, balance: number): IMockResponse {
        const p = this._proc as IProcFeature;
        p.remaining -= 1;
        const newBalance = balance + p.win; // feature spins are free; wins accrue
        const sid = getMockHub().serviceId;
        let step: any;
        if (p.kind === 'respin') {
            step = buildRespinStep(cId, sid, p.betId, p.remaining, p.total, p.win);
        } else if (p.kind === 'lightning') {
            step = buildLightningStep(cId, sid, p.betId, p.remaining, p.win);
        } else {
            step = buildGambleStep(cId, sid, p.betId, p.win);
        }
        step.wallet = buildWalletArray(newBalance);
        if (step.isF === 'T') {
            this._resetFeature();
        }
        return this._singleState(step, newBalance);
    }

    // --- base normal PS ---

    private _buildNormalPS(reqData: any, cId: string, scenario: string, newBalance?: number): any {
        const win = scenario === 'win' ? this._totalBet((reqData && reqData.bId) || '10') * 2 : 0;
        const now = Date.now();
        const mx = generateMatrix();
        if (scenario === 'win') {
            mx[0] = '66'; mx[3] = '66'; mx[6] = '66';
        }
        const balance = typeof newBalance === 'number' ? newBalance : getMockHub().playerInfo.getWalletBalance();
        return {
            cId,
            id: mockUuid(),        // unique id per PS (fresh play session each spin)
            v: 1,                  // constant: core sets requestingNewPS=true, DIEs on version>1
            sId: getMockHub().serviceId,
            bId: (reqData && reqData.bId) || '10',
            s: 1,
            ac: '1',               // nextMode = GAME_MODE.NORMAL_GAME
            sw: win > 0 ? 1 : 0,
            isF: 'T',              // round finished -> spin button re-enables
            isT: 'F',
            bt: now,
            rt: now,
            s0: [],
            wa: win,
            wat: win,
            mx,
            pl: win > 0 ? [`66;${win}.0000;3;1;1`] : [],
            wallet: buildWalletArray(balance),
        };
    }

    // --- helpers ---

    private _singleState(data: any, newBalance: number): IMockResponse {
        return { events: [{ event: 'state-updated', data }], newBalance };
    }

    /** Total bet for a betId, against the custom ladder from `registerJoin()` when one was
     *  registered — otherwise the default `MOCK_BET_LADDER`. Every internal bet-amount lookup
     *  goes through this instead of calling `totalBetForBetId()` directly, so a custom join
     *  ladder is honored everywhere consistently. */
    private _totalBet(betId: string): number {
        return totalBetForBetId(betId, this._customBetLadder || undefined);
    }

    /**
     * Scale a custom-sequence step's win fields from the bet level it was captured at
     * (`step.bId`) to the bet level currently selected — so one authored file plays correctly
     * at any bet, instead of always paying out the amount it happened to be captured at.
     *
     * Refuses rather than guesses: a step with no `bId`, or a `bId` whose bet-ladder key
     * (first char) is not in the active ladder, is left untouched — scaling against an
     * unknown base would silently produce a wrong amount rather than an obviously-off one.
     */
    private _scaleStepForBet(step: any, currentBetId: string): void {
        const baseBetId: unknown = step && step.bId;
        if (typeof baseBetId !== 'string' || baseBetId.length === 0) {
            return;
        }
        const ladder = this._customBetLadder || MOCK_BET_LADDER;
        const baseKey = baseBetId[0];
        if (!(baseKey in ladder)) {
            mockWarn('step bId', baseBetId, 'has no matching bet-ladder key — skipping win scaling');
            return;
        }
        const baseBet = this._totalBet(baseBetId);
        const currentBet = this._totalBet(currentBetId);
        if (!baseBet || baseBet === currentBet) {
            return;
        }
        const scale = currentBet / baseBet;
        if (typeof step.wa === 'number') {
            step.wa = Math.round(step.wa * scale);
        }
        if (typeof step.wat === 'number') {
            step.wat = Math.round(step.wat * scale);
        }
        if (Array.isArray(step.pl)) {
            step.pl = step.pl.map((line: string): string => {
                const parts = String(line).split(';');
                const amount = Number(parts[1]);
                if (parts.length < 2 || isNaN(amount)) {
                    return line;
                }
                parts[1] = `${Math.round(amount * scale)}.0000`;
                return parts.join(';');
            });
        }
    }

    private _winOf(step: any): number {
        const w = step && step.wa;
        const n = typeof w === 'number' ? w : Number(w);
        return isNaN(n) ? 0 : n;
    }

    private _resetFeature(): void {
        this._activeSeq = null;
        this._seqIndex = 0;
        this._proc = null;
    }
}
