const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Random, URL-safe ID such as `n_k3f9a0zq`. Uses Web Crypto (Node ≥ 20 and browsers). */
export function randomId(prefix: string, length = 10): string {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${out}`;
}

export const newNodeId = () => randomId('n', 8);
export const newLinkId = () => randomId('l', 8);
export const newThesisId = () => randomId('t', 8);
export const newPeerId = () => randomId('p', 8);
