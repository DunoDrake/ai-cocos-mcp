/**
 * RFC4122-ish v4 uuid. Good enough for dev-mock command ids; the core only needs
 * a unique string it can echo back in the ACK/state `cId`.
 */
export function mockUuid(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c: string) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}
