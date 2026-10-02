// Renders the small Markdown subset the summary uses (##/### headings, "- "
// bullets, **bold** and _italic_) as React elements, so no HTML string is ever
// injected into the page.

import { Fragment, type ReactNode } from 'react'

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /\*\*(.+?)\*\*|(?<![\w])_(.+?)_(?![\w])/g
  let last = 0
  let n = 0
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push(text.slice(last, m.index))
    out.push(m[1] != null ? <strong key={n++}>{m[1]}</strong> : <em key={n++}>{m[2]}</em>)
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export function Markdown({ source }: { source: string }) {
  const blocks: ReactNode[] = []
  let list: string[] = []
  const flush = () => {
    if (list.length) {
      const items = list
      blocks.push(
        <ul key={blocks.length}>
          {items.map((li, i) => (
            <li key={i}>{inline(li)}</li>
          ))}
        </ul>,
      )
      list = []
    }
  }
  for (const line of source.split('\n')) {
    if (line.startsWith('- ')) {
      list.push(line.slice(2))
      continue
    }
    flush()
    if (line.startsWith('### ')) blocks.push(<h4 key={blocks.length}>{inline(line.slice(4))}</h4>)
    else if (line.startsWith('## ')) blocks.push(<h3 key={blocks.length}>{inline(line.slice(3))}</h3>)
    else if (line.trim()) blocks.push(<p key={blocks.length}>{inline(line)}</p>)
  }
  flush()
  return <Fragment>{blocks}</Fragment>
}
