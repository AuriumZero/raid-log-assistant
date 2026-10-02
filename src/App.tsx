import { useMemo, useState } from 'react'
import { LogTable } from './components/LogTable'
import { Markdown } from './components/Markdown'
import { Review, type Decision } from './components/Review'
import { AiError, buildRequest, callClaude, DEFAULT_MODEL, MODEL_OPTIONS, validateAnswer } from './lib/ai'
import { fromInputDate, toInputDate } from './lib/dates'
import { digestMarkdown, logCsv, logXlsx } from './lib/export'
import { applyProposals, extractFromJira, extractFromNotes, mergeProposals, type Proposal, type Source } from './lib/extract'
import { parseExport } from './lib/jira'
import { isClosed, isStale, parseLog, type RaidItem } from './lib/raid'
import { readTable } from './lib/table'

const BASE = import.meta.env.BASE_URL
const SAMPLE_AS_OF = '2026-10-01'
const NOTE_SAMPLES = ['weekly-status-2026-09-29.md', 'steering-committee-2026-09-30.txt']
const JIRA_SAMPLE = 'data-platform-sprint-23.csv'

function download(name: string, data: BlobPart, type: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([data], { type }))
  a.download = name
  a.click()
  URL.revokeObjectURL(a.href)
}

let sourceCounter = 0

