/**
 * Offline-mock logger. Routes through the game's shared logger (globalThis.eno.logger)
 * when available so we never touch console.* directly (repo rule). Dev-only tool.
 */
function getLogger(): any {
    const eno: any = (globalThis as any).eno;
    return eno && eno.logger ? eno.logger : null;
}

export function mockLog(...args: any[]): void {
    const lg = getLogger();
    if (lg && typeof lg.log === 'function') {
        lg.log('[OfflineMock]', ...args);
    }
}

export function mockWarn(...args: any[]): void {
    const lg = getLogger();
    if (lg && typeof lg.warn === 'function') {
        lg.warn('[OfflineMock]', ...args);
    } else if (lg && typeof lg.log === 'function') {
        lg.log('[OfflineMock][WARN]', ...args);
    }
}
