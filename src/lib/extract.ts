// Finds RAID changes in meeting notes and Jira exports, and applies the ones a
// person approves.
//
// Two engines produce the same Proposal shape:
// - Rules (this file): cue words for notes, and status/flag/sprint rules for Jira.
//   Works offline, with no API key, and is easy to explain.
// - Claude (ai.ts): better at reading context and nuance in free text.
// Either way, nothing touches the log until a person accepts each proposal.

import type { Issue } from './jira'
import { isMatch, similarity, tokens, type Similarity } from './match'
import { isClosed, nextId, score, type Level, type RaidItem, type RaidType } from './raid'

export interface Source {
  id: string
  name: string
  kind: 'notes' | 'jira'
  text?: string
  issues?: Issue[]
}

export type Action = 'new' | 'update' | 'close'

export interface Proposal {
  id: string
  action: Action
  type: RaidType
  title: string
  description: string
  owner: string
  probability: Level
  impact: Level
  mitigation: string
  /** The words in the source this came from, verbatim. */
  quotes: { sourceId: string; sourceName: string; text: string }[]
  /** Existing item this updates or closes. */
  targetId?: string
  match?: Similarity
  engine: 'rules' | 'ai'
  /** Things a reviewer should double-check. */
  flags: string[]
}

// ---- Rules for notes ----------------------------------------------------------

const PREFIXES: [RegExp, RaidType | null][] = [
  [/^risks?\s*[:-]\s*/i, 'Risk'],
  [/^assumptions?\s*[:-]\s*/i, 'Assumption'],
  [/^(issues?|problem|blocker)\s*[:-]\s*/i, 'Issue'],
  [/^dependenc(y|ies)\s*[:-]\s*/i, 'Dependency'],
  // Lines that are never RAID items.
  [/^(decisions?|attendees|agenda|budget|date|present|apologies)\s*[:-]/i, null],
]