export default function App({ fetchImpl }: { fetchImpl?: typeof fetch }) {
  const doFetch = fetchImpl ?? fetch
  const [items, setItems] = useState<RaidItem[] | null>(null)
  const [logName, setLogName] = useState('')
  const [logWarnings, setLogWarnings] = useState<string[]>([])
  const [asOf, setAsOf] = useState(toInputDate(Date.now()))
  const [sources, setSources] = useState<Source[]>([])
  const [pasted, setPasted] = useState('')
  const [proposals, setProposals] = useState<Proposal[] | null>(null)
  const [decisions, setDecisions] = useState<Record<string, Decision>>({})
  const [history, setHistory] = useState<string[]>([])
  const [changed, setChanged] = useState<Set<string>>(new Set())
  const [error, setError] = useState('')
  const [engine, setEngine] = useState<'rules' | 'ai'>('rules')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState(DEFAULT_MODEL)
  const [maskPeople, setMaskPeople] = useState(true)
  const [terms, setTerms] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  const asOfMs = fromInputDate(asOf) ?? Date.now()
  const aiOptions = useMemo(() => ({ maskPeople, maskTerms: terms.split(/[\n,]/).map((t) => t.trim()).filter(Boolean) }), [maskPeople, terms])
  const preview = useMemo(
    () => (items && engine === 'ai' && sources.some((s) => s.kind === 'notes') ? buildRequest(sources, items, model, aiOptions) : null),
    [items, engine, sources, model, aiOptions],
  )

  function loadLog(name: string, rows: string[][]) {
    const log = parseLog(rows)
    setItems(log.items)
    setLogName(name)
    setLogWarnings(log.warnings)
    setProposals(null)
    setDecisions({})
    setHistory([])
    setChanged(new Set())
    setError('')
  }

  async function openLog(file: File) {
    try {
      loadLog(file.name, await readTable(file, /raid|risk|issue/i))
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function fetchSample(name: string) {
    const res = await doFetch(`${BASE}samples/${name}`)
    if (!res.ok) throw new Error('Could not load the sample file.')
    return res
  }

  async function sampleLog() {
    try {
      const buf = await (await fetchSample('raid-log.xlsx')).arrayBuffer()
      loadLog('raid-log.xlsx (sample)', await readTable({ name: 'raid-log.xlsx', arrayBuffer: async () => buf }))
      setAsOf(SAMPLE_AS_OF)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  function newLog() {
    setItems([])
    setLogName('New log')
    setLogWarnings([])
    setProposals(null)
    setHistory([])
  }

  const addSource = (s: Omit<Source, 'id'>) => setSources((list) => [...list.filter((x) => x.name !== s.name), { ...s, id: `s${++sourceCounter}` }])

  async function addFile(file: File) {
    try {
      if (/\.(csv|xlsx)$/i.test(file.name)) {
        const issues = parseExport(await readTable(file)).issues
        addSource({ name: file.name, kind: 'jira', issues })
      } else {
        addSource({ name: file.name, kind: 'notes', text: await file.text() })
      }
      setError('')
    } catch (e) {
      setError(`${file.name}: ${(e as Error).message}`)
    }
  }

  async function sampleSources() {
    try {
      for (const name of NOTE_SAMPLES) addSource({ name, kind: 'notes', text: await (await fetchSample(name)).text() })
      const buf = await (await fetchSample(JIRA_SAMPLE)).arrayBuffer()
      addSource({ name: JIRA_SAMPLE, kind: 'jira', issues: parseExport(await readTable({ name: JIRA_SAMPLE, arrayBuffer: async () => buf })).issues })
    } catch (e) {
      setError((e as Error).message)
    }
  }

  function addPasted() {
    if (!pasted.trim()) return
    const n = sources.filter((s) => s.name.startsWith('Pasted notes')).length + 1
    addSource({ name: `Pasted notes ${n}`, kind: 'notes', text: pasted })
    setPasted('')
  }

  async function findChanges() {
    if (!items) return
    setError('')
    const jira = sources.filter((s) => s.kind === 'jira').flatMap((s) => extractFromJira(s, items))
    let notes: Proposal[] = []
    if (engine === 'rules') {
      notes = sources.filter((s) => s.kind === 'notes').flatMap((s) => extractFromNotes(s, items))
    } else if (preview) {
      setBusy(true)
      try {
        notes = validateAnswer(await callClaude(preview.request, apiKey.trim(), fetchImpl), preview, items)
      } catch (e) {
        setError(e instanceof AiError ? e.message : 'Something went wrong while reading the notes.')
        setBusy(false)
        return
      }
      setBusy(false)
    }
    setProposals(mergeProposals([...notes, ...jira]))
    setDecisions({})
  }

  function apply() {
    if (!items || !proposals) return
    const accepted = proposals.filter((p) => decisions[p.id] === 'accepted')
    const before = new Set(items.map((i) => i.id))
    const result = applyProposals(items, accepted, asOfMs)
    setItems(result.items)
    setHistory((h) => [...h, ...result.changes])
    setChanged(new Set([...accepted.flatMap((p) => (p.targetId ? [p.targetId] : [])), ...result.items.filter((i) => !before.has(i.id)).map((i) => i.id)]))
    setProposals(null)
    setDecisions({})
    setSources([])
  }

  const digest = items ? digestMarkdown(items, asOfMs, history) : ''
  const open = items?.filter((i) => !isClosed(i.status)) ?? []
  const stale = open.filter((i) => isStale(i, asOfMs)).length
  const fileBase = `raid-log-${asOf}`

  async function copyDigest() {
    try {
      await navigator.clipboard.writeText(digest)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setError('Copy was blocked by the browser.')
    }
  }

  // Claude needs a key only when there are notes to send; Jira exports always use rules.
  const canRun = !!items && sources.length > 0 && !busy && (engine === 'rules' || !preview || !!apiKey.trim())

  return (
    <div className="page">
      <header className="top">
        <div>
          <h1>RAID Log Assistant</h1>
          <p className="lede">
            Keep a RAID log current without retyping meeting notes. It reads notes and Jira exports, proposes new risks, assumptions,
            issues and dependencies, updates and closures, and changes nothing until you approve each one.
          </p>
        </div>
        <p className="badge">
          <span aria-hidden="true">●</span> Runs in your browser. Nothing is uploaded or stored.
        </p>
      </header>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <section className="card" aria-labelledby="log-h">
        <div className="card-head">
          <h2 id="log-h">1. Your RAID log</h2>
          <label className="field inline">
            <span>As of</span>
            <input className="input" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </label>
        </div>
        {!items ? (
          <>
            <label className="drop">
              <input
                type="file"
                accept=".csv,.xlsx"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) void openLog(f)
                  e.target.value = ''
                }}
              />
              <b>Open your RAID log (.xlsx or .csv)</b>
              <small>Most templates work: columns are matched by name (Title or Summary, Owner, Likelihood or Probability, and so on).</small>
            </label>
            <div className="samples">
              <button className="btn small" onClick={sampleLog}>Use the sample log</button>
              <button className="btn small" onClick={newLog}>Start an empty log</button>
            </div>
          </>
        ) : (
          <>
            <p className="loaded">
              <span>
                <b>{logName}</b>: {open.length} open item{open.length === 1 ? '' : 's'}
                {stale > 0 && <span className="warn-inline"> · {stale} with no update in 14+ days</span>}
              </span>
              {logWarnings.map((w) => (
                <span key={w} className="warn-line">
                  {w}
                </span>
              ))}
            </p>
            <LogTable items={items} asOf={asOfMs} changed={changed} />
            <div className="tools export">
              <button className="btn small" onClick={() => download(`${fileBase}.xlsx`, logXlsx(items) as BlobPart, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')}>
                Download .xlsx
              </button>
              <button className="btn small" onClick={() => download(`${fileBase}.csv`, logCsv(items), 'text/csv')}>Download .csv</button>
              <button className="btn small ghost" onClick={() => setItems(null)}>Open a different log</button>
            </div>
          </>
        )}
      </section>

      {items && (
        <section className="card" aria-labelledby="src-h">
          <h2 id="src-h">2. Add what's new</h2>
          <div className="src-grid">
            <div className="stack">
              <label className="field">
                <span>Paste meeting notes, a status update or an email</span>
                <textarea className="input" rows={5} value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder={'Risk: the vendor may miss the 15 Oct date. Owner: Ana\nWe are waiting on Legal to approve the contract.'} />
              </label>
              <div className="tools">
                <button className="btn small" onClick={addPasted} disabled={!pasted.trim()}>Add notes</button>
                <label className="btn small file-btn">
                  Add files…
                  <input
                    type="file"
                    multiple
                    accept=".txt,.md,.csv,.xlsx"
                    onChange={(e) => {
                      for (const f of Array.from(e.target.files ?? [])) void addFile(f)
                      e.target.value = ''
                    }}
                  />
                </label>
                <button className="btn small ghost" onClick={sampleSources}>Add sample notes and Jira export</button>
              </div>
              <p className="hint">Text and Markdown files are read as notes. A .csv or .xlsx is read as a Jira issue export: blocked work becomes issues and repeated carryover becomes risks.</p>
            </div>
            <div className="stack">
              <span className="label">Sources ({sources.length})</span>
              {sources.length === 0 && <p className="empty">None yet.</p>}
              <ul className="sources">
                {sources.map((s) => (
                  <li key={s.id}>
                    <span className={`kind ${s.kind}`}>{s.kind === 'jira' ? 'Jira' : 'Notes'}</span>
                    <span className="sname">{s.name}</span>
                    <span className="muted small">{s.kind === 'jira' ? `${s.issues?.length ?? 0} issues` : `${s.text?.split(/\s+/).filter(Boolean).length ?? 0} words`}</span>
                    <button className="btn ghost small" aria-label={`Remove ${s.name}`} onClick={() => setSources((l) => l.filter((x) => x.id !== s.id))}>
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="engine-row">
            <div className="seg" role="group" aria-label="Read notes with">
              <button aria-pressed={engine === 'rules'} onClick={() => setEngine('rules')}>Rules (offline)</button>
              <button aria-pressed={engine === 'ai'} onClick={() => setEngine('ai')}>Claude</button>
            </div>
            <span className="hint">
              {engine === 'rules'
                ? 'Cue words and similarity to existing items. No AI, no API key, nothing leaves the page.'
                : 'Claude reads the notes for context the rules miss. Jira exports are still handled by rules and never sent.'}
            </span>
          </div>

          {engine === 'ai' && (
            <div className="ai-box">
              <div className="ai-grid">
                <div className="field">
                  <label className="field">
                    <span>Anthropic API key</span>
                    <input className="input" type="password" autoComplete="off" spellCheck={false} placeholder="sk-ant-…" aria-describedby="key-note" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
                  </label>
                  <small id="key-note">Kept in this tab's memory only and sent only to api.anthropic.com.</small>
                </div>
                <label className="field">
                  <span>Model</span>
                  <input className="input mono" list="models" value={model} onChange={(e) => setModel(e.target.value)} />
                  <datalist id="models">
                    {MODEL_OPTIONS.map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                </label>
              </div>
              <fieldset className="redaction">
                <legend>Before anything is sent</legend>
                <label className="check">
                  <input type="checkbox" checked={maskPeople} onChange={(e) => setMaskPeople(e.target.checked)} />
                  Replace the names of owners in the log with placeholders (PERSON_1…) and put them back in the answer
                </label>
                <label className="field">
                  <span>Also replace these terms (client, product or system names), one per line or comma-separated</span>
                  <textarea className="input" rows={2} value={terms} onChange={(e) => setTerms(e.target.value)} placeholder="e.g. Contoso, Project Falcon" />
                </label>
                {preview ? (
                  <details className="payload">
                    <summary>
                      Preview exactly what will be sent: {preview.sent.length} set{preview.sent.length === 1 ? '' : 's'} of notes, {preview.masker.count} replacement
                      {preview.masker.count === 1 ? '' : 's'}
                    </summary>
                    <pre className="mono">{preview.request.messages[0].content}</pre>
                  </details>
                ) : (
                  <p className="hint">Add some notes to preview what would be sent.</p>
                )}
              </fieldset>
            </div>
          )}

          <div className="tools">
            <button className="btn primary" disabled={!canRun} onClick={findChanges}>
              {busy ? 'Reading…' : engine === 'ai' ? 'Find changes with Claude' : 'Find changes'}
            </button>
          </div>
        </section>
      )}

      {items && proposals && (
        <Review
          proposals={proposals}
          decisions={decisions}
          items={items}
          onDecide={(id, d) => setDecisions((m) => ({ ...m, [id]: d }))}
          onDecideAll={(d) => setDecisions(Object.fromEntries(proposals.map((p) => [p.id, d])))}
          onEdit={(id, patch) => setProposals((list) => list!.map((p) => (p.id === id ? { ...p, ...patch } : p)))}
          onApply={apply}
        />
      )}

      {items && items.length > 0 && (
        <section className="card" aria-labelledby="digest-h">
          <div className="card-head">
            <h2 id="digest-h">Weekly digest</h2>
            <button className="btn small" onClick={copyDigest}>{copied ? 'Copied' : 'Copy Markdown'}</button>
          </div>
          <article className="doc" aria-label="Digest">
            <Markdown source={digest} />
          </article>
        </section>
      )}

      <footer className="foot">
        Sample data is synthetic. <a href="https://github.com/AuriumZero/raid-log-assistant">Source on GitHub</a> · Companion to the{' '}
        <a href="https://auriumzero.github.io/sprint-summary-generator/">Sprint Summary Generator</a>
      </footer>
    </div>
  )
}
