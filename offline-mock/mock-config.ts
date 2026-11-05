/**
 * Central knobs for the offline mock. Tuned for one slot-game family (VND).
 * Values only need to be UI-valid, not RTP-correct (see plan Phase 1 report).
 */

/** Symbol pool taken from captured tutorial matrices (excludes rare wild/jackpot). */
export const SYMBOL_POOL: string[] = ['A', '33', '44', '66', '10', '55', '2', 'A1', 'A2'];

/** Flat matrix length: 5 reels x 3 rows = 15 cells (matches tutorial `mx`). */
export const MATRIX_SIZE: number = 15;

/** Starting wallet balance (VND), mirrors tutorial wallet amount. */
export const MOCK_WALLET_AMOUNT: number = 9780000;

/**
 * Bet ladder. Each value is treated as the TOTAL bet for that level.
 * Format built into join `mBet` = "key;value,...". betKey = first char of key.
 * See plan Phase 1 report: totalBet == betValue when all lines active & no extra bet.
 */
export const MOCK_BET_LADDER: { [key: string]: number } = {
    '1': 1000,
    '2': 2000,
    '3': 5000,
    '4': 10000,
    '5': 25000,
    '6': 50000,
};

/** Timing (ms). ACK ~immediate; state event mirrors trial `_returnTrialPS` 300ms. */
export const MOCK_ACK_DELAY: number = 0;
export const MOCK_STATE_DELAY: number = 300;
export const MOCK_JOIN_DELAY: number = 200;
/** Gap between the primary state event and an extra event (e.g. jackpot-win). */
export const MOCK_EVENT_STAGGER: number = 250;

/** Build the join `mBet` string from the ladder. */
export function buildMBetString(): string {
    return Object.keys(MOCK_BET_LADDER)
        .map((k) => `${k};${MOCK_BET_LADDER[k]}`)
        .join(',');
}

/**
 * Total bet for a given betId (first char = bet key). Pass the ladder returned by
 * `parseBetLadder()` when a custom `joinData` is registered, so the amount deducted per
 * spin matches the ladder actually shown to the player instead of silently diverging from
 * this hard-coded default.
 */
export function totalBetForBetId(betId: string, ladder?: { [key: string]: number }): number {
    const table = ladder || MOCK_BET_LADDER;
    const key = betId && betId.length > 0 ? betId[0] : '1';
    const value = table[key];
    return typeof value === 'number' ? value : (table['1'] ?? MOCK_BET_LADDER['1']);
}

/**
 * Parse a join `mb` string ("1;1000,2;2000,...") back into a bet-ladder map — the inverse
 * of `buildMBetString()`. A custom `joinData.exD.mb` changes what the UI shows as bet
 * levels; without this, `totalBetForBetId()` would keep deducting from the default
 * `MOCK_BET_LADDER`, so the wallet math would silently disagree with the UI.
 */
export function parseBetLadder(mb: string): { [key: string]: number } | null {
    if (typeof mb !== 'string' || mb.length === 0) {
        return null;
    }
    const table: { [key: string]: number } = {};
    for (const pair of mb.split(',')) {
        const [key, value] = pair.split(';');
        const num = Number(value);
        if (key && !isNaN(num)) {
            table[key] = num;
        }
    }
    return Object.keys(table).length > 0 ? table : null;
}

/** Wallet array shape the UI reads from a PS (mirrors tutorial `wallet`). */
export function buildWalletArray(amount: number): any[] {
    const now = Date.now();
    return [{
        amount,
        availableAmount: amount,
        version: now,
        pAmt: 0,
        pAvaiAmt: 0,
        pVer: now,
        stateType: 'wallet-type',
        rt: now,
    }];
}
