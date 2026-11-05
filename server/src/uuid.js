const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// Cocos compresses a 32-hex-char uuid as: first 5 hex chars verbatim, plus
// the remaining 27 hex nibbles (108 bits) re-chunked into 18 six-bit groups
// mapped through the base64 alphabet. Verified against two real uuid/meta
// pairs found in the repo (SlotTableNearWinModule, BackToRealModeButton).
export function compressUuid(canonicalUuid) {
  const hex = canonicalUuid.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  const prefix = hex.slice(0, 5);
  const rest = hex.slice(5);
  let bits = '';
  for (const ch of rest) {
    bits += parseInt(ch, 16).toString(2).padStart(4, '0');
  }
  let out = '';
  for (let i = 0; i < bits.length; i += 6) {
    let chunk = bits.slice(i, i + 6);
    if (chunk.length < 6) chunk = chunk.padEnd(6, '0');
    out += BASE64_ALPHABET[parseInt(chunk, 2)];
  }
  return prefix + out;
}
