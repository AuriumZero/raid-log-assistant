import { describe, expect, it } from 'vitest'
import { parseCsv } from './csv'
import { parseJiraDate } from './dates'
import { readTable } from './table'
import { isStale, nextId, parseLevel, parseLog, parseType, score, type RaidItem } from './raid'
import { similarity, stem, tokens } from './match'
import { sampleFile } from '../test/samples'

describe('reading a RAID log', () => {
  it('reads the sample workbook, with Excel dates', async () => {
    const log = parseLog(await readTable(sampleFile('raid-log.xlsx')))
    expect(log.items).toHaveLength(8)
    expect(log.warnings).toEqual([])
    expect(log.items[0]).toMatchObject({
      id: 'R-001', type: 'Risk', owner: 'Jordan Lee', status: 'Open', probability: 'Medium', impact: 'High',
      raised: Date.UTC(2026, 7, 4), updated: Date.UTC(2026, 7, 20), due: Date.UTC(2026, 9, 31),
    })
    expect(log.columns.mitigation).toBe('Mitigation / action')
  })

  it('accepts other templates: different headers, R/A/I/D codes, percentages', () => {
    const rows = parseCsv('Ref,Category,Summary,Likelihood,Severity,Action owner\n7,R,Thing might break,60%,4,Ana\n,I,Thing broke,,critical,\n,X,Unclear,,,')
    const log = parseLog(rows)
    expect(log.items.map((i) => [i.id, i.type, i.probability, i.impact, i.owner])).toEqual([
      ['7', 'Risk', 'Medium', 'High', 'Ana'],
      ['I-001', 'Issue', '', 'High', ''],
      ['R-001', 'Risk', '', '', ''],
    ])
    expect(log.warnings[0]).toMatch(/1 item had no recognisable type/)
  })

  it('reads the risk sheet exported by Project Management Central', () => {
    const rows = [['ID', 'Risk or issue', 'Type', 'Impact', 'Likelihood', 'Notes'], ['R1', 'Supplier late', 'Risk', 'High', '0.6', 'Chasing']]
    expect(parseLog(rows).items[0]).toMatchObject({ id: 'R1', title: 'Supplier late', impact: 'High', probability: 'Medium', description: 'Chasing' })
  })

  it('explains a file with no title column', () => {
    expect(() => parseLog([['A', 'B'], ['1', '2']])).toThrow(/Title, Summary or Description/)
  })

  it('parses types, levels and day-first dates', () => {
    expect(['risk', 'Assumptions', 'D', 'problem', 'x'].map(parseType)).toEqual(['Risk', 'Assumption', 'Dependency', 'Issue', null])
    expect(['L', 'med', 'Very High', '1', '2', '3', '5', '20%', '0.8', '', 'n/a'].map(parseLevel)).toEqual([
      'Low', 'Medium', 'High', 'Low', 'Medium', 'High', 'High', 'Low', 'High', '', '',
    ])
    expect(parseJiraDate('14/09/2026')).toBe(Date.UTC(2026, 8, 14))
    expect(parseJiraDate('9/14/2026')).toBe(Date.UTC(2026, 8, 14))
  })
})

describe('scores and staleness', () => {
  const base = { type: 'Risk', probability: 'High', impact: 'Medium' } as RaidItem
  it('scores probability × impact, and issues on impact alone', () => {
    expect(score(base)).toBe(6)
    expect(score({ ...base, type: 'Issue', impact: 'High' })).toBe(9)
    expect(score({ ...base, probability: '' })).toBe(4)
    expect(score({ ...base, impact: '' })).toBe(0)
  })

  it('flags open items with no update in 14 days', () => {
    const asOf = Date.UTC(2026, 9, 1)
    const item = { ...base, status: 'Open', updated: Date.UTC(2026, 8, 16), raised: null } as RaidItem
    expect(isStale(item, asOf)).toBe(true)
    expect(isStale({ ...item, updated: Date.UTC(2026, 8, 18) }, asOf)).toBe(false)
    expect(isStale({ ...item, status: 'Closed' }, asOf)).toBe(false)
  })

  it('numbers new items after the log’s own IDs', () => {
    expect(nextId([{ id: 'R-001' }, { id: 'R-009' }, { id: 'I-002' }], 'Risk')).toBe('R-010')
    expect(nextId([{ id: 'R7' }], 'Risk')).toBe('R8')
    expect(nextId([], 'Dependency')).toBe('D-001')
  })
})

describe('matching', () => {
  it('normalises word forms and ignores filler words', () => {
    expect(['arrive', 'arriving', 'arrived'].map(stem)).toEqual(['arriv', 'arriv', 'arriv'])
    expect([...tokens('The orders are arriving late on Mondays')]).toEqual(['order', 'arriv', 'late', 'monday'])
    const s = similarity('Orders feed partitions arrive late on Mondays', 'Priya considers the late-arriving partitions issue resolved')
    expect(s.shared).toEqual(['partition', 'arriv', 'late'])
  })
})
