// Reads meeting notes with Claude, from the browser, using the visitor's own
// API key. Only notes are sent: Jira exports are handled by rules, since their
// structure makes AI unnecessary.
//
// Before sending, names and listed terms are swapped for placeholders (PERSON_1,
// TERM_1) and restored in the answer, and emails and links are removed. After
// the answer comes back, every proposal is checked: its quote must appear in the
// source it cites, and any item it updates or closes must exist in the log.

import { bestMatch, indexItems, type Action, type Proposal, type Source } from './extract'
import { isClosed, parseLevel, parseType, type RaidItem } from './raid'

export const DEFAULT_MODEL = 'claude-sonnet-5-5'
export const MODEL_OPTIONS = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-4-5-20251001']
const TOOL_NAME = 'record_raid_changes'

export const SYSTEM_PROMPT = `You maintain a project RAID log (Risks, Assumptions, Issues, Dependencies).
You are given the open items in the current log and one or more sets of meeting notes.
Find every change the notes imply for the log:
- "update": new information about an existing item (progress, a new date, a change in likelihood or impact, a new owner).
- "close": the notes say an existing item is resolved, done, no longer relevant, or an assumption was confirmed.
- "new": a risk, assumption, issue or dependency that isn't in the log yet.

Definitions: a Risk might happen; an Issue is happening now; an Assumption is something the plan takes as true without proof; a Dependency is something the team needs from someone else.

Rules:
- Every change must quote the exact words from the notes it is based on, copied verbatim, and name the source_id.
- Use existing_id for updates and closes. Don't create a new item for something already in the log.
- Ignore decisions, attendance and status updates that don't affect risk.
- Don't invent owners, dates or numbers. Leave owner empty if the notes don't name one.
- Text like PERSON_1 or TERM_2 stands for a masked name or term. Copy it exactly as written.`

const LEVEL = { type: 'string', enum: ['Low', 'Medium', 'High', ''] }

export const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    changes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['new', 'update', 'close'] },
          existing_id: { type: 'string', description: 'ID of the log item, for update and close.' },
          type: { type: 'string', enum: ['Risk', 'Assumption', 'Issue', 'Dependency'] },
          title: { type: 'string', description: 'A short, specific title for a new item. For updates, the existing title.' },
          owner: { type: 'string' },
          probability: { ...LEVEL, description: 'Risks only.' },
          impact: LEVEL,
          mitigation: { type: 'string', description: 'The action or response the notes mention, if any.' },
          quote: { type: 'string', description: 'The exact words from the notes, copied verbatim.' },
          source_id: { type: 'string' },
          reason: { type: 'string', description: 'One sentence on why this changes the log.' },
        },
        required: ['action', 'type', 'title', 'quote', 'source_id'],
      },
    },
  },
  required: ['changes'],
} as const

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Swaps names and terms for placeholders, and back. */
export function makeMasker(people: string[], terms: string[]) {
  const table: [string, string][] = []
  const add = (value: string, prefix: string) => {
    const v = value.trim()
    if (v.length < 3 || table.some(([x]) => x.toLowerCase() === v.toLowerCase())) return
    table.push([v, `${prefix}_${table.filter(([, t]) => t.startsWith(prefix)).length + 1}`])
  }
  // Full names first, then first names on their own, so "Priya" maps to the same person.
  for (const p of people) add(p, 'PERSON')
  for (const p of people) {
    const first = p.trim().split(/\s+/)[0]
    if (first && first !== p.trim()) add(first, 'PERSON')
  }
  for (const t of terms) add(t, 'TERM')
  const sorted = [...table].sort((a, b) => b[0].length - a[0].length)
  const forward = sorted.length ? new RegExp(`\\b(${sorted.map(([v]) => escape(v)).join('|')})\\b`, 'gi') : null
  const lookup = new Map(table.map(([v, t]) => [v.toLowerCase(), t]))
  const reverse = new Map(table.map(([v, t]) => [t, v]))
  let count = 0
  return {
    mask(text: string): string {
      let out = text
        .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, () => (count++, '[email]'))
        .replace(/\bhttps?:\/\/\S+/gi, () => (count++, '[link]'))
      if (forward) out = out.replace(forward, (m) => (count++, lookup.get(m.toLowerCase()) ?? m))
      return out
    },
    unmask: (text: string) => text.replace(/\b(PERSON|TERM)_\d+\b/g, (t) => reverse.get(t) ?? t),
    get count() {
      return count
    },
    table,
  }
}

export interface AiOptions {
  maskPeople: boolean
  maskTerms: string[]
}

export function buildRequest(sources: Source[], items: RaidItem[], model: string, opts: AiOptions) {
  const people = opts.maskPeople ? items.map((i) => i.owner).filter(Boolean) : []
  const masker = makeMasker(people, opts.maskTerms)
  const notes = sources.filter((s) => s.kind === 'notes')
  const sent = notes.map((s, i) => ({ id: `S${i + 1}`, name: s.name, sourceId: s.id, text: masker.mask(s.text ?? '') }))
  const log = items
    .filter((i) => !isClosed(i.status))
    .map((i) => ({ id: i.id, type: i.type, title: masker.mask(i.title), status: i.status, owner: masker.mask(i.owner) }))
  const content =
    `<raid_log>\n${JSON.stringify(log, null, 2)}\n</raid_log>\n\n` +
    sent.map((s) => `<notes source_id="${s.id}">\n${s.text}\n</notes>`).join('\n\n') +
    `\n\nRecord every change these notes imply for the RAID log by calling the ${TOOL_NAME} tool.`
  return {
    request: {
      model,
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      tools: [{ name: TOOL_NAME, description: 'Record proposed changes to the RAID log.', input_schema: OUTPUT_SCHEMA }],
      tool_choice: { type: 'tool', name: TOOL_NAME } as { type: 'tool' | 'auto'; name?: string },
      messages: [{ role: 'user', content }],
    },
    sent,
    masker,
  }
}

