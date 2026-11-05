/**
 * Dev outcome control. The next NORMAL spin uses this scenario:
 *   lose / win                         -> generated base spin
 *   respin / lightning / gamble        -> procedural best-guess feature (UNVERIFIED)
 *   jackpot                            -> a win spin followed by a jackpot-win event
 *   <custom>                           -> a sequence loaded from JSON via OfflineMockBootstrap
 *                                         (e.g. the freespin/bonus/topup samples in data/samples/)
 *
 * Source order: globalThis.__mockScenario (set via console) > ?scenario= URL > 'lose'.
 * Feature scenarios only start on an `ng` with no feature already running; once a feature is
 * active its own sequence drives subsequent spins until it finishes.
 */
export type MockScenario =
    | 'lose' | 'win'
    | 'freespin' | 'bonus' | 'topup'
    | 'respin' | 'lightning' | 'gamble'
    | 'jackpot';

export const ALL_SCENARIOS: MockScenario[] = [
    'lose', 'win', 'freespin', 'bonus', 'topup', 'respin', 'lightning', 'gamble', 'jackpot',
];

/**
 * Returns the active scenario name. Built-ins (ALL_SCENARIOS) or any CUSTOM name registered
 * via MockDataLoader. Unknown names fall through to a normal 'lose' spin in the engine.
 */
export function readScenario(): string {
    const g: any = globalThis as any;
    if (typeof g.__mockScenario === 'string' && g.__mockScenario.length > 0) {
        return g.__mockScenario;
    }
    const eno: any = g.eno;
    const p = eno && eno.getUrlParam ? eno.getUrlParam('scenario') : '';
    return typeof p === 'string' && p.length > 0 ? p : 'lose';
}

export function setScenario(scenario: string): void {
    (globalThis as any).__mockScenario = scenario;
}
