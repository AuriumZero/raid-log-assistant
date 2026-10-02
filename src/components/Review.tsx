import type { Proposal } from '../lib/extract'
import { originalWords } from '../lib/match'
import { LEVELS, TYPES, type Level, type RaidItem, type RaidType } from '../lib/raid'

export type Decision = 'accepted' | 'rejected' | undefined

interface Props {
  proposals: Proposal[]
  decisions: Record<string, Decision>
  items: RaidItem[]
  onDecide: (id: string, d: Decision) => void
  onEdit: (id: string, patch: Partial<Proposal>) => void
  onApply: () => void
  onDecideAll: (d: Decision) => void
}

const ACTION_LABEL = { new: 'New', update: 'Update', close: 'Close' }

function LevelSelect({ label, value, onChange }: { label: string; value: Level; onChange: (v: Level) => void }) {
  return (
    <label className="field small">
      <span>{label}</span>
      <select className="input" value={value} onChange={(e) => onChange(e.target.value as Level)}>
        <option value="">–</option>
        {LEVELS.map((l) => (
          <option key={l}>{l}</option>
        ))}
      </select>
    </label>
  )
}

export function Review({ proposals, decisions, items, onDecide, onEdit, onApply, onDecideAll }: Props) {
  const accepted = proposals.filter((p) => decisions[p.id] === 'accepted').length
  const undecided = proposals.filter((p) => !decisions[p.id]).length
  const byId = new Map(items.map((i) => [i.id, i]))

  return (
    <section className="card" aria-labelledby="review-h">
      <div className="card-head">
        <div>
          <h2 id="review-h">3. Review proposed changes</h2>
          <p className="hint">
            Nothing changes in the log until you accept it. Edit anything before accepting: titles, owners, ratings, or the type of a new item.
          </p>
        </div>
        <div className="tools">
          <button className="btn small" onClick={() => onDecideAll('accepted')}>Accept all</button>
          <button className="btn small" onClick={() => onDecideAll('rejected')}>Reject all</button>
        </div>
      </div>

      {proposals.length === 0 && <p className="empty">No changes found in these sources.</p>}
      <ol className="proposals">
        {proposals.map((p) => {
          const d = decisions[p.id]
          const target = p.targetId ? byId.get(p.targetId) : undefined
          return (
            <li key={p.id} className={`proposal ${p.action}${d ? ` ${d}` : ''}`} aria-label={`${ACTION_LABEL[p.action]} ${target ? target.id : p.type}: ${p.title}`}>
              <div className="p-head">
                <span className={`badge-action ${p.action}`}>{ACTION_LABEL[p.action]}</span>
                {target ? (
                  <span className="mono target">
                    {target.id} · {target.type}
                  </span>
                ) : (
                  <select
                    className="input type-select"
                    aria-label="Type"
                    value={p.type}
                    onChange={(e) => onEdit(p.id, { type: e.target.value as RaidType, probability: e.target.value === 'Risk' ? p.probability || 'Medium' : '' })}
                  >
                    {TYPES.map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                )}
                <span className="engine">{p.engine === 'ai' ? 'Claude' : 'Rules'}</span>
                <div className="decide" role="group" aria-label="Decision">
                  <button className="btn small accept" aria-pressed={d === 'accepted'} onClick={() => onDecide(p.id, d === 'accepted' ? undefined : 'accepted')}>
                    {d === 'accepted' ? '✓ Accepted' : 'Accept'}
                  </button>
                  <button className="btn small reject" aria-pressed={d === 'rejected'} onClick={() => onDecide(p.id, d === 'rejected' ? undefined : 'rejected')}>
                    {d === 'rejected' ? 'Rejected' : 'Reject'}
                  </button>
                </div>
              </div>

              <div className="p-body">
                <label className="field grow">
                  <span>Title</span>
                  <input className="input" value={p.title} onChange={(e) => onEdit(p.id, { title: e.target.value })} />
                </label>
                <label className="field small">
                  <span>Owner</span>
                  <input className="input" value={p.owner} onChange={(e) => onEdit(p.id, { owner: e.target.value })} placeholder="Unassigned" />
                </label>
                {p.type === 'Risk' && <LevelSelect label="Probability" value={p.probability} onChange={(v) => onEdit(p.id, { probability: v })} />}
                <LevelSelect label="Impact" value={p.impact} onChange={(v) => onEdit(p.id, { impact: v })} />
              </div>

              {p.action !== 'new' && target && (p.owner !== target.owner || p.impact !== target.impact || p.probability !== target.probability) && (
                <p className="diff">
                  Changes:{' '}
                  {[
                    p.owner !== target.owner && `owner ${target.owner || '–'} → ${p.owner || '–'}`,
                    p.probability !== target.probability && `probability ${target.probability || '–'} → ${p.probability || '–'}`,
                    p.impact !== target.impact && `impact ${target.impact || '–'} → ${p.impact || '–'}`,
                  ]
                    .filter(Boolean)
                    .join(', ')}
                </p>
              )}

              <ul className="quotes">
                {p.quotes.map((q, i) => (
                  <li key={i}>
                    <span className="src">{q.sourceName}</span>
                    <q>{q.text}</q>
                  </li>
                ))}
              </ul>

              {p.match && (
                <p className="match">
                  Linked to {p.targetId} because both mention: {originalWords(p.match.shared, target?.title ?? '', target?.description ?? '', target?.owner ?? '').join(', ')}.{' '}
                  <button
                    className="link"
                    onClick={() => onEdit(p.id, { action: 'new', targetId: undefined, match: undefined, title: p.quotes[0].text.replace(/[.\s]+$/, ''), owner: '' })}
                  >
                    Not the same item? Make it new
                  </button>
                </p>
              )}
              {p.flags.length > 0 && (
                <ul className="flags">
                  {p.flags.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              )}
            </li>
          )
        })}
      </ol>

      {proposals.length > 0 && (
        <div className="apply-bar">
          <span>
            {accepted} accepted · {undecided} still to review
          </span>
          <button className="btn primary" disabled={!accepted} onClick={onApply}>
            Apply {accepted} change{accepted === 1 ? '' : 's'} to the log
          </button>
        </div>
      )}
    </section>
  )
}