export class AiError extends Error {}

export async function callClaude(request: Request, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  let body = await post(request, apiKey, fetchImpl)
  // Some models (for example with extended thinking on by default) don't accept a
  // forced tool call. Ask again with the tool offered but not forced; the prompt
  // still tells the model to use it.
  if ('retryWithoutForcing' in body) body = await post({ ...request, tool_choice: { type: 'auto' } }, apiKey, fetchImpl)
  if ('retryWithoutForcing' in body) throw new AiError(body.message)
  const content = body.content ?? []
  const tool = content.find((c) => c.type === 'tool_use' && c.name === TOOL_NAME)
  if (tool) return tool.input
  // No tool call: accept a JSON object written as plain text instead.
  const text = content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n')
  const json = text.replace(/```(?:json)?/g, '')
  const start = json.indexOf('{')
  const end = json.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(json.slice(start, end + 1))
    } catch {
      /* fall through */
    }
  }
  throw new AiError('The model did not return changes in the expected format.')
}

type Request = ReturnType<typeof buildRequest>['request']
type ApiBody = { content?: { type: string; name?: string; input?: unknown; text?: string }[] }

async function post(request: Request, apiKey: string, fetchImpl: typeof fetch): Promise<ApiBody | { retryWithoutForcing: true; message: string }> {
  let res: Response
  try {
    res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        // Required for calls made straight from a web page. The key stays in this
        // tab's memory and is sent only to api.anthropic.com.
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(request),
    })
  } catch {
    throw new AiError('Could not reach the Claude API. Check your connection and try again.')
  }
  if (!res.ok) {
    let detail = ''
    try {
      detail = ((await res.json()) as { error?: { message?: string } }).error?.message ?? ''
    } catch {
      /* not JSON */
    }
    const message = `The API returned an error (${res.status})${detail ? `: ${detail}` : ''}.`
    if (res.status === 400 && /tool_choice/i.test(detail) && request.tool_choice.type === 'tool') return { retryWithoutForcing: true, message }
    if (res.status === 401) throw new AiError('The API key was rejected. Check that it was copied in full.')
    if (res.status === 404) throw new AiError(`Model not found${detail ? `: ${detail}` : ''}. Try another model.`)
    if (res.status === 429) throw new AiError('Rate limited by the API. Wait a moment and try again.')
    throw new AiError(message)
  }
  return (await res.json()) as ApiBody
}

/** Lower case, straight quotes, single spaces: so a quote still matches after small formatting differences. */
const flat = (s: string) =>
  s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim()

let counter = 0

/** Turns the model's answer into proposals, checking each one against the notes and the log. */
export function validateAnswer(raw: unknown, built: ReturnType<typeof buildRequest>, items: RaidItem[]): Proposal[] {
  const changes = (raw as { changes?: unknown })?.changes
  if (!Array.isArray(changes)) throw new AiError('The model returned no list of changes.')
  const byId = new Map(items.map((i) => [i.id, i]))
  const index = indexItems(items)
  const { unmask } = built.masker
  const out: Proposal[] = []

  for (const c of changes) {
    if (!c || typeof c !== 'object') continue
    const r = c as Record<string, unknown>
    const str = (k: string) => (typeof r[k] === 'string' ? unmask((r[k] as string).trim()) : '')
    const flags: string[] = []
    const source = built.sent.find((s) => s.id === r.source_id)
    const quoteMasked = typeof r.quote === 'string' ? r.quote : ''
    if (!source) flags.push(`Cites a source (${String(r.source_id)}) that wasn't sent.`)
    else if (!quoteMasked || !flat(source.text).includes(flat(quoteMasked))) flags.push("The quoted words aren't in the notes word for word. Check the source before accepting.")

    let action: Action = r.action === 'update' || r.action === 'close' ? r.action : 'new'
    const existing = typeof r.existing_id === 'string' ? byId.get(r.existing_id.trim()) : undefined
    if (action !== 'new' && !existing) {
      flags.push(`Refers to ${String(r.existing_id || 'an item')} which isn't in the log, so it's shown as a new item.`)
      action = 'new'
    }
    const type = parseType(str('type')) ?? existing?.type ?? 'Risk'
    const title = existing && action !== 'new' ? existing.title : str('title')
    if (!title) continue
    if (action === 'new') {
      const near = bestMatch(title, index)
      if (near) flags.push(`Looks similar to ${near.item.id} ("${near.item.title}"). Consider updating that instead.`)
    }
    let owner = str('owner') || (existing?.owner ?? '')
    // "Jordan" in the notes is the "Jordan Lee" who already owns the item.
    if (existing?.owner && existing.owner.toLowerCase().split(/\s+/).includes(owner.toLowerCase())) owner = existing.owner
    if (action === 'new' && !owner) flags.push('No owner named in the source.')
    const prob = parseLevel(str('probability'))
    const impact = parseLevel(str('impact'))
    const reason = str('reason')
    out.push({
      id: `ai${++counter}`,
      action,
      type,
      title,
      description: action === 'new' ? reason : existing?.description ?? '',
      owner,
      probability: type === 'Risk' ? prob || existing?.probability || 'Medium' : '',
      impact: impact || existing?.impact || 'Medium',
      mitigation: str('mitigation') || existing?.mitigation || '',
      quotes: [{ sourceId: source?.sourceId ?? '', sourceName: source?.name ?? 'Unknown source', text: unmask(quoteMasked) }],
      targetId: action === 'new' ? undefined : existing!.id,
      engine: 'ai',
      flags,
    })
  }
  return out
}
