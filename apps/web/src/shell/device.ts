/**
 * The opaque per-device key (RS-20 "per device"): 32 random bytes, base64url, kept in this
 * browser's local storage and sent as `X-Device-Key`. The server stores only its SHA-256. It is not
 * a credential and identifies nothing beyond "this browser profile".
 */
const STORAGE = 'pm.device';
const FORMAT = /^[A-Za-z0-9_-]{43}$/;
let memory: string | undefined;

function generate(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function deviceKey(): string {
  try {
    const v = localStorage.getItem(STORAGE);
    if (v && FORMAT.test(v)) return v;
    const fresh = generate();
    localStorage.setItem(STORAGE, fresh);
    return fresh;
  } catch {
    // Storage unavailable (private mode): a per-tab key; per-device state simply does not persist.
    memory ??= generate();
    return memory;
  }
}