const CUES: [RaidType, RegExp][] = [
  ['Assumption', /\b(assum\w*|we expect that|presum\w*|taking it as given)\b/i],
  ['Dependency', /\b(depends? on|dependent on|dependency on|waiting (on|for)|pending (approval|sign-?off) from|relies on|reliant on|needs? .{3,40} from)\b/i],
  ['Issue', /\b(broken|broke|is down|outage|failing|failed|fails|incident|defect|escalat\w*|missed|behind schedule|unable to|can't|cannot|not working|blocked)\b/i],
  ['Risk', /\b(risks?|at risk|might|may not|could (slip|fail|delay|miss|be late)|concerns?|concerned|worried|potential(ly)?|likely to (slip|miss|fail)|if .{3,60} (slips|is late|isn't|is not))\b/i],
]

const CLOSE_CUE = /\b(resolved|can be closed|closed|no longer (a |an )?(risk|issue|concern|needed|blocking)|has been (signed|approved|delivered|fixed|confirmed)|is done|are done|fixed|approved|signed off|landed|went live)\b/i

/**
 * Does the statement say something is finished? "The issue is resolved" does;
 * "confirm whether the contract has been signed" and "not approved yet" don't.
 */
export function isClosing(statement: string): boolean {
  const m = statement.match(CLOSE_CUE)
  if (!m) return false
  const before = statement.slice(0, m.index).split(/[,;:]/).pop() ?? ''
  const after = statement.slice(m.index! + m[0].length, m.index! + m[0].length + 12)
  return !/\b(not|never|whether|if|once|until|when|before|yet to)\b|n't\b/i.test(before) && !/^\s*yet\b/i.test(after)
}

const HIGH_IMPACT = /\b(critical|major|severe|significant|showstopper|go-live|cutover date|launch date|serious)\b/i
const LOW_IMPACT = /\b(minor|small|cosmetic|low impact|nice to have)\b/i
const HIGH_PROB = /\b(likely|probably|almost certain|expected to (slip|miss)|will (slip|miss)|has carried over (twice|three|again))\b/i
const LOW_PROB = /\b(unlikely|small chance|low chance|remote|improbable)\b/i

const EXPLICIT_OWNER = /\b(?:[Oo]wner|[Oo]wned by|[Aa]ction owner)\s*[:-]?\s*([A-Z][\w'-]+(?:\s[A-Z][\w'-]+)?)/
const ACTION_OWNER = /\b([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s+(?:to|will)\s+(?:chase|confirm|follow up|check|own|look into|investigate|raise|escalate|update|sort|fix)\b/
const MENTION_OWNER = /@([A-Za-z][\w.-]+)/

/** Who the notes say owns this. `explicit` is true for "Owner: Name", false for "Name to chase". */
export function findOwner(text: string): { name: string; explicit: boolean } {
  const e = text.match(EXPLICIT_OWNER)
  if (e) return { name: e[1].trim(), explicit: true }
  const a = text.match(ACTION_OWNER) ?? text.match(MENTION_OWNER)
  return { name: a ? a[1].trim() : '', explicit: false }
}

/** The text with owner tags removed, tidied up as a title. */
function tidyTitle(text: string): string {
  let t = text
    .replace(/\s*\(?\b([Oo]wner|[Oo]wned by|[Aa]ction owner)\s*[:-]?\s*[A-Z][\w'-]+(\s[A-Z][\w'-]+)?\)?\.?/g, '')
    .replace(/\s*[A-Z][a-z]+ (to|will) (chase|follow up)\.?$/, '')
    .replace(/[.;:,\s]+$/, '')
    .trim()
  t = t.charAt(0).toUpperCase() + t.slice(1)
  return t.length > 160 ? `${t.slice(0, 157).replace(/\s\S*$/, '')}…` : t
}

export interface Statement {
  text: string
  /** The whole line it came from, which may name an owner in a separate sentence. */
  line: string
}

/**
 * Splits notes into candidate statements: one per bullet line, and one per
 * sentence within a line. A sentence that starts with "This", "It" or "That"
 * stays with the one before it, since it's about the same thing.
 */
export function statements(text: string): Statement[] {
  const out: Statement[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/^\s*([-*•]|\d+[.)])\s*/, '').trim()
    if (!line) continue
    const sentences: string[] = []
    for (const s of line.split(/(?<=[.!?])\s+(?=[A-Z])/)) {
      const clean = s.trim()
      if (sentences.length && /^(this|that|it|these|which)\b/i.test(clean)) sentences[sentences.length - 1] += ` ${clean}`
      else sentences.push(clean)
    }
    for (const s of sentences) {
      // Skip fragments and lines that only name an owner.
      if (s.split(/\s+/).length >= 4 && !/^(owner|owned by|action owner)\b/i.test(s)) out.push({ text: s, line })
    }
  }
  return out
}

interface Classified {
  type: RaidType | null
  /** The line said explicitly what it is ("Risk: …"). */
  explicit: boolean
  body: string
  skip: boolean
}

export function classify(statement: string): Classified {
  for (const [re, type] of PREFIXES) {
    if (re.test(statement)) {
      return type ? { type, explicit: true, body: statement.replace(re, ''), skip: false } : { type: null, explicit: false, body: statement, skip: true }
    }
  }
  for (const [type, re] of CUES) if (re.test(statement)) return { type, explicit: false, body: statement, skip: false }
  return { type: null, explicit: false, body: statement, skip: false }
}

function levels(text: string, type: RaidType): { probability: Level; impact: Level } {
  const impact: Level = HIGH_IMPACT.test(text) ? 'High' : LOW_IMPACT.test(text) ? 'Low' : 'Medium'
  if (type !== 'Risk') return { probability: '', impact }
  return { probability: HIGH_PROB.test(text) ? 'High' : LOW_PROB.test(text) ? 'Low' : 'Medium', impact }
}

export interface ItemIndex {
  item: RaidItem
  words: Set<string>
}

export const indexItems = (items: RaidItem[]): ItemIndex[] =>
  // The owner's name is included, so "Sam is out cutover week" can find Sam's risk.
  items.map((item) => ({ item, words: tokens(`${item.title} ${item.description} ${item.owner}`) }))

/** The open item that best matches the text, if any match well enough. */
export function bestMatch(text: string, index: ItemIndex[], includeClosed = false): { item: RaidItem; match: Similarity } | null {
  const words = tokens(text)
  let best: { item: RaidItem; match: Similarity } | null = null
  for (const { item, words: w } of index) {
    if (!includeClosed && isClosed(item.status)) continue
    const match = similarity(words, w)
    if (isMatch(match) && (!best || match.score > best.match.score || (match.score === best.match.score && match.shared.length > best.match.shared.length))) {
      best = { item, match }
    }
  }
  return best
}

let counter = 0
const pid = () => `p${++counter}`

export function extractFromNotes(source: Source, items: RaidItem[]): Proposal[] {
  const index = indexItems(items)
  const out: Proposal[] = []
  for (const { text: s, line } of statements(source.text ?? '')) {
    const c = classify(s)
    if (c.skip) continue
    const hit = bestMatch(c.body, index)
    const quote = { sourceId: source.id, sourceName: source.name, text: s }
    const found = findOwner(s).name ? findOwner(s) : findOwner(line)
    const owner = found.name

    if (hit) {
      const closing = isClosing(s)
      const lv = levels(s, hit.item.type)
      out.push({
        id: pid(),
        action: closing ? 'close' : 'update',
        type: hit.item.type,
        title: hit.item.title,
        description: hit.item.description,
        // Keep the existing owner unless the notes name a different one outright.
        owner: hit.item.owner && !(found.explicit && !hit.item.owner.includes(owner)) ? hit.item.owner : owner || hit.item.owner,
        // Only raise the stakes on an update when the notes say so explicitly.
        probability: hit.item.type === 'Risk' && HIGH_PROB.test(s) ? 'High' : hit.item.probability,
        impact: HIGH_IMPACT.test(s) ? 'High' : hit.item.impact || lv.impact,
        mitigation: hit.item.mitigation,
        quotes: [quote],
        targetId: hit.item.id,
        match: hit.match,
        engine: 'rules',
        flags: [],
      })
      continue
    }
    if (!c.type) continue
    // A closing remark with nothing to close isn't a new item.
    if (isClosing(s) && !c.explicit) continue
    const lv = levels(s, c.type)
    out.push({
      id: pid(),
      action: 'new',
      type: c.type,
      title: tidyTitle(c.body),
      description: '',
      owner,
      ...lv,
      mitigation: '',
      quotes: [quote],
      engine: 'rules',
      flags: owner ? [] : ['No owner named in the source.'],
    })
  }
  return out
}

// ---- Rules for a Jira export ---------------------------------------------------

const doneStatus = (i: Issue) =>
  i.statusCategory ? i.statusCategory.toLowerCase() === 'done' : /^(done|closed|resolved|complete)/i.test(i.status)

export function extractFromJira(source: Source, items: RaidItem[]): Proposal[] {
  const out: Proposal[] = []
  const index = indexItems(items)
  for (const issue of source.issues ?? []) {
    if (doneStatus(issue)) continue
    const blocked = issue.flagged || /block|impediment|on hold/i.test(issue.status)
    const dependency = /\b(depends? on|waiting (on|for)|blocked by|pending)\b/i.test(issue.summary)
    const carryovers = Math.max(0, issue.sprints.length - 1)
    let type: RaidType | null = null
    let title = ''
    let probability: Level = ''
    let impact: Level = (issue.points ?? 0) >= 8 ? 'High' : (issue.points ?? 0) >= 3 ? 'Medium' : 'Low'
    if (dependency) {
      type = 'Dependency'
      title = `${issue.summary} (${issue.key})`
    } else if (blocked) {
      type = 'Issue'
      title = `Blocked: ${issue.summary} (${issue.key})`
    } else if (carryovers >= 2) {
      type = 'Risk'
      title = `${issue.summary} has carried over ${carryovers} sprints and may slip again (${issue.key})`
      probability = 'High'
      if (/^(highest|high|critical|blocker)$/i.test(issue.priority)) impact = 'High'
    }
    if (!type) continue

    const quote = {
      sourceId: source.id,
      sourceName: source.name,
      text: `${issue.key} "${issue.summary}": status ${issue.status}${issue.flagged ? ', flagged' : ''}${carryovers ? `, in ${issue.sprints.length} sprints` : ''}${issue.points != null ? `, ${issue.points} pts` : ''}`,
    }
    // Already tracked? Look for the key first, then similar wording.
    const byKey = items.find((it) => !isClosed(it.status) && `${it.title} ${it.description} ${it.source}`.includes(issue.key))
    const hit = byKey ? { item: byKey, match: { score: 1, shared: [issue.key] } } : bestMatch(issue.summary, index)
    if (hit) {
      out.push({
        id: pid(), action: 'update', type: hit.item.type, title: hit.item.title, description: hit.item.description,
        owner: hit.item.owner || issue.assignee, probability: hit.item.probability, impact: hit.item.impact,
        mitigation: hit.item.mitigation, quotes: [quote], targetId: hit.item.id, match: hit.match, engine: 'rules', flags: [],
      })
    } else {
      out.push({
        id: pid(), action: 'new', type, title, description: '', owner: issue.assignee, probability, impact,
        mitigation: '', quotes: [quote], engine: 'rules', flags: issue.assignee ? [] : ['Unassigned in Jira.'],
      })
    }
  }
  return out
}

// ---- Combining and applying ----------------------------------------------------

/**
 * Merges proposals that are about the same thing: two updates to the same item,
 * or two new items worded alike. Their quotes are kept together, and the
 * stronger action (close over update) wins.
 */
export function mergeProposals(list: Proposal[]): Proposal[] {
  const out: Proposal[] = []
  for (const p of list) {
    const same = out.find((q) =>
      p.targetId ? q.targetId === p.targetId : !q.targetId && q.type === p.type && isMatch(similarity(q.title, p.title)),
    )
    if (!same) {
      out.push({ ...p, quotes: [...p.quotes], flags: [...p.flags] })
      continue
    }
    same.quotes.push(...p.quotes)
    // Closing beats updating: "the alert fired twice" then "the issue is resolved".
    if (p.action === 'close') same.action = 'close'
    const rank = { Low: 1, Medium: 2, High: 3, '': 0 }
    if (rank[p.impact] > rank[same.impact]) same.impact = p.impact
    if (rank[p.probability] > rank[same.probability]) same.probability = p.probability
    if (!same.owner && p.owner) same.owner = p.owner
    same.flags = same.flags.filter((f) => !(f.startsWith('No owner') && same.owner))
  }
  return out
}

export interface ApplyResult {
  items: RaidItem[]
  changes: string[]
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)

export function applyProposals(items: RaidItem[], accepted: Proposal[], asOf: number): ApplyResult {
  const next = items.map((i) => ({ ...i, log: [...i.log] }))
  const changes: string[] = []
  const quoteText = (p: Proposal) => p.quotes.map((q) => `${q.sourceName}: "${q.text}"`).join(' | ')

  for (const p of accepted) {
    if (p.action === 'new') {
      const id = nextId(next, p.type)
      next.push({
        id, type: p.type, title: p.title, description: p.description, owner: p.owner, status: 'Open',
        probability: p.type === 'Risk' ? p.probability : '', impact: p.impact, mitigation: p.mitigation,
        raised: asOf, updated: asOf, due: null, source: p.quotes.map((q) => q.sourceName).join(', '),
        log: [`${day(asOf)} Raised. ${quoteText(p)}`],
      })
      changes.push(`Added ${id} (${p.type}): ${p.title}`)
      continue
    }
    const item = next.find((i) => i.id === p.targetId)
    if (!item) continue
    const diffs: string[] = []
    if (p.owner !== item.owner) diffs.push(`owner ${item.owner || '(none)'} → ${p.owner || '(none)'}`)
    if (p.probability !== item.probability) diffs.push(`probability ${item.probability || '–'} → ${p.probability || '–'}`)
    if (p.impact !== item.impact) diffs.push(`impact ${item.impact || '–'} → ${p.impact || '–'}`)
    if (p.title !== item.title) diffs.push('title reworded')
    Object.assign(item, { owner: p.owner, probability: p.probability, impact: p.impact, title: p.title, mitigation: p.mitigation || item.mitigation })
    item.updated = asOf
    if (p.action === 'close') {
      item.status = 'Closed'
      item.log.push(`${day(asOf)} Closed. ${quoteText(p)}`)
      changes.push(`Closed ${item.id}: ${item.title}`)
    } else {
      item.log.push(`${day(asOf)} Update${diffs.length ? ` (${diffs.join(', ')})` : ''}. ${quoteText(p)}`)
      changes.push(`Updated ${item.id}${diffs.length ? `: ${diffs.join(', ')}` : ': new note added'}`)
    }
  }
  return { items: next, changes }
}

/** Open items ranked for a weekly digest: highest score first, then the longest without an update. */
export function topItems(items: RaidItem[], n = 5): RaidItem[] {
  return items
    .filter((i) => !isClosed(i.status))
    .sort((a, b) => score(b) - score(a) || (a.updated ?? 0) - (b.updated ?? 0))
    .slice(0, n)
}
