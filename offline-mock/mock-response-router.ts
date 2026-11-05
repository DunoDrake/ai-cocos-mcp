import { getMockHub } from './mock-hub';
import { MOCK_JOIN_DELAY, MOCK_STATE_DELAY, MOCK_EVENT_STAGGER } from './mock-config';
import { mockLog } from './mock-log';

/**
 * Turns a request (short event + data + cId) into dispatched event(s) via the EventManager.
 * All request routing / feature state lives in the engine (`buildResponseForRequest`); the
 * router only schedules the resulting events and applies the wallet update.
 *   jg  -> client-join-game-result (join delay)
 *   ng / feature requests -> one or more state/feature events (state delay + stagger)
 */
export class MockResponseRouter {
    handle(req: { event: string; data: any; cId: string }): void {
        const hub = getMockHub();
        const em = hub.eventManager;
        const playerInfo = hub.playerInfo;

        const { events, newBalance } = hub.engine.buildResponseForRequest(req.event, req.data, req.cId);
        const baseDelay = req.event === 'jg' ? MOCK_JOIN_DELAY : MOCK_STATE_DELAY;
        mockLog('req', req.event, '->', events.map((e: any) => e.event).join(','), 'balance', newBalance);

        // Commit the balance synchronously, before the dispatch delay below. The engine
        // already read the PREVIOUS balance to compute `newBalance` for THIS request; if that
        // commit waited for the delayed setTimeout instead, a next spin fired before this one's
        // delay elapsed (e.g. clicking Spin again quickly) would read the stale pre-this-request
        // balance and silently discard the previous win.
        if (req.event !== 'jg') {
            playerInfo.setBalance(newBalance);
        }

        events.forEach((evt: any, i: number) => {
            setTimeout(() => {
                em.dispatch(evt);
                if (i === 0 && req.event !== 'jg') {
                    playerInfo.fire('wallet-updated', playerInfo.getWallets());
                }
            }, baseDelay + i * MOCK_EVENT_STAGGER);
        });
    }
}
