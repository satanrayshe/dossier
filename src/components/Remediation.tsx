import { useMemo, useState } from 'react'
import type { Dossier } from '../lib/types'
import {
  SCRUBBABLE,
  SUGGESTED_DM_RELAYS,
  leakyNotes,
  planDeleteDms,
  planDeleteLeaky,
  planDmInbox,
  planScrubProfile,
  rebroadcastDeletions,
  signAndPublish,
  targetRelays,
  type PublishReport,
  type UnsignedEvent,
} from '../lib/remediate'
import { fmtDate, host } from './common'

function summarize(reports: PublishReport[]): string {
  if (!reports.length) return 'Nothing to publish.'
  const lines = reports.map((r) => {
    const ok = r.results.filter((x) => x.ok).length
    const bad = r.results.filter((x) => !x.ok)
    return `${r.eventId.slice(0, 10)}…  accepted by ${ok}/${r.results.length}${bad.length ? `  · rejected: ${bad.slice(0, 3).map((b) => `${host(b.relay)} (${b.message || 'no reason'})`).join(', ')}` : ''}`
  })
  return lines.join('\n')
}

function useRunner() {
  const [busy, setBusy] = useState(false)
  const [out, setOut] = useState('')
  const run = async (fn: (progress: (m: string) => void) => Promise<PublishReport[]>) => {
    setBusy(true)
    setOut('')
    try {
      const r = await fn(setOut)
      setOut(summarize(r))
    } catch (e) {
      setOut(`× ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }
  return { busy, out, run }
}

export function Remediation({ d, isSubject, onConnect }: { d: Dossier; isSubject: boolean; onConnect: () => void }) {
  const dms = useRunner()
  const inbox = useRunner()
  const rebroadcast = useRunner()
  const leaky = useRunner()
  const scrub = useRunner()
  const notes = useMemo(() => leakyNotes(d), [d])
  const [picked, setPicked] = useState<string[]>([])
  const [scrubFields, setScrubFields] = useState<string[]>([])
  const offenders = Object.keys(d.stillServed)
  const relays = targetRelays(d)
  const presentFields = SCRUBBABLE.filter((k) => d.profile?.[k])

  const signed = (plan: UnsignedEvent[]) => (p: (m: string) => void) => signAndPublish(d, plan, p)
  const gate = !isSubject
  const Gate = () =>
    gate ? (
      <button className="btn ghost" onClick={onConnect}>
        Sign in as subject
      </button>
    ) : null

  return (
    <section className="chapter" id="burn" aria-labelledby="burn-h">
      <div className="exhibit">Countermeasures</div>
      <h2 id="burn-h">Shrink the file</h2>
      <p className="intro">
        Fixes are signed by your NIP-07 extension (Alby, nos2x, Keys.band). This page never sees your key. Signed events go to {relays.length} relays: your own write relays plus
        every relay that answered this investigation. Deletion is a request. Honest relays comply, but anything already archived elsewhere stays archived.
      </p>
      <div className="actions">
        <div className="action">
          <h4>Request deletion of {d.dmsSent.length} legacy DMs you sent</h4>
          <p>Publishes NIP-09 deletion requests (kind 5, k=4) for every kind-4 message you authored. Received DMs can only be deleted by their senders.</p>
          <div className="row">
            <Gate />
            <button className="btn danger" disabled={gate || dms.busy || !d.dmsSent.length} onClick={() => dms.run(signed(planDeleteDms(d)))}>
              {dms.busy ? 'Working…' : `Sign & publish ${Math.ceil(d.dmsSent.length / 200) || 0} request(s)`}
            </button>
          </div>
          {dms.out && <div className="result">{dms.out}</div>}
        </div>

        <div className="action">
          <h4>{d.dmRelays.length ? 'Re-announce your NIP-17 DM inbox' : 'Publish a NIP-17 DM inbox'}</h4>
          <p>
            A kind-10050 list tells other clients to send you gift-wrapped DMs, which hide sender and time.{' '}
            {d.dmRelays.length ? `Current: ${d.dmRelays.map(host).join(', ')}.` : `Suggested inbox relays (all require AUTH to read): ${SUGGESTED_DM_RELAYS.map(host).join(', ')}.`}
          </p>
          <div className="row">
            <Gate />
            <button className="btn" disabled={gate || inbox.busy} onClick={() => inbox.run(signed(planDmInbox(d)))}>
              {inbox.busy ? 'Working…' : 'Sign & publish kind 10050'}
            </button>
          </div>
          {inbox.out && <div className="result">{inbox.out}</div>}
        </div>

        <div className="action">
          <h4>Rebroadcast deletions to {offenders.length} non-compliant relays</h4>
          <p>Sends your existing, already-signed deletion requests to the relays still serving deleted events. No signature or login needed, so anyone can nudge relays on your behalf.</p>
          <div className="row">
            <button className="btn" disabled={rebroadcast.busy || !offenders.length} onClick={() => rebroadcast.run((p) => rebroadcastDeletions(d, p))}>
              {rebroadcast.busy ? 'Working…' : 'Rebroadcast'}
            </button>
          </div>
          {rebroadcast.out && <div className="result">{rebroadcast.out}</div>}
        </div>

        <div className="action">
          <h4>Delete notes that leak location or money ({notes.length})</h4>
          <p>Notes with posted bitcoin addresses, geotags, GPS-tagged photos or phone numbers.</p>
          {notes.length === 0 && <p className="empty">None found in the notes that were checked.</p>}
          {notes.length > 0 && (
            <div className="checklist">
              {notes.map((n) => (
                <label key={n.id}>
                  <input type="checkbox" checked={picked.includes(n.id)} onChange={(e) => setPicked((xs) => (e.target.checked ? [...xs, n.id] : xs.filter((x) => x !== n.id)))} />
                  <span>
                    <b>{n.reason}</b> <span className="muted">{fmtDate(d.activity.find((a) => a.id === n.id)?.created_at)}</span> · {n.preview || <i>no text</i>}
                  </span>
                </label>
              ))}
            </div>
          )}
          <div className="row" hidden={!notes.length}>
            <Gate />
            <button className="btn danger" disabled={gate || leaky.busy || !picked.length} onClick={() => leaky.run(signed(planDeleteLeaky(d, picked)))}>
              {leaky.busy ? 'Working…' : `Delete ${picked.length} selected`}
            </button>
          </div>
          {leaky.out && <div className="result">{leaky.out}</div>}
        </div>

        <div className="action">
          <h4>Scrub profile fields</h4>
          <p>Republishes your kind-0 profile without the fields you pick. Older versions may survive on some relays (see Exhibit A).</p>
          {presentFields.length ? (
            <div className="checklist">
              {presentFields.map((k) => (
                <label key={k}>
                  <input type="checkbox" checked={scrubFields.includes(k)} onChange={(e) => setScrubFields((xs) => (e.target.checked ? [...xs, k] : xs.filter((x) => x !== k)))} />
                  <span>
                    <b className="mono">{k}</b> <span className="muted">{String(d.profile?.[k]).slice(0, 60)}</span>
                  </span>
                </label>
              ))}
            </div>
          ) : (
            <p className="empty">No identifying fields set.</p>
          )}
          <div className="row">
            <Gate />
            <button className="btn danger" disabled={gate || scrub.busy || !scrubFields.length} onClick={() => scrub.run(signed(planScrubProfile(d, scrubFields)))}>
              {scrub.busy ? 'Working…' : `Remove ${scrubFields.length} field(s)`}
            </button>
          </div>
          {scrub.out && <div className="result">{scrub.out}</div>}
        </div>
      </div>
    </section>
  )
}
