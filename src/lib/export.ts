// Writes the RAID log out as CSV or Excel, and the weekly digest as Markdown.

import { toCsv } from './csv'
import { formatDay } from './dates'
import { daysSince, EXPORT_HEADERS, isClosed, isStale, score, type RaidItem } from './raid'
import { buildXlsx, excelDate, type Cell } from './xlsxWrite'
import { topItems } from './extract'

const dayNumber = (ms: number) => Math.floor(ms / 86_400_000)

function values(i: RaidItem): (string | number | null)[] {
  return [
    i.id, i.type, i.title, i.description, i.owner, i.status, i.probability, i.impact, score(i) || '', i.mitigation,
    i.raised, i.updated, i.due, i.source, i.log.join('\n'),
  ]
}

export function logCsv(items: RaidItem[]): string {
  return toCsv([EXPORT_HEADERS, ...items.map((i) => values(i).map((v, n) => (n >= 10 && n <= 12 && typeof v === 'number' ? new Date(v).toISOString().slice(0, 10) : v)))])
}

// Styles: 0 default, 1 header, 2 wrapped text, 3 date, 4 centered, 5 high score, 6 medium score
const STYLES = [
  {},
  { bold: true, color: '#ffffff', fill: '#0f6e66', valign: 'center' as const },
  { wrap: true, valign: 'top' as const },
  { numFmt: 'mmm d, yyyy', valign: 'top' as const, align: 'left' as const },
  { align: 'center' as const, valign: 'top' as const },
  { align: 'center' as const, valign: 'top' as const, bold: true, fill: '#f6d5cf' },
  { align: 'center' as const, valign: 'top' as const, fill: '#fbecc8' },
]

export function logXlsx(items: RaidItem[]): Uint8Array {
  const rows: (Cell | null)[][] = [EXPORT_HEADERS.map((h) => ({ v: h, s: 1 }))]
  for (const i of items) {
    const s = score(i)
    rows.push(
      values(i).map((v, n): Cell => {
        if (n >= 10 && n <= 12) return typeof v === 'number' ? { v: excelDate(dayNumber(v)), s: 3 } : { v: '', s: 2 }
        if (n === 8) return { v: v ?? '', s: s >= 6 ? 5 : s >= 3 ? 6 : 4 }
        if (n === 1 || n === 5 || n === 6 || n === 7) return { v: v ?? '', s: 4 }
        return { v: v ?? '', s: 2 }
      }),
    )
  }
  return buildXlsx({
    styles: STYLES,
    sheets: [
      {
        name: 'RAID log',
        cols: [8, 12, 44, 40, 16, 12, 11, 9, 7, 36, 13, 13, 13, 22, 60],
        rows,
        freeze: { rows: 1, cols: 0 },
        autoFilter: `A1:O${items.length + 1}`,
        landscape: true,
      },
    ],
  })
}

/** A short weekly digest: top items, stale items and what changed. */
export function digestMarkdown(items: RaidItem[], asOf: number, changes: string[]): string {
  const open = items.filter((i) => !isClosed(i.status))
  const count = (t: string) => open.filter((i) => i.type === t).length
  const out = [
    `## RAID digest, ${formatDay(asOf)}`,
    '',
    `**${open.length} open items**: ${count('Risk')} risks, ${count('Issue')} issues, ${count('Dependency')} dependencies, ${count('Assumption')} assumptions.`,
    '',
    '### Top items',
    ...topItems(items).map((i) => `- **${i.id}** ${i.title} (${i.type}${score(i) ? `, score ${score(i)}/9` : ''}${i.owner ? `, ${i.owner}` : ''})`),
    '',
  ]
  const stale = open.filter((i) => isStale(i, asOf))
  if (stale.length) {
    out.push('### Needs an update', ...stale.map((i) => `- **${i.id}** ${i.title}: no update for ${daysSince(i.updated ?? i.raised, asOf)} days${i.owner ? ` (${i.owner})` : ''}`), '')
  }
  if (changes.length) out.push('### Changes this week', ...changes.map((c) => `- ${c}`), '')
  return out.join('\n').trim() + '\n'
}
