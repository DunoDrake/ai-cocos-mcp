import { MOCK_WALLET_AMOUNT } from './mock-config';

/**
 * Duck-typed replacement for game-network PlayerInfoStateManager (plan Phase 1 report §4).
 * Holds the offline wallet balance + fake identity, and stores the `wallet-updated`
 * listener so the response engine can push balance changes to the UI.
 */
export class MockPlayerInfoStateManager {
    private static _instance: MockPlayerInfoStateManager | null = null;

    static getInstance(): MockPlayerInfoStateManager {
        if (!MockPlayerInfoStateManager._instance) {
            MockPlayerInfoStateManager._instance = new MockPlayerInfoStateManager();
        }
        return MockPlayerInfoStateManager._instance;
    }

    private _balance: number = MOCK_WALLET_AMOUNT;
    private _events: { [name: string]: Function[] } = {};

    getToken(): string {
        return 'offline-mock-token';
    }

    getUserId(): string {
        return 'offline-user';
    }

    getDisplayName(): string {
        return 'Offline Dev';
    }

    getWalletBalance(): number {
        return this._balance;
    }

    /**
     * Returns an object because the only consumer (`_fireEventWalletUpdate` ->
     * `onWalletUpdate` -> `updateWallet({ amount, pAmount })`) destructures amount/pAmount.
     */
    getWallets(): any {
        return { amount: this._balance, pAmount: 0 };
    }

    setBalance(amount: number): void {
        this._balance = amount;
    }

    registerEvent(name: string, cb: Function): void {
        if (!this._events[name]) {
this._events[name] = [];
}
        this._events[name].push(cb);
    }

    removeEvent(name: string, cb: Function): void {
        const list = this._events[name];
        if (!list) {
return;
}
        const i = list.indexOf(cb);
        if (i >= 0) {
list.splice(i, 1);
}
    }

    fire(name: string, data?: any): void {
        (this._events[name] || []).forEach((cb) => cb(data));
    }
}
