import { getMockHub } from './mock-hub';

interface IWaiter {
    onReceived: (eventData: any) => any;
    onTimeout: () => void;
    timer: any;
}

/**
 * Duck-typed replacement for game-network EventManager.
 *
 * Two responsibilities the core relies on (see plan Phase 1 report §3, §5):
 *  1. registerEvent/onEvent — dispatch an incoming event to handlers keyed by `event`.
 *  2. waitForEvent — hold a timeout that PANICs/DIEs unless `onReceived` returns truthy.
 *
 * IMPORTANT ordering: the waiting queue (`_verifyExpectedEvent`) must run BEFORE the
 * registered handlers, because `_fireEventStateUpdated`/`_fireEventJoinGameResult`
 * clear `gameCommandId`/`latestExecuteCommandResult` that the verifier reads.
 */
export class MockEventManager {
    static CAN_NOT_CONNECT: string = 'can-not-connect';
    static CONNECTED: string = 'connected';

    private _handlers: { [name: string]: Function[] } = {};
    private _waiters: IWaiter[] = [];

    constructor() {
        getMockHub().eventManager = this;
    }

    registerEvent(name: string, cb: Function): void {
        if (!this._handlers[name]) {
this._handlers[name] = [];
}
        this._handlers[name].push(cb);
    }

    /** Delivery entry point (mirrors messageManager netCbs.onEvent). */
    onEvent(eventData: any): void {
        this._resolveWaiters(eventData);
        const cbs = this._handlers[eventData.event] || [];
        cbs.forEach((cb) => cb(eventData));
    }

    /** Router-facing alias. */
    dispatch(eventData: any): void {
        this.onEvent(eventData);
    }

    waitForEvent(timeout: number, onReceived: (eventData: any) => any, onTimeout: () => void): void {
        const waiter: IWaiter = {
            onReceived,
            onTimeout,
            timer: setTimeout(() => {
                this._remove(waiter);
                onTimeout();
            }, timeout),
        };
        this._waiters.push(waiter);
    }

    removeWaitingQueue(): void {
        this._waiters.forEach((w) => clearTimeout(w.timer));
        this._waiters.length = 0;
    }

    cleanUp(): void {
        this._handlers = {};
        this.removeWaitingQueue();
    }

    private _resolveWaiters(eventData: any): void {
        // copy: onReceived may trigger removals
        this._waiters.slice().forEach((w) => {
            let matched = false;
            try {
                matched = !!w.onReceived(eventData);
            } catch (e) {
                matched = false;
            }
            if (matched) {
                clearTimeout(w.timer);
                this._remove(w);
            }
        });
    }

    private _remove(waiter: IWaiter): void {
        const i = this._waiters.indexOf(waiter);
        if (i >= 0) {
this._waiters.splice(i, 1);
}
    }
}
