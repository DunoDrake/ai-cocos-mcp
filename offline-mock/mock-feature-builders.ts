import { generateMatrix } from './reel-generator';
import { mockUuid } from './mock-uuid';
import { buildWalletArray } from './mock-config';

/**
 * Procedural builders for features that have NO tutorial template (respin / lightning /
 * gamble) plus the jackpot-win event. Field sets are BEST-GUESS from MsgKeyMapping +
 * feature-module recon and are UNVERIFIED against a live game scene — expect to tune these
 * in-editor. Tutorial-backed features (freespin/bonus/topup) use the captured sequences.
 *
 * GAME_MODE nextMode values (GameDefine.ts): NORMAL=1 FREE=2 FREE_OPTION=3 BONUS=4
 * LIGHTNING=5 GAMBLE=7 RESPIN=8.
 */
export const MODE = {
    NORMAL: '1', FREE: '2', FREE_OPTION: '3', BONUS: '4', LIGHTNING: '5', GAMBLE: '7', RESPIN: '8',
};

/** Shared identity/state fields every mock PS carries. */
function baseStep(cId: string, serviceId: string, betId: string, finished: boolean, nextMode: string): any {
    const now = Date.now();
    return {
        cId,
        id: mockUuid(),
        v: 1,
        sId: serviceId,
        bId: betId,
        s: 1,
        ac: nextMode,
        isF: finished ? 'T' : 'F',
        isT: 'F',
        bt: now,
        rt: now,
    };
}

/** One respin step. `remaining` counts down; the last step returns to NORMAL. */
export function buildRespinStep(
    cId: string, serviceId: string, betId: string, remaining: number, total: number, win: number,
): any {
    const finished = remaining <= 0;
    const step = baseStep(cId, serviceId, betId, finished, finished ? MODE.NORMAL : MODE.RESPIN);
    step.rMx = generateMatrix();
    step.rRe = Math.max(remaining, 0);
    step.rta = total;
    step.ra = win;
    step.wa = win;
    step.pl = [];
    return step;
}

/** One lightning step. */
export function buildLightningStep(
    cId: string, serviceId: string, betId: string, remaining: number, win: number,
): any {
    const finished = remaining <= 0;
    const step = baseStep(cId, serviceId, betId, finished, finished ? MODE.NORMAL : MODE.LIGHTNING);
    step.lRe = Math.max(remaining, 0);
    step.mx = generateMatrix();
    step.wa = win;
    step.pl = [];
    return step;
}

/** One gamble step (single resolve -> back to normal). */
export function buildGambleStep(cId: string, serviceId: string, betId: string, win: number): any {
    const step = baseStep(cId, serviceId, betId, true, MODE.NORMAL);
    step.gbop = ['0'];
    step.gbc = ['0', '1', '2', '3'];
    step.gbr = [String(win)];
    step.gbv = win;
    step.wa = win;
    return step;
}

/** Trigger PS on the `ng` that enters a procedural feature (nextMode set, isF:'F'). */
export function buildFeatureTrigger(
    cId: string, serviceId: string, betId: string, nextMode: string, extra: any,
): any {
    const step = baseStep(cId, serviceId, betId, false, nextMode);
    step.mx = generateMatrix();
    step.s0 = [];
    step.wa = 0;
    step.pl = [];
    return Object.assign(step, extra);
}

/** Jackpot-win event (separate from the spin state). `cId` must be a recent command id. */
export function buildJackpotWinEvent(cId: string, amount: number): any {
    return { event: 'jackpot-win', data: { jpInfo: [{ cId, jpAmt: amount, ja: amount }] } };
}

export { buildWalletArray };
