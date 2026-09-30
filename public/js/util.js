// Small pure helpers shared by the browser app and the node tests.

export const isCJKCode = (c) =>
  (c >= 0x3040 && c <= 0x30ff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x4e00 && c <= 0x9fff) ||
  (c >= 0xf900 && c <= 0xfaff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0x20000 && c <= 0x2fa1f);

const isWidePunct = (c) => (c >= 0x3000 && c <= 0x303f) || (c >= 0xff00 && c <= 0xffef);

/** Conservative token estimate (over- rather than under-estimates), good for both CJK and Latin text. */
export function estTokens(s) {
  let t = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x2e80) t += 0.3;
    else if (isCJKCode(c)) t += 1.5;
    else if (isWidePunct(c)) t += 1;
    else if (c >= 0xd800 && c <= 0xdbff) { t += 1.5; i++; } // astral CJK / emoji
    else t += 0.6;
  }
  return Math.ceil(t);
}

/** Share of CJK characters among letters/CJK characters (ignores spaces, digits, punctuation). */
export function cjkRatio(s) {
  let cjk = 0, other = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (isCJKCode(c)) cjk++;
    else if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 0xc0 && c <= 0x24f) || (c >= 0x400 && c <= 0x4ff)) other++;
  }
  const total = cjk + other;
  return total ? cjk / total : 0;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Largest index i with arr[i] <= x (arr ascending); -1 if none. */
export function bsearchLE(arr, x) {
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= x) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** Collapse whitespace, drop control/zero-width characters, and remove spaces between CJK characters. */
export function normalizeText(s) {
  return String(s ?? '')
    .replace(/[\u200b\u200c\u200d\u2060\ufeff\u00ad]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[\s\u00a0\u3000]+/g, ' ')
    .replace(/([\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]) (?=[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f])/g, '$1')
    .trim();
}

/** Small non-cryptographic hash (works over insecure origins where crypto.subtle is unavailable). */
export function hashBytes(u8) {
  let h1 = 0x811c9dc5, h2 = 0x9747b28c;
  for (let i = 0; i < u8.length; i++) {
    h1 = Math.imul(h1 ^ u8[i], 0x01000193);
    h2 = Math.imul(h2 ^ u8[i], 0x85ebca6b) + i | 0;
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0') + u8.length.toString(16);
}

export function hashString(s) {
  return hashBytes(new TextEncoder().encode(s));
}
