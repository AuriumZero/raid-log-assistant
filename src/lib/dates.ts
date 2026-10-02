// Jira writes dates differently depending on the export and the user's locale.
// These are the formats seen in practice:
//   01/Oct/26 9:32 AM      Jira Cloud CSV (default date format)
//   2026-10-01 09:32       ISO-like, from some Data Center exports
//   2026-10-01T09:32       from an .xlsx cell formatted as a date
//   10/1/2026 9:32         after a round trip through Excel (US locale)
// Everything is returned as a UTC timestamp so comparisons don't depend on
// where the browser happens to be.

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

function hours(h: string, ampm: string | undefined): number {
  let n = Number(h)
  if (ampm) {
    const pm = ampm.toLowerCase() === 'pm'
    if (n === 12) n = pm ? 12 : 0
    else if (pm) n += 12
  }
  return n
}

const fullYear = (y: string) => (y.length === 2 ? 2000 + Number(y) : Number(y))

export function parseJiraDate(raw: string | undefined): number | null {
  const s = (raw ?? '').trim()
  if (!s) return null

  // 01/Oct/26 9:32 AM
  let m = s.match(/^(\d{1,2})[/ -]([A-Za-z]{3})[a-z]*[/ -](\d{2,4})(?:[ T]+(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?)?$/)
  if (m) {
    const month = MONTHS.indexOf(m[2].toLowerCase())
    if (month < 0) return null
    return Date.UTC(fullYear(m[3]), month, Number(m[1]), m[4] ? hours(m[4], m[6]) : 0, m[5] ? Number(m[5]) : 0)
  }

  // 2026-10-01, 2026-10-01 09:32, 2026-10-01T09:32:00(.000Z)
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/)
  if (m) return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), m[4] ? Number(m[4]) : 0, m[5] ? Number(m[5]) : 0)

  // 10/1/2026 9:32 PM (month first, as US Excel writes it)
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?)?$/)
  if (m) {
    // Month first unless that's impossible (14/09/2026 is day first).
    const [month, day] = Number(m[1]) > 12 ? [Number(m[2]), Number(m[1])] : [Number(m[1]), Number(m[2])]
    if (month > 12 || day > 31) return null
    return Date.UTC(fullYear(m[3]), month - 1, day, m[4] ? hours(m[4], m[6]) : 0, m[5] ? Number(m[5]) : 0)
  }

  return null
}

/** A timestamp as `Oct 1, 2026`. */
export function formatDay(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

/** `2026-10-01` for an <input type="date">, and back. */
export const toInputDate = (ms: number) => new Date(ms).toISOString().slice(0, 10)
export function fromInputDate(value: string): number | null {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null
}
