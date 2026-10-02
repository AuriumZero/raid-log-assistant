import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import App from './App'
import { sampleBytes } from './test/samples'

function fakeFetch(answer?: (content: string) => unknown) {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    if (u.includes('/samples/')) return new Response(sampleBytes(u.split('/').pop()!))
    if (u.startsWith('https://api.anthropic.com') && answer) {
      const body = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({ content: [{ type: 'tool_use', name: 'record_raid_changes', input: answer(body.messages[0].content) }] }))
    }
    return new Response('nope', { status: 404 })
  })
}

async function loadSamples(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Use the sample log' }))
  await screen.findByText(/6 with no update/)
  await user.click(screen.getByRole('button', { name: /Add sample notes/ }))
  await screen.findByText('data-platform-sprint-23.csv')
}

describe('App', () => {
  it('loads the sample log and flags stale items', async () => {
    const user = userEvent.setup()
    render(<App fetchImpl={fakeFetch() as unknown as typeof fetch} />)
    await user.click(screen.getByRole('button', { name: 'Use the sample log' }))
    expect(await screen.findByText(/6 with no update in 14\+ days/)).toBeInTheDocument()
    expect(screen.getByLabelText('As of')).toHaveValue('2026-10-01')
    expect(screen.getByText('No update in 42 days')).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: /Dependencies/ }))
    expect(screen.getAllByRole('row')).toHaveLength(2)
  })

  it('finds changes with rules, lets the reviewer edit and accept them, and applies only those', async () => {
    const user = userEvent.setup()
    render(<App fetchImpl={fakeFetch() as unknown as typeof fetch} />)
    await loadSamples(user)
    await user.click(screen.getByRole('button', { name: 'Find changes' }))

    const list = await screen.findAllByRole('listitem', { name: /^(New|Update|Close) / })
    expect(list).toHaveLength(11)
    const close = screen.getByRole('listitem', { name: /^Close I-002/ })
    await user.click(within(close).getByRole('button', { name: 'Accept' }))
    const risk = screen.getByRole('listitem', { name: /^New Risk: The service-visit/ })
    const title = within(risk).getByLabelText('Title')
    await user.clear(title)
    await user.type(title, 'Service-visit migration may miss the cutover freeze')
    await user.click(within(risk).getByRole('button', { name: 'Accept' }))
    await user.click(within(screen.getByRole('listitem', { name: /^Update R-003/ })).getByRole('button', { name: 'Reject' }))

    expect(screen.getByText(/2 accepted · 8 still to review/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Apply 2 changes to the log' }))

    expect(screen.queryByRole('heading', { name: /Review proposed/ })).not.toBeInTheDocument()
    expect(screen.getByText('Service-visit migration may miss the cutover freeze')).toBeInTheDocument()
    const digest = screen.getByRole('article', { name: 'Digest' })
    expect(digest).toHaveTextContent('Closed I-002')
    expect(digest).toHaveTextContent('Added R-004 (Risk): Service-visit migration may miss the cutover freeze')
    // Closed items are hidden until asked for.
    expect(screen.queryByText('Oversized dev warehouse cluster is driving up cloud costs')).not.toBeInTheDocument()
    await user.click(screen.getByLabelText('Show closed'))
    expect(screen.getByText('Oversized dev warehouse cluster is driving up cloud costs')).toBeInTheDocument()
  })

  it('turns a linked update into a new item when the match is wrong', async () => {
    const user = userEvent.setup()
    render(<App fetchImpl={fakeFetch() as unknown as typeof fetch} />)
    await loadSamples(user)
    await user.click(screen.getByRole('button', { name: 'Find changes' }))
    const item = await screen.findByRole('listitem', { name: /^Update R-003/ })
    expect(within(item).getByText(/both mention: sam, cutover, week/)).toBeInTheDocument()
    await user.click(within(item).getByRole('button', { name: /Make it new/ }))
    expect(screen.getByRole('listitem', { name: /^New Risk: Sam will be out/ })).toBeInTheDocument()
  })

  it('adds pasted notes as a source', async () => {
    const user = userEvent.setup()
    render(<App fetchImpl={fakeFetch() as unknown as typeof fetch} />)
    await user.click(screen.getByRole('button', { name: 'Start an empty log' }))
    await user.type(screen.getByLabelText(/Paste meeting notes/), 'We are waiting on Legal to approve the data sharing agreement. Owner: Ana Diaz')
    await user.click(screen.getByRole('button', { name: 'Add notes' }))
    await user.click(screen.getByRole('button', { name: 'Find changes' }))
    const p = await screen.findByRole('listitem', { name: /^New Dependency/ })
    expect(within(p).getByLabelText('Owner')).toHaveValue('Ana Diaz')
    await user.click(within(p).getByRole('button', { name: 'Accept' }))
    await user.click(screen.getByRole('button', { name: /Apply 1 change/ }))
    expect(screen.getByRole('button', { name: 'D-001' })).toBeInTheDocument()
  })

  it('reads notes with Claude, sends only masked notes, and shows its checks', async () => {
    const user = userEvent.setup()
    const fetchMock = fakeFetch((content) => {
      const person = content.match(/(PERSON_\d+) to confirm with Procurement/)![1]
      return {
        changes: [
          { action: 'update', existing_id: 'R-001', type: 'Risk', title: 'x', owner: person, quote: `${person} to confirm with Procurement whether the vendor feed contract renewal has been signed.`, source_id: 'S1' },
          { action: 'new', type: 'Issue', title: 'Budget overrun', quote: 'Budget is 20% over', source_id: 'S2' },
        ],
      }
    })
    render(<App fetchImpl={fetchMock as unknown as typeof fetch} />)
    await loadSamples(user)
    await user.click(screen.getByRole('button', { name: 'Claude' }))
    expect(screen.getByRole('button', { name: 'Find changes with Claude' })).toBeDisabled()
    await user.click(screen.getByText(/Preview exactly what will be sent: 2 sets of notes/))
    await user.type(screen.getByLabelText('Anthropic API key'), 'sk-ant-test')
    await user.click(screen.getByRole('button', { name: 'Find changes with Claude' }))

    const update = await screen.findByRole('listitem', { name: /^Update R-001/ })
    expect(within(update).getByLabelText('Owner')).toHaveValue('Jordan Lee')
    expect(within(update).getByText('Claude')).toBeInTheDocument()
    const invented = screen.getByRole('listitem', { name: /^New Issue: Budget overrun/ })
    expect(invented).toHaveTextContent(/aren't in the notes word for word/)
    // Jira-based proposals still come from rules.
    expect(screen.getByRole('listitem', { name: /^New Risk: Proof of concept/ })).toBeInTheDocument()

    const sent = String(fetchMock.mock.calls.find(([u]) => String(u).startsWith('https://api'))![1]!.body)
    expect(sent).not.toMatch(/Jordan|Priya|DPLAT-427/)
  })

  it('explains a log it cannot read', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.upload(screen.getByLabelText(/Open your RAID log/), new File(['A,B\n1,2\n'], 'odd.csv', { type: 'text/csv' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/Title, Summary or Description/)
  })
})
