import { MOCK_ACK_DELAY } from './mock-config';
import { mockLog } from './mock-log';

/**
 * Duck-typed replacement for game-network MessageManager (plan Phase 1 report §4).
 * registerGame must fire netCbs.onConnected so the game leaves the "connecting" state.
 * initSocket/closeAndCleanUp are safety no-ops in case the core connectNetwork path
 * ever reaches here (the offline GameInit branch bypasses it, but keep it inert).
 */
export class MockMessageManager {
    private static _instance: MockMessageManager | null = null;

    static getInstance(): MockMessageManager {
        if (!MockMessageManager._instance) {
            MockMessageManager._instance = new MockMessageManager();
        }
        return MockMessageManager._instance;
    }

    registerGame(_gameId: string, _ackCbs: any, netCbs: any): void {
        mockLog('registerGame -> onConnected');
        setTimeout(() => {
            if (netCbs && typeof netCbs.onConnected === 'function') {
netCbs.onConnected();
}
        }, MOCK_ACK_DELAY);
    }

    unregisterGame(): void { /* no-op */ }
    initSocket(): void { /* no-op — never opens a real socket */ }
    closeAndCleanUp(): void { /* no-op */ }
}
