import { MATRIX_SIZE, SYMBOL_POOL } from './mock-config';

/**
 * Generates a random symbol matrix. Wins are NOT derived from the matrix — the client
 * renders wins from the PS `pl`/`wa` fields — so a random matrix with empty paylines
 * always reads as a clean lose. No accidental win possible.
 */
export function generateMatrix(size: number = MATRIX_SIZE): string[] {
    const out: string[] = [];
    for (let i = 0; i < size; i++) {
        out.push(SYMBOL_POOL[Math.floor(Math.random() * SYMBOL_POOL.length)]);
    }
    return out;
}
