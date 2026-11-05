import { setMockHub, IMockHub } from './mock-hub';
import { mockUuid } from './mock-uuid';
import { MockCommandManager } from './MockCommandManager';
import { MockEventManager } from './MockEventManager';
import { MockMessageManager } from './MockMessageManager';
import { MockPlayerInfoStateManager } from './MockPlayerInfoStateManager';
import { MockResponseEngine } from './mock-response-engine';
import { MockResponseRouter } from './mock-response-router';
import { mockLog } from './mock-log';
import { ALL_SCENARIOS, setScenario } from './mock-scenario';

/**
 * Offline mock network — a duck-typed stand-in for `globalThis.GameNetwork` so a slot
 * game can run (login/join/spin) with no backend. Toggled from GameInit (?offline=1 or
 * config OFFLINE_MOCK). Dev tool only — never ship in a production build.
 *
 * `create()` builds the shared hub first, then returns the network object whose
 * CommandManager/EventManager classes attach themselves to that hub when NetworkBridge
 * constructs them. See plan Phase 1 report §1 for the required shape.
 */
export class OfflineMockNetwork {
    static create(): any {
        const hub: IMockHub = {
            serviceId: '',
            uuid: mockUuid,
            commandManager: null,
            eventManager: null,
            playerInfo: MockPlayerInfoStateManager.getInstance(),
            engine: new MockResponseEngine(),
            router: new MockResponseRouter(),
        };
        setMockHub(hub);

        const mockNetwork: any = {
            CommandManager: MockCommandManager,
            EventManager: MockEventManager,
            MessageManager: { getInstance: (): MockMessageManager => MockMessageManager.getInstance() },
            PlayerInfoStateManager: {
                getInstance: (): MockPlayerInfoStateManager => MockPlayerInfoStateManager.getInstance(),
            },
            // Safety stub in case the core connectNetwork/globalNetwork path is ever reached.
            ServiceRest: { getInstance: (): any => ({}) },
            lib: { uuid: mockUuid, logger: null },
        };

        // NetworkBridge/GlobalNetwork resolve `globalThis.GameNetwork || network`. Own the
        // global so the mock wins even if a host injected a real GameNetwork (dev-only).
        (globalThis as any).GameNetwork = mockNetwork;

        // Dev control: set the next spin's outcome from the console, e.g.
        //   __setMockScenario('freespin')  then press spin.
        (globalThis as any).__setMockScenario = (s: string): void => setScenario(s);
        mockLog('offline mock network created. scenarios:', ALL_SCENARIOS.join(', '));

        return mockNetwork;
    }
}
