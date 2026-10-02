// Turns the rows of a Jira issue export into typed issues.
//
// Jira's "Export Excel CSV" has a few quirks this handles:
// - A field that holds several values gets one column per value, all with the
//   same header. An issue that was in three sprints fills three "Sprint" columns.
// - Story points live in a custom field whose name depends on the project type:
//   "Story point estimate" (team-managed) or "Story Points" (company-managed).
// - The epic shows up as "Parent summary" in newer exports and "Epic Link" in older ones.
// - Some exports start with a few title rows before the header row.

import { parseJiraDate } from './dates'

export type Field =
  | 'key' | 'summary' | 'type' | 'status' | 'statusCategory' | 'resolution' | 'points'
  | 'epic' | 'assignee' | 'reporter' | 'priority' | 'created' | 'resolved' | 'flagged'

export interface Issue {
  key: string
  summary: string
  type: string
  status: string
  statusCategory: string
  resolution: string
  points: number | null
  epic: string
  assignee: string
  reporter: string
  priority: string
  created: number | null
  resolved: number | null
  sprints: string[]
  labels: string[]
  flagged: boolean
}

export interface Mapping {
  fields: Record<Field, number | null>
  sprint: number[]
  labels: number[]
}

export interface ParsedExport {
  headers: string[]
  issues: Issue[]
  mapping: Mapping
  warnings: string[]
}

export const FIELD_LABELS: Record<Field, string> = {
  key: 'Issue key',
  summary: 'Summary',
  type: 'Issue type',
  status: 'Status',
  statusCategory: 'Status category',
  resolution: 'Resolution',
  points: 'Story points',
  epic: 'Epic / parent',
  assignee: 'Assignee',
  reporter: 'Reporter',
  priority: 'Priority',
  created: 'Created',
  resolved: 'Resolved',
  flagged: 'Flagged',
}

// Header names to look for, best match first. Matching ignores case and spacing.
const CANDIDATES: Record<Field, (string | RegExp)[]> = {
  key: ['Issue key', 'Key', 'Issue Key'],
  summary: ['Summary', 'Title'],
  type: ['Issue Type', 'Type', 'Issuetype'],
  status: ['Status'],
  statusCategory: ['Status Category'],
  resolution: ['Resolution'],
  points: [
    'Custom field (Story point estimate)', 'Custom field (Story Points)', 'Story point estimate', 'Story Points',
    /story\s*points?/i, /story point estimate/i, /^points?$/i,
  ],
  epic: ['Parent summary', 'Epic Link Summary', 'Custom field (Epic Name)', 'Custom field (Epic Link)', 'Epic Link', 'Epic', 'Parent'],
  assignee: ['Assignee'],
  reporter: ['Reporter'],
  priority: ['Priority'],
  created: ['Created'],
  resolved: ['Resolved', 'Resolution date', 'Resolutiondate'],
  flagged: ['Custom field (Flagged)', 'Flagged'],
}

const REQUIRED: Field[] = ['key', 'summary', 'status']

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')

/** The index of the header row: the first row that names an issue key or summary. */
export function findHeaderRow(rows: string[][]): number {
  const limit = Math.min(rows.length, 15)
  for (let i = 0; i < limit; i++) {
    const cells = rows[i].map(norm)
    if (cells.includes('summary') || cells.includes('issue key') || cells.includes('key')) return i
  }
  return 0
}

export function detectMapping(headers: string[]): Mapping {
  const normed = headers.map(norm)
  const used = new Set<number>()
  const fields = {} as Record<Field, number | null>
  for (const field of Object.keys(CANDIDATES) as Field[]) {
    fields[field] = null
    for (const c of CANDIDATES[field]) {
      const idx = normed.findIndex((h, i) => !used.has(i) && (typeof c === 'string' ? h === norm(c) : c.test(h)))
      if (idx >= 0) {
        fields[field] = idx
        used.add(idx)
        break
      }
    }
  }
  const all = (name: string) => normed.flatMap((h, i) => (h === name ? [i] : []))
  return { fields, sprint: all('sprint'), labels: all('labels') }
}

function toNumber(raw: string): number | null {
  const s = raw.trim().replace(',', '.')
  if (!s) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

export function parseExport(rows: string[][], override?: Partial<Mapping>): ParsedExport {
  const warnings: string[] = []
  if (!rows.length) throw new Error('The file is empty.')
  const h = findHeaderRow(rows)
  const headers = rows[h].map((s) => s.trim())
  const detected = detectMapping(headers)
  const mapping: Mapping = {
    fields: { ...detected.fields, ...override?.fields },
    sprint: override?.sprint ?? detected.sprint,
    labels: override?.labels ?? detected.labels,
  }

  const missing = REQUIRED.filter((f) => mapping.fields[f] == null)
  if (missing.length) {
    throw new Error(
      `Couldn't find the ${missing.map((f) => FIELD_LABELS[f]).join(', ')} column${missing.length > 1 ? 's' : ''}. ` +
        'Use a Jira issue export ("Export Excel CSV") or map the columns below.',
    )
  }
  if (mapping.fields.points == null) warnings.push('No story points column found, so completion is measured by issue count.')
  if (!mapping.sprint.length) warnings.push('No Sprint column found, so every row is treated as part of one sprint.')

  const get = (row: string[], f: Field) => {
    const i = mapping.fields[f]
    return i == null ? '' : (row[i] ?? '').trim()
  }

  const issues: Issue[] = []
  const seen = new Set<string>()
  let badDates = 0
  for (const row of rows.slice(h + 1)) {
    const key = get(row, 'key')
    const summary = get(row, 'summary')
    if (!key && !summary) continue
    if (key && seen.has(key)) {
      warnings.push(`${key} appears more than once; only the first row is used.`)
      continue
    }
    seen.add(key)

    let sprints = mapping.sprint.map((i) => (row[i] ?? '').trim()).filter(Boolean)
    // A single Sprint column sometimes holds a comma-separated list.
    if (mapping.sprint.length === 1 && sprints.length === 1 && sprints[0].includes(',')) {
      sprints = sprints[0].split(',').map((s) => s.trim()).filter(Boolean)
    }
    const createdRaw = get(row, 'created')
    const resolvedRaw = get(row, 'resolved')
    const created = parseJiraDate(createdRaw)
    const resolved = parseJiraDate(resolvedRaw)
    if ((createdRaw && created == null) || (resolvedRaw && resolved == null)) badDates++

    issues.push({
      key: key || `ROW-${issues.length + 1}`,
      summary,
      type: get(row, 'type') || 'Issue',
      status: get(row, 'status'),
      statusCategory: get(row, 'statusCategory'),
      resolution: get(row, 'resolution'),
      points: toNumber(get(row, 'points')),
      epic: get(row, 'epic'),
      assignee: get(row, 'assignee'),
      reporter: get(row, 'reporter'),
      priority: get(row, 'priority'),
      created,
      resolved,
      sprints,
      labels: mapping.labels.map((i) => (row[i] ?? '').trim()).filter(Boolean),
      flagged: /^(impediment|yes|true|flagged)$/i.test(get(row, 'flagged')),
    })
  }
  if (!issues.length) throw new Error('No issues found under the header row.')
  if (badDates) warnings.push(`${badDates} date${badDates > 1 ? 's' : ''} couldn't be read and were ignored.`)
  return { headers, issues, mapping, warnings }
}
