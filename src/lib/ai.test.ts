import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { buildRequest, callClaude, makeMasker, validateAnswer } from './ai'
import { parseLog, type RaidItem } from './raid'
import { readTable } from './table'
import { sampleFile } from '../test/samples'

let items: RaidItem[]
const weekly = { id: 'w', name: 'weekly.md', kind: 'notes' as const, text: readFileSync('public/samples/weekly-status-2026-09-29.md', 'utf8') }
const jira = { id: 'j', name: 'sprint.csv', kind: 'jira' as const, issues: [] }

beforeAll(async () => {
  items = parseLog(await readTable(sampleFile('raid-log.xlsx'))).items
})

describe('masking', () => {
  it('swaps names and terms for placeholders and restores them', () => {
    const m = makeMasker(['Priya Natarajan'], ['Kafka'])
    const masked = m.mask('Priya Natarajan and priya say Kafka is fine; mail p@x.com or see https://wiki/x')
    expect(masked).toBe('PERSON_1 and PERSON_2 say TERM_1 is fine; mail [email] or see [link]')
    expect(m.unmask('PERSON_1 owns TERM_1')).toBe('Priya Natarajan owns Kafka')
    expect(m.count).toBe(5)
  })
})

describe('the request', () => {
  it('sends notes and open log items only, masked, and never the Jira export', () => {
    const { request, sent } = buildRequest([weekly, jira], items, 'claude-sonnet-5-5', { maskPeople: true, maskTerms: ['Kafka'] })
    const content = request.messages[0].content
    expect(sent).toHaveLength(1)
    expect(content).toMatch(/<notes source_id="S1">/)
    expect(content).not.toMatch(/Priya|Natarajan|Jordan|Kafka/)
    expect(content).toMatch(/PERSON_\d+ to confirm with Procurement/)
    expect(request.tool_choice).toEqual({ type: 'tool', name: 'record_raid_changes' })
  })

  it('posts to the Messages API with the browser-access header', async () => {
    const { request } = buildRequest([weekly], items, 'm', { maskPeople: false, maskTerms: [] })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ content: [{ type: 'tool_use', name: 'record_raid_changes', input: { changes: [] } }] })))
    await expect(callClaude(request, 'k', fetchMock as unknown as typeof fetch)).resolves.toEqual({ changes: [] })
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect((init.headers as Record<string, string>)['anthropic-dangerous-direct-browser-access']).toBe('true')
    const bad = vi.fn(async () => new Response('{}', { status: 401 }))
    await expect(callClaude(request, 'k', bad as unknown as typeof fetch)).rejects.toThrow(/key was rejected/)
  })
})

describe('checking the answer', () => {
  it('restores names, keeps good proposals clean and flags made-up quotes and IDs', () => {
    const built = buildRequest([weekly], items, 'm', { maskPeople: true, maskTerms: [] })
    const owner = built.masker.table.find(([v]) => v === 'Alex Rivera')![1]
    const answer = {
      changes: [
        { action: 'close', existing_id: 'I-002', type: 'Issue', title: 'x', quote: 'the oversized dev warehouse issue can be closed', source_id: 'S1' },
        { action: 'new', type: 'Risk', title: 'Service-visit migration may miss the cutover freeze', owner, probability: 'High', impact: 'High',
          quote: 'the service-visit history migration has carried over twice and might not finish before the cutover freeze on 20 Oct', source_id: 'S1' },
        { action: 'update', existing_id: 'R-099', type: 'Risk', title: 'Budget overrun', quote: 'Budget is 20% over', source_id: 'S1' },
        { action: 'new', type: 'Dependency', title: 'Something', quote: 'x', source_id: 'S9' },
      ],
    }
    const out = validateAnswer(answer, built, items)
    expect(out[0]).toMatchObject({ action: 'close', targetId: 'I-002', title: 'Oversized dev warehouse cluster is driving up cloud costs', flags: [] })
    expect(out[1]).toMatchObject({ action: 'new', owner: 'Alex Rivera', probability: 'High', flags: [] })
    expect(out[2].action).toBe('new')
    expect(out[2].flags.join(' ')).toMatch(/aren't in the notes word for word.*R-099 which isn't in the log/)
    expect(out[3].flags.join(' ')).toMatch(/S9/)
  })

  it('flags a new item that looks like an existing one', () => {
    const built = buildRequest([weekly], items, 'm', { maskPeople: false, maskTerms: [] })
    const out = validateAnswer({ changes: [{ action: 'new', type: 'Risk', title: 'Vendor feed contract renewal might lapse', quote: 'vendor feed contract renewal', source_id: 'S1' }] }, built, items)
    expect(out[0].flags.join(' ')).toMatch(/Looks similar to R-001/)
  })

  it('rejects an answer with no change list', () => {
    const built = buildRequest([weekly], items, 'm', { maskPeople: false, maskTerms: [] })
    expect(() => validateAnswer({ nope: 1 }, built, items)).toThrow(/no list of changes/)
  })
})
