import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { applyProposals, classify, extractFromJira, extractFromNotes, findOwner, isClosing, mergeProposals, statements, topItems, type Proposal } from './extract'
import { parseExport } from './jira'
import { parseLog, type RaidItem } from './raid'
import { readTable } from './table'
import { sampleFile } from '../test/samples'

let items: RaidItem[]
let proposals: Proposal[]
const notes = (f: string) => ({ id: f, name: f, kind: 'notes' as const, text: readFileSync(`public/samples/${f}`, 'utf8') })
const ASOF = Date.UTC(2026, 9, 1)

beforeAll(async () => {
  items = parseLog(await readTable(sampleFile('raid-log.xlsx'))).items
  proposals = mergeProposals([
    ...extractFromNotes(notes('weekly-status-2026-09-29.md'), items),
    ...extractFromNotes(notes('steering-committee-2026-09-30.txt'), items),
  ])
})

describe('reading notes', () => {
  it('splits bullets and sentences, keeping "This is…" with the sentence before', () => {
    const s = statements('- First thing is late. This is a big risk for us.\n* Owner: Sam\n\nAnother line with four words')
    expect(s.map((x) => x.text)).toEqual(['First thing is late. This is a big risk for us.', 'Another line with four words'])
  })

  it('classifies by prefix first, then by cue words', () => {
    expect(classify('Risk: something')).toMatchObject({ type: 'Risk', explicit: true, body: 'something' })
    expect(classify('Decision: we risk it')).toMatchObject({ skip: true })
    expect(classify('We are waiting on Legal for the contract')).toMatchObject({ type: 'Dependency' })
    expect(classify('We are assuming the API stays stable')).toMatchObject({ type: 'Assumption' })
    expect(classify('The nightly load failed twice')).toMatchObject({ type: 'Issue' })
    expect(classify('The vendor might be late')).toMatchObject({ type: 'Risk' })
    expect(classify('Lunch was good today')).toMatchObject({ type: null })
  })

  it('finds owners and tells closing remarks from questions about closing', () => {
    expect(findOwner('Fix the thing. Owner: Alex Rivera.')).toEqual({ name: 'Alex Rivera', explicit: true })
    expect(findOwner('Mei to chase Finance')).toEqual({ name: 'Mei', explicit: false })
    expect(isClosing('The issue is resolved')).toBe(true)
    expect(isClosing('Confirm whether the contract has been signed')).toBe(false)
    expect(isClosing('It has not been approved yet')).toBe(false)
  })
})

describe('proposals from the sample notes', () => {
  const summary = () => proposals.map((p) => `${p.action} ${p.targetId ?? p.type}`)

  it('finds the expected new items, updates and closures, and nothing else', () => {
    expect(summary()).toEqual([
      'update R-002', 'close I-001', 'close I-002', 'new Risk', 'update A-001', 'new Assumption',
      'update R-003', 'update R-001', 'update D-001', 'new Issue',
    ])
  })

  it('merges two notes about the same item and keeps both quotes', () => {
    const r2 = proposals.find((p) => p.targetId === 'R-002')!
    expect(r2.quotes.map((q) => q.sourceName)).toEqual(['weekly-status-2026-09-29.md', 'steering-committee-2026-09-30.txt'])
    expect(r2.quotes[1].text).toMatch(/This is a major risk/)
  })

  it('takes owners from the notes but keeps an existing full name', () => {
    expect(proposals.find((p) => p.action === 'new' && p.type === 'Risk')!.owner).toBe('Alex Rivera')
    expect(proposals.find((p) => p.targetId === 'R-001')!.owner).toBe('Jordan Lee')
    expect(proposals.find((p) => p.action === 'new' && p.type === 'Assumption')!.flags).toEqual(['No owner named in the source.'])
  })

  it('shows which words linked a note to an item', () => {
    expect(proposals.find((p) => p.targetId === 'R-001')!.match!.shared).toEqual(['jordan', 'vendor', 'feed', 'contract', 'renewal'])
  })
})

describe('proposals from a Jira export', () => {
  it('raises blocked work as an issue (or an update when tracked) and repeated carryover as a risk', async () => {
    const issues = parseExport(await readTable(sampleFile('data-platform-sprint-23.csv'))).issues
    const out = extractFromJira({ id: 'j', name: 'sprint.csv', kind: 'jira', issues }, items)
    expect(out.map((p) => `${p.action} ${p.targetId ?? p.type}: ${p.title}`)).toEqual([
      'update A-001: Finance will provide the cost-center list by end of September',
      'new Risk: Proof of concept: streaming ingestion for clickstream has carried over 2 sprints and may slip again (DPLAT-433)',
    ])
    expect(out[0].quotes[0].text).toBe('DPLAT-427 "Tag every job with a cost-center label": status Blocked, flagged, in 2 sprints, 3 pts')
  })
})

describe('applying', () => {
  it('adds, updates and closes items with a dated history, and leaves the input alone', () => {
    const accepted = proposals.filter((p) => ['R-002', 'I-001'].includes(p.targetId ?? '') || (p.action === 'new' && p.type === 'Risk'))
    const { items: next, changes } = applyProposals(items, accepted, ASOF)
    expect(changes).toEqual([
      'Updated R-002: new note added',
      'Closed I-001: Orders feed partitions arrive late on Mondays',
      'Added R-004 (Risk): The service-visit history migration has carried over twice and might not finish before the cutover freeze on 20 Oct',
    ])
    expect(next).toHaveLength(9)
    expect(next.find((i) => i.id === 'I-001')!.status).toBe('Closed')
    expect(next.find((i) => i.id === 'R-002')!.log[0]).toMatch(/^2026-10-01 Update\. weekly-status-2026-09-29\.md: "The fix is in/)
    expect(next.find((i) => i.id === 'R-004')).toMatchObject({ owner: 'Alex Rivera', raised: ASOF, status: 'Open', source: 'weekly-status-2026-09-29.md' })
    expect(items.find((i) => i.id === 'I-001')!.status).toBe('In progress')
  })

  it('records edits a reviewer made', () => {
    const p = { ...proposals.find((x) => x.targetId === 'R-003')!, impact: 'High' as const, owner: 'Mei Tanaka' }
    expect(applyProposals(items, [p], ASOF).changes).toEqual(['Updated R-003: owner Sam Okafor → Mei Tanaka, impact Medium → High'])
  })

  it('ranks open items for the digest', () => {
    expect(topItems(items).map((i) => i.id)).toEqual(['R-002', 'R-001', 'D-001', 'I-001', 'A-001'])
  })
})
