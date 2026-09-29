// Same rules as src/lib/crypto.ts (nameWords / defaultPassword) for the Node scripts.
const PREFIXES = new Set(['m', 'mulla', 'mullah', 'shk', 'sh', 'shaikh', 'sheikh', 'mr', 'mrs', 'ms', 'dr', 'janab', 'bhai', 'bu'])

export function nameWords(fullName) {
  const words = fullName.trim().split(/\s+/).filter(Boolean)
  let i = 0
  while (i < words.length - 1) {
    const w = words[i].toLowerCase().replace(/[^a-z]/g, '')
    if (w.length <= 1 || PREFIXES.has(w)) i++
    else break
  }
  return words.slice(i)
}

/** "M Huzaifa Master" -> "huzaifa" */
export function defaultPassword(fullName, its = '') {
  return (nameWords(fullName)[0] ?? '').toLowerCase().replace(/[^a-z]/g, '') || its
}
