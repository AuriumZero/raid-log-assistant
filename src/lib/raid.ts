// The RAID log: Risks, Assumptions, Issues and Dependencies.
//
// Reads a log from whatever columns a team already uses (header names vary a
// lot between templates), scores risks, and finds items that have gone stale.

import { parseJiraDate } from './dates'

export const TYPES = ['Risk', 'Assumption', 'Issue', 'Dependency'] as const
export type RaidType = (typeof TYPES)[number]
export const LEVELS = ['Low', 'Medium', 'High'] as const
export type Level = (typeof LEVELS)[number] | ''

export interface RaidItem {
  id: string
  type: RaidType
  title: string
  description: string
  owner: string
  status: string
  probability: Level
  impact: Level
  mitigation: string
  /** UTC ms */
  raised: number | null
  /** UTC ms */
  updated: number | null
  due: number | null
  source: string
  /** Dated notes added as the item changes. */
  log: string[]
}

type Col = 'id' | 'type' | 'title' | 'description' | 'owner' | 'status' | 'probability' | 'impact' | 'mitigation' | 'raised' | 'updated' | 'due' | 'source' | 'log'

const ALIASES: Record<Col, string[]> = {
  id: ['id', 'raid id', 'ref', 'reference', 'item id', '#', 'no', 'number'],
  type: ['type', 'category', 'raid type', 'kind', 'r/a/i/d'],
  title: ['title', 'summary', 'name', 'risk or issue', 'item', 'headline', 'raid item'],
  description: ['description', 'details', 'detail', 'notes', 'comments', 'context'],
  owner: ['owner', 'assigned to', 'assignee', 'action owner', 'responsible'],
  status: ['status', 'state'],
  probability: ['probability', 'likelihood', 'chance'],
  impact: ['impact', 'severity', 'consequence'],
  mitigation: ['mitigation', 'response', 'action', 'actions', 'mitigation / action', 'next steps', 'plan', 'resolution'],
  raised: ['raised', 'date raised', 'created', 'opened', 'date identified', 'identified'],
  updated: ['updated', 'last updated', 'last update', 'date updated', 'last reviewed', 'reviewed'],
  due: ['due', 'due date', 'target date', 'need by', 'target'],
  source: ['source', 'raised by', 'origin'],
  log: ['history', 'update log', 'updates', 'change log'],
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')

export function parseType(raw: string): RaidType | null {
  const s = norm(raw)
  if (!s) return null
  if (s === 'r' || s.startsWith('risk')) return 'Risk'
  if (s === 'a' || s.startsWith('assum')) return 'Assumption'
  if (s === 'i' || s.startsWith('issue') || s === 'problem') return 'Issue'
  if (s === 'd' || s.startsWith('depend')) return 'Dependency'
  return null
}

/** Accepts Low/Medium/High, L/M/H, 1–3, 1–5, or a percentage / fraction. */
export function parseLevel(raw: string): Level {
  const s = norm(raw).replace('%', '')
  if (!s) return ''
  if (/^(l|low|very low|minor|unlikely|rare)$/.test(s)) return 'Low'
  if (/^(m|med|medium|moderate|possible)$/.test(s)) return 'Medium'
  if (/^(h|high|very high|critical|major|severe|likely|almost certain)$/.test(s)) return 'High'
  const n = Number(s)
  if (!Number.isFinite(n)) return ''
  if (raw.includes('%') || n > 5) return n < 34 ? 'Low' : n < 67 ? 'Medium' : 'High' // a percentage
  if (n > 0 && n < 1) return n < 0.34 ? 'Low' : n < 0.67 ? 'Medium' : 'High' // a fraction, as Excel stores 60%
  if (n >= 1) return n < 2 ? 'Low' : n < 3 ? 'Medium' : 'High' // a 1–3 or 1–5 scale
  return ''
}

const LEVEL_VALUE: Record<string, number> = { Low: 1, Medium: 2, High: 3 }

/** Probability × impact on a 1–9 scale. Issues have already happened, so they score on impact × 3. */
export function score(item: Pick<RaidItem, 'type' | 'probability' | 'impact'>): number {
  const i = LEVEL_VALUE[item.impact] ?? 0
  if (!i) return 0
  if (item.type === 'Issue') return i * 3
  const p = LEVEL_VALUE[item.probability] ?? 2
  return p * i
}

export const isClosed = (status: string) => /^(closed|done|resolved|complete|completed|retired|cancel+ed|mitigated|validated|invalid)/i.test(status.trim())

export function isStale(item: RaidItem, asOf: number, days = 14): boolean {
  if (isClosed(item.status)) return false
  const last = item.updated ?? item.raised
  return last != null && asOf - last > days * 86_400_000
}

export const daysSince = (ms: number | null, asOf: number) => (ms == null ? null : Math.floor((asOf - ms) / 86_400_000))

export interface LogImport {
  items: RaidItem[]
  warnings: string[]
  /** Which of our fields came from which header, for display. */
  columns: Partial<Record<Col, string>>
}

export function parseLog(rows: string[][]): LogImport {
  const warnings: string[] = []
  // Header row: the first row (of the first ten) that names a title-like column.
  let h = rows.findIndex((r, i) => i < 10 && r.some((c) => ALIASES.title.includes(norm(c)) || ALIASES.description.includes(norm(c))))
  if (h < 0) h = 0
  const headers = (rows[h] ?? []).map(norm)
  const idx = {} as Record<Col, number>
  const columns: LogImport['columns'] = {}
  const used = new Set<number>()
  for (const col of Object.keys(ALIASES) as Col[]) {
    const i = headers.findIndex((hd, n) => !used.has(n) && ALIASES[col].includes(hd))
    idx[col] = i
    if (i >= 0) {
      used.add(i)
      columns[col] = rows[h][i].trim()
    }
  }
  if (idx.title < 0 && idx.description >= 0) {
    // Some logs only have a description; use it as the title.
    idx.title = idx.description
    idx.description = -1
  }
  if (idx.title < 0) throw new Error("Couldn't find a Title, Summary or Description column in this log.")

  const items: RaidItem[] = []
  const ids = new Set<string>()
  let untyped = 0
  for (const row of rows.slice(h + 1)) {
    const get = (c: Col) => (idx[c] >= 0 ? (row[idx[c]] ?? '').trim() : '')
    const title = get('title')
    if (!title) continue
    let type = parseType(get('type'))
    if (!type) {
      untyped++
      type = 'Risk'
    }
    let id = get('id')
    if (!id || ids.has(id)) id = nextId(items, type)
    ids.add(id)
    items.push({
      id,
      type,
      title,
      description: get('description'),
      owner: get('owner'),
      status: get('status') || 'Open',
      probability: parseLevel(get('probability')),
      impact: parseLevel(get('impact')),
      mitigation: get('mitigation'),
      raised: parseJiraDate(get('raised')),
      updated: parseJiraDate(get('updated')),
      due: parseJiraDate(get('due')),
      source: get('source'),
      log: get('log') ? get('log').split(/\r?\n/).filter(Boolean) : [],
    })
  }
  if (untyped) warnings.push(`${untyped} item${untyped > 1 ? 's had' : ' had'} no recognisable type and ${untyped > 1 ? 'were' : 'was'} treated as risks.`)
  if (!items.length) throw new Error('No items found in this log.')
  return { items, warnings, columns }
}

const PREFIX: Record<RaidType, string> = { Risk: 'R', Assumption: 'A', Issue: 'I', Dependency: 'D' }

/** The next free ID for a type, following the log's own numbering where it has one (R-007 → R-008). */
export function nextId(items: Pick<RaidItem, 'id'>[], type: RaidType): string {
  const prefix = PREFIX[type]
  let max = 0
  let width = 3
  let sep = '-'
  for (const { id } of items) {
    const m = id.match(/^([A-Z]+)([-_ ]?)(\d+)$/i)
    if (m && m[1].toUpperCase() === prefix) {
      max = Math.max(max, Number(m[3]))
      width = m[3].length
      sep = m[2]
    }
  }
  return `${prefix}${sep}${String(max + 1).padStart(width, '0')}`
}

export const EXPORT_HEADERS = ['ID', 'Type', 'Title', 'Description', 'Owner', 'Status', 'Probability', 'Impact', 'Score', 'Mitigation / action', 'Raised', 'Last updated', 'Due', 'Source', 'History']
