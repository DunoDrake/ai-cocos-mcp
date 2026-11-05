import { getMockHub } from './mock-hub';
import { MOCK_ACK_DELAY } from './mock-config';

/**
 * Duck-typed replacement for game-network CommandManager (see plan Phase 1 report §2).
 *
 * executeCommand:
 *  1. generates a command id (cId),
 *  2. schedules the ACK (`COMMAND_SEND_SUCCESSFULLY`) which core registered via
 *     registerCommandSuccess — this sets `gameCommandId` used by the later state verify,
 *  3. asks the response router to produce the follow-up state event(s),
 *  4. returns the cId synchronously (never a COMMAND_FAILED_* string).
 */
export class MockCommandManager {
    private _handlers: { [name: string]: Function[] } = {};

    constructor(gameId: string, _channel: number, _idKey: string) {
        const hub = getMockHub();
        hub.serviceId = gameId;
        hub.commandManager = this;
    }

    registerEvent(name: string, cb: Function): void {
        if (!this._handlers[name]) {
            this._handlers[name] = [];
        }
        this._handlers[name].push(cb);
    }

    executeCommand(payload: any, _strategy: any): string {
        const hub = getMockHub();
        const cId = hub.uuid();
        const event = payload.event;

        // ACK first (near-immediate) so gameCommandId is set before the state event.
        setTimeout(() => this._fire('COMMAND_SEND_SUCCESSFULLY', { event, data: { cId } }), MOCK_ACK_DELAY);

        // Then let the router build + schedule the state response.
        hub.router.handle({ event, data: payload.data, cId });

        return cId;
    }

    // --- safe no-ops the core calls but the mock does not need ---
    onAck(): void { /* no-op */ }
    onCannotSendMessage(): void { /* no-op */ }
    subscribe(): void { /* no-op */ }
    unSubscribe(): void { /* no-op */ }
    clearRemainingCommand(): void { /* no-op */ }

    cleanUp(): void {
        this._handlers = {};
    }

    private _fire(name: string, eventData: any): void {
        (this._handlers[name] || []).forEach((cb) => cb(eventData));
    }
}
