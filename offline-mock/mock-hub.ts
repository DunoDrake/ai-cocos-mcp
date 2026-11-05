/**
 * Shared coordinator. NetworkBridge constructs MockCommandManager and MockEventManager
 * independently (`new CommandManager(...)`, `new EventManager()`), so they can't see each
 * other or the response router without a shared reference. One game runs per scene, so a
 * module singleton is sufficient. OfflineMockNetwork.create() builds the hub before the
 * bridge news the managers; each manager attaches itself on construction.
 */
export interface IMockHub {
    serviceId: string;
    uuid: () => string;
    commandManager: any;
    eventManager: any;
    playerInfo: any;
    engine: any;
    router: any;
}

let currentHub: IMockHub | null = null;

export function setMockHub(hub: IMockHub): void {
    currentHub = hub;
}

export function getMockHub(): IMockHub {
    if (!currentHub) {
        throw new Error('[OfflineMock] hub not initialized — call OfflineMockNetwork.create() first');
    }
    return currentHub;
}
