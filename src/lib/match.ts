// Text similarity for matching a new mention to an existing RAID item.
//
// Deliberately simple and explainable: content words are normalised (lower
// case, common suffixes trimmed, filler words dropped) and two texts are
// compared by how many of the shorter one's words they share. The page shows
// the shared words, so a reviewer can see why two items were linked.

const STOP = new Set(
  ('a an and are as at be been but by can could did do does for from had has have he her his how i if in into is it its ' +
    'may might more must no not now of on or our out over she should so than that the their them then there these they ' +
    'this those to too up us was we were what when where which while who will with would yet you your about after again ' +
    'all also any because before being both each few further here just most other own same some such only very once ' +
    'still team this today new now next one two get got going need needs per via vs etc').split(' '),
)

export function stem(word: string): string {
  let w = word
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3)
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2)
  else if (w.length > 4 && w.endsWith('es')) w = w.slice(0, -2)
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1)
  // "arrive", "arrived" and "arriving" all become "arriv".
  if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1)
  return w
}

export function tokens(text: string): Set<string> {
  const out = new Set<string>()
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOP.has(raw) || /^\d+$/.test(raw)) continue
    out.add(stem(raw))
  }
  return out
}

export interface Similarity {
  score: number
  shared: string[]
}

/** Shared words ÷ words in the shorter text. 1 means one text's words are all in the other. */
export function similarity(a: Set<string> | string, b: Set<string> | string): Similarity {
  const A = typeof a === 'string' ? tokens(a) : a
  const B = typeof b === 'string' ? tokens(b) : b
  const shared = [...A].filter((t) => B.has(t))
  const denom = Math.min(A.size, B.size)
  return { score: denom ? shared.length / denom : 0, shared }
}

/**
 * Good enough to propose as the same item: 3 shared words covering 40% of the
 * shorter text, or 4 or more covering 30%.
 */
export const isMatch = (s: Similarity) => (s.shared.length >= 3 && s.score >= 0.4) || (s.shared.length >= 4 && s.score >= 0.3)

/** The original words behind shared stems, for display: "financ" → "finance". */
export function originalWords(stems: string[], ...texts: string[]): string[] {
  const words = texts.join(' ').toLowerCase().split(/[^a-z0-9]+/)
  return stems.map((st) => words.find((w) => w.length >= 3 && stem(w) === st) ?? st)
}
