// Password hashing with PBKDF2-SHA256 (WebCrypto, native on Workers).
// Stored format: pbkdf2$<iterations>$<saltB64>$<hashB64>
// Iterations are stored per hash so they can be raised later without breaking logins.
const ITERATIONS = 50_000

const enc = new TextEncoder()

function b64(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ''
  for (const b of arr) s += String.fromCharCode(b)
  return btoa(s)
}

function unb64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0))
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256)
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const hash = await derive(password, salt, ITERATIONS)
  return `pbkdf2$${ITERATIONS}$${b64(salt)}$${b64(hash)}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iter, saltB64, hashB64] = stored.split('$')
  if (scheme !== 'pbkdf2' || !iter || !saltB64 || !hashB64) return false
  const actual = new Uint8Array(await derive(password, unb64(saltB64), Number(iter)))
  const expected = unb64(hashB64)
  if (actual.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i]
  return diff === 0
}

export function randomToken(bytes = 32): string {
  const arr = crypto.getRandomValues(new Uint8Array(bytes))
  return [...arr].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(value))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// Honorifics / initials that come before the given name, e.g. "M Huzaifa Master".
// Keep in sync with scripts/names.mjs.
const PREFIXES = new Set(['m', 'mulla', 'mullah', 'shk', 'sh', 'shaikh', 'sheikh', 'mr', 'mrs', 'ms', 'dr', 'janab', 'bhai', 'bu'])

/** Name words without leading honorifics/initials: "M Huzaifa Master" -> ["Huzaifa", "Master"]. */
export function nameWords(fullName: string): string[] {
  const words = fullName.trim().split(/\s+/).filter(Boolean)
  let i = 0
  while (i < words.length - 1) {
    const w = words[i].toLowerCase().replace(/[^a-z]/g, '')
    if (w.length <= 1 || PREFIXES.has(w)) i++
    else break
  }
  return words.slice(i)
}

/** Default password = given name, lowercase, letters only. "M Huzaifa Master" -> "huzaifa". */
export function defaultPassword(fullName: string, its: string): string {
  const clean = (nameWords(fullName)[0] ?? '').toLowerCase().replace(/[^a-z]/g, '')
  return clean || its
}
