import { Fragment, useState } from 'react'
import { formatDay } from '../lib/dates'
import { daysSince, isClosed, isStale, score, TYPES, type RaidItem, type RaidType } from '../lib/raid'

interface Props {
  items: RaidItem[]
  asOf: number
  /** IDs changed by the last apply, highlighted in the table. */
  changed: Set<string>
}

const scoreClass = (s: number) => (s >= 6 ? 'hi' : s >= 3 ? 'mid' : s ? 'lo' : '')

export function LogTable({ items, asOf, changed }: Props) {
  const [filter, setFilter] = useState<RaidType | 'All'>('All')
  const [showClosed, setShowClosed] = useState(false)
  const [open, setOpen] = useState<string | null>(null)

  const shown = items
    .filter((i) => (filter === 'All' || i.type === filter) && (showClosed || !isClosed(i.status)))
    .sort((a, b) => Number(isClosed(a.status)) - Number(isClosed(b.status)) || score(b) - score(a) || a.id.localeCompare(b.id))
  const count = (t: RaidType | 'All') => items.filter((i) => (t === 'All' || i.type === t) && (showClosed || !isClosed(i.status))).length

  return (
    <div>
      <div className="card-head">
        <div className="tabs" role="tablist" aria-label="Filter by type">
          {(['All', ...TYPES] as const).map((t) => (
            <button key={t} role="tab" aria-selected={filter === t} onClick={() => setFilter(t)}>
              {t === 'All' ? 'All' : t === 'Dependency' ? 'Dependencies' : `${t}s`} <span className="count">{count(t)}</span>
            </button>
          ))}
        </div>
        <label className="check">
          <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
          Show closed
        </label>
      </div>
      <div className="table-wrap">
        <table className="log">
          <thead>
            <tr>
              <th>ID</th>
              <th>Item</th>
              <th>Owner</th>
              <th>Status</th>
              <th className="c">P</th>
              <th className="c">I</th>
              <th className="c">Score</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((i) => {
              const s = score(i)
              const stale = isStale(i, asOf)
              const days = daysSince(i.updated ?? i.raised, asOf)
              const expanded = open === i.id
              return (
                <Fragment key={i.id}>
                  <tr className={`${isClosed(i.status) ? 'closed' : ''}${changed.has(i.id) ? ' changed' : ''}`}>
                    <td className="mono nowrap">
                      <button className="link" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : i.id)}>
                        {i.id}
                      </button>
                    </td>
                    <td>
                      <span className={`type-dot ${i.type.toLowerCase()}`} aria-hidden="true" />
                      <span className="sr">{i.type}: </span>
                      {i.title}
                      {stale && <span className="tag warn">No update in {days} days</span>}
                      {changed.has(i.id) && <span className="tag new">Just changed</span>}
                    </td>
                    <td className="nowrap">{i.owner || <span className="muted">–</span>}</td>
                    <td className="nowrap">{i.status}</td>
                    <td className="c">{i.probability ? i.probability[0] : '–'}</td>
                    <td className="c">{i.impact ? i.impact[0] : '–'}</td>
                    <td className="c">
                      <span className={`score ${scoreClass(s)}`}>{s || '–'}</span>
                    </td>
                    <td className="nowrap muted">{days == null ? '–' : days === 0 ? 'Today' : `${days}d ago`}</td>
                  </tr>
                  {expanded && (
                    <tr className="detail">
                      <td />
                      <td colSpan={7}>
                        <dl>
                          {i.description && (
                            <>
                              <dt>Description</dt>
                              <dd>{i.description}</dd>
                            </>
                          )}
                          {i.mitigation && (
                            <>
                              <dt>Mitigation / action</dt>
                              <dd>{i.mitigation}</dd>
                            </>
                          )}
                          <dt>Dates</dt>
                          <dd>
                            Raised {i.raised ? formatDay(i.raised) : '–'} · updated {i.updated ? formatDay(i.updated) : '–'}
                            {i.due ? ` · due ${formatDay(i.due)}` : ''}
                          </dd>
                          {i.log.length > 0 && (
                            <>
                              <dt>History</dt>
                              <dd>
                                <ul className="history">
                                  {i.log.map((l, n) => (
                                    <li key={n}>{l}</li>
                                  ))}
                                </ul>
                              </dd>
                            </>
                          )}
                        </dl>
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
      {!shown.length && <p className="empty">No items to show.</p>}
    </div>
  )
}
