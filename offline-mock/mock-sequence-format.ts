/**
 * Normalize authored JSON into an array of short PS steps. Accepts:
 *   - tutorial-native  [[ { "<gid>": { "data": {PS} } }, ... ]]
 *   - one level        [ { "<gid>": { "data": {PS} } }, ... ]
 *   - raw PS array     [ {PS}, {PS} ]
 *   - single PS object { PS }   (a 1-step normal spin)
 */
export function normalizeSequence(raw: any): any[] {
    if (!raw) {
        return [];
    }
    let arr: any = raw;
    if (Array.isArray(arr) && arr.length > 0 && Array.isArray(arr[0])) {
        arr = arr[0]; // unwrap tutorial-native outer array
    }
    if (!Array.isArray(arr)) {
        arr = [arr]; // single PS object
    }
    const out: any[] = [];
    arr.forEach((step: any) => {
        const ps = unwrapStep(step);
        if (ps) {
            out.push(ps);
        }
    });
    return out;
}

/** Normalize authored join JSON into a single join `data` object (unwraps array / gid wrapper). */
export function normalizeJoin(raw: any): any {
    if (!raw) {
        return null;
    }
    let o: any = raw;
    if (Array.isArray(o)) {
        o = o[0];
    }
    if (Array.isArray(o)) {
        o = o[0];
    }
    return unwrapStep(o);
}

function unwrapStep(step: any): any {
    if (!step || typeof step !== 'object') {
        return null;
    }
    const keys = Object.keys(step);
    if (keys.length === 1 && step[keys[0]] && step[keys[0]].data) {
        return step[keys[0]].data; // { "<gid>": { "data": {PS} } }
    }
    if (step.data && typeof step.data === 'object' && !step.mx && !step.cId) {
        return step.data; // { "data": {PS} }
    }
    return step; // already a PS
}
