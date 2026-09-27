import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { collect, DEFAULT_SETTINGS } from './lib/collect'
import { SEVERITY_ORDER, dmContacts, exposureScore, findings as analyze, formatOffset, innerCircle, timeProfile, zapSummary } from './lib/analyze'
import { nodeOperatorGuess } from './lib/lightning'
import { signerPubkey, hasSigner } from './lib/remediate'
import type { Chapter as ChapterId, Dossier, Finding, Settings } from './lib/types'
import { IdentityCtx, Sev, host, shortNpub, type Identity } from './components/common'
import { Chapter, IdentityPanels, MediaPanels, MessagePanels, MoneyPanels, RelayPanels, SocialPanels, TimePanels } from './components/Chapters'
import { Remediation } from './components/Remediation'

const EXAMPLES = [
  { label: 'fiatjaf', value: 'npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6' },
  { label: 'jack', value: 'npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m' },
  { label: 'odell', value: 'npub1qny3tkh0acurzla8x3zy4nhrjz5zd8l9sy9jys09umwng00manysew95gx' },
]

const CHAPTERS: { id: ChapterId; letter: string; title: string; intro: string }[] = [
  { id: 'identity', letter: 'A', title: 'Identity & anchors', intro: 'Anything that ties the key to a domain, an account elsewhere, or a real name. Analysts call these anchor points.' },
  { id: 'time', letter: 'B', title: 'Pattern of life', intro: 'Every Nostr event carries a to-the-second timestamp. Enough of them reveal where you live and when you sleep.' },
  { id: 'messages', letter: 'C', title: 'Private messages', intro: 'Legacy NIP-04 DMs encrypt the words but leave the envelope public: who, to whom, and when.' },
  { id: 'money', letter: 'D', title: 'Money trail', intro: 'Zap receipts, lightning addresses and invoices lead from a pseudonym to custodians, nodes, IP addresses and on-chain coins.' },
  { id: 'social', letter: 'E', title: 'Social graph', intro: 'Combining private and public channels ranks the people who matter most to the subject.' },
  { id: 'media', letter: 'F', title: 'Media metadata', intro: 'Photos keep their EXIF data unless the client strips it before upload.' },
  { id: 'relays', letter: 'G', title: 'Relays & deletion', intro: 'Which relays answered, which ones leak DM metadata, and which ones ignore deletion requests.' },
]

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem('dossier.settings')
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
  } catch {
    /* storage unavailable */
  }
  return DEFAULT_SETTINGS
}

function useTheme(): [string, () => void] {
  const [theme, setTheme] = useState<string>(() => {
    try {
      return localStorage.getItem('dossier.theme') ?? 'auto'
    } catch {
      return 'auto'
    }
  })
  useEffect(() => {
    if (theme === 'auto') document.documentElement.removeAttribute('data-theme')
    else document.documentElement.setAttribute('data-theme', theme)
    try {
      localStorage.setItem('dossier.theme', theme)
    } catch {
      /* ignore */
    }
  }, [theme])
  const cycle = () => setTheme((t) => (t === 'auto' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'light' : 'dark') : t === 'dark' ? 'light' : 'dark'))
  return [theme, cycle]
}

export default function App() {
  const [input, setInput] = useState('')
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [dossier, setDossier] = useState<Dossier>()
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [viewer, setViewer] = useState<string>()
  const [signerNote, setSignerNote] = useState('')
  const [, cycleTheme] = useTheme()
  const abortRef = useRef<AbortController | null>(null)

  const run = useCallback(
    async (value: string) => {
      const v = value.trim()
      if (!v) return
      abortRef.current?.abort()
      const ctl = new AbortController()
      abortRef.current = ctl
      setError('')
      setDossier(undefined)
      setRunning(true)
      try {
        history.replaceState(null, '', `#${encodeURIComponent(v)}`)
      } catch {
        /* ignore */
      }
      try {
        const d = await collect(v, settings, (x) => !ctl.signal.aborted && setDossier(x), ctl.signal)
        if (!ctl.signal.aborted) setDossier(d)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!ctl.signal.aborted) setRunning(false)
      }
    },
    [settings],
  )

  useEffect(() => {
    const h = decodeURIComponent(location.hash.slice(1))
    if (h) {
      setInput(h)
      run(h)
    }
    // run once on load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem('dossier.settings', JSON.stringify(settings))
    } catch {
      /* ignore */
    }
  }, [settings])

  const connect = async () => {
    if (!hasSigner()) {
      setSignerNote('No NIP-07 signer found in this browser. Install Alby, nos2x or Keys.band, then try again.')
      return
    }
    const pk = await signerPubkey()
    setViewer(pk)
    if (dossier && pk !== dossier.pubkey) setSignerNote(`Your signer is ${pk ? shortNpub(pk) : 'unavailable'}, not the subject of this file. Third parties stay pseudonymised.`)
    else setSignerNote('')
  }

  const isSubject = !!dossier && viewer === dossier.pubkey
  const fs = useMemo(() => (dossier ? analyze(dossier) : []), [dossier])
  const identity = useMemo<Identity>(() => {
    const order: string[] = []
    if (dossier) {
      const push = (pk?: string) => pk && pk !== dossier.pubkey && !order.includes(pk) && order.push(pk)
      innerCircle(dossier, 500).forEach((t) => push(t.pubkey))
      dmContacts(dossier).forEach((c) => push(c.pubkey))
      zapSummary(dossier).senders.forEach((s) => push(s.pubkey))
      zapSummary(dossier).recipients.forEach((s) => push(s.pubkey))
      dossier.nip05?.coResidents?.forEach((c) => push(c.pubkey))
    }
    const idx = new Map(order.map((pk, i) => [pk, i + 1]))
    return { unlocked: isSubject, names: dossier?.names ?? {}, aliasOf: (pk) => idx.get(pk) ?? 0 }
  }, [dossier, isSubject])

  return (
    <IdentityCtx.Provider value={identity}>
      <header className="topbar">
        <div className="wrap">
          <a className="wordmark" href="./" onClick={() => history.replaceState(null, '', location.pathname)}>
            <span className="seal">D</span>DOSSIER
          </a>
          <nav className="topnav" aria-label="Site">
            <a href="#method" className="hide-sm">
              How it works
            </a>
            <a href="https://github.com/satanrayshe/dossier" target="_blank" rel="noreferrer noopener">
              Source
            </a>
            <button className="icon-btn" onClick={cycleTheme} aria-label="Toggle colour theme" title="Toggle theme">
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
                <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
                <path d="M8 1.8a6.2 6.2 0 0 1 0 12.4z" fill="currentColor" />
              </svg>
            </button>
          </nav>
        </div>
      </header>

      <main className="wrap">
        <section className={`intake ${dossier || running ? 'compact' : ''}`}>
          {!dossier && !running && (
            <>
              <div className="label">Nostr exposure report · runs entirely in your browser</div>
              <h1>
                See your npub the way <em>an analyst</em> does.
              </h1>
              <p className="lede">
                Paste a Nostr public key. Dossier reads public relays, the subject&rsquo;s lightning address and the block chain directly from this tab. It then writes the file a surveillance
                analyst could build from that data: where you probably live, who you message, who pays you, and which relays kept what you deleted. Then it helps you shrink it.
              </p>
            </>
          )}
          <form
            className="search"
            onSubmit={(e) => {
              e.preventDefault()
              run(input)
            }}
          >
            <label htmlFor="subject" className="sr-only">
              npub, nprofile, hex key or NIP-05 address
            </label>
            <input id="subject" value={input} onChange={(e) => setInput(e.target.value)} placeholder="npub1…  ·  name@domain.com  ·  hex pubkey" spellCheck={false} autoComplete="off" />
            <button type="submit" disabled={running || !input.trim()}>
              {running ? 'Investigating…' : 'Open file →'}
            </button>
          </form>
          {!dossier && !running && (
            <>
              <div className="examples">
                <span className="muted">Try a public figure:</span>
                {EXAMPLES.map((ex) => (
                  <button
                    key={ex.label}
                    className="chip"
                    onClick={() => {
                      setInput(ex.value)
                      run(ex.value)
                    }}
                  >
                    {ex.label}
                  </button>
                ))}
              </div>
              <p className="opsec">
                <span aria-hidden>⚠</span>
                <span>
                  <strong>Your own OPSEC:</strong> opening a file connects from your IP to ~20 relays, the subject&rsquo;s LNURL server, image hosts and {host(settings.mempool)}. Use Tor
                  Browser or point the sources below at your own infrastructure for anything sensitive. There is no Dossier server; nothing is logged.
                </span>
              </p>
              <SettingsPanel settings={settings} onChange={setSettings} />
            </>
          )}
          {error && (
            <p className="opsec" style={{ color: 'var(--red)' }}>
              × {error}
            </p>
          )}
        </section>

        {dossier && <WireLog d={dossier} running={running} />}
        {dossier && <File d={dossier} fs={fs} running={running} isSubject={isSubject} onConnect={connect} signerNote={signerNote} />}
        {!dossier && !running && <Method />}
      </main>

      <footer className="foot">
        <div className="wrap">
          <span>Dossier · open source · no backend, no analytics, no cookies.</span>
          <span>
            Built for BOSS Battle 2026 ·{' '}
            <a href="https://github.com/satanrayshe/dossier" target="_blank" rel="noreferrer noopener">
              github.com/satanrayshe/dossier
            </a>
          </span>
        </div>
      </footer>
    </IdentityCtx.Provider>
  )
}

function SettingsPanel({ settings, onChange }: { settings: Settings; onChange: (s: Settings) => void }) {
  const [relaysText, setRelaysText] = useState(settings.relays.join('\n'))
  const toggle = (k: keyof Settings, label: string, hint: string) => (
    <label className="toggle">
      <input type="checkbox" checked={settings[k] as boolean} onChange={(e) => onChange({ ...settings, [k]: e.target.checked })} />
      <span>
        {label}
        <small>{hint}</small>
      </span>
    </label>
  )
  return (
    <details className="settings">
      <summary>Sources & OPSEC settings ▸</summary>
      <div className="body">
        <label>
          <div className="label" style={{ marginBottom: 6 }}>
            Relays queried (the subject&rsquo;s own NIP-65 relays are added automatically)
          </div>
          <textarea
            value={relaysText}
            onChange={(e) => setRelaysText(e.target.value)}
            onBlur={() => onChange({ ...settings, relays: relaysText.split(/\s+/).filter((r) => /^wss?:\/\//.test(r)) })}
          />
        </label>
        <label>
          <div className="label" style={{ marginBottom: 6 }}>
            Block explorer (mempool.space-compatible API, e.g. your Umbrel)
          </div>
          <input type="text" value={settings.mempool} onChange={(e) => onChange({ ...settings, mempool: e.target.value.replace(/\/+$/, '') })} />
        </label>
        {toggle('probeInvoice', 'Request an invoice from the subject’s LNURL server', 'Reveals the payee node and route hints. The server sees an unpaid invoice request from your IP.')}
        {toggle('lookupChain', 'Look up nodes, channels and addresses on the block explorer', 'Needed for node location, funding transactions and address balances.')}
        {toggle('scanImages', 'Read EXIF headers of recent images', 'Downloads the first 192 KB of up to 24 images from their hosts.')}
        {toggle('nip05Lookup', 'Inspect the NIP-05 domain', 'Checks whether the domain publishes its whole directory of keys.')}
        <button className="btn ghost" style={{ justifySelf: 'start' }} onClick={() => (onChange(DEFAULT_SETTINGS), setRelaysText(DEFAULT_SETTINGS.relays.join('\n')))}>
          Reset to defaults
        </button>
      </div>
    </details>
  )
}

function WireLog({ d, running }: { d: Dossier; running: boolean }) {
  const ref = useRef<HTMLOListElement>(null)
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight })
  }, [d.log.length])
  return (
    <section className="wire" aria-live="polite">
      <header>
        <span className="label">
          {running && <span className="pulse" />}
          Wire log · {d.stage}
        </span>
        <span className="label">{((((d.finishedAt ?? Date.now()) - d.startedAt) / 1000) | 0).toString()}s</span>
      </header>
      <ol ref={ref}>
        {d.log.map((l, i) => (
          <li key={i} className={l.tone}>
            <time>+{((l.at - d.startedAt) / 1000).toFixed(1)}s</time>
            <span>{l.text}</span>
          </li>
        ))}
      </ol>
    </section>
  )
}

function File({ d, fs, running, isSubject, onConnect, signerNote }: { d: Dossier; fs: Finding[]; running: boolean; isSubject: boolean; onConnect: () => void; signerNote: string }) {
  const score = exposureScore(fs)
  const tp = timeProfile([...d.activity, ...d.dmsSent])
  const z = zapSummary(d)
  const contacts = dmContacts(d)
  const byChapter = (c: ChapterId) => fs.filter((f) => f.chapter === c).sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity))
  const top = [...fs].filter((f) => f.severity !== 'good' && f.severity !== 'info').sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)).slice(0, 7)
  const goods = fs.filter((f) => f.severity === 'good').length
  const name = (d.profile?.display_name as string) || d.profile?.name || shortNpub(d.pubkey)
  const L = d.lightning
  const stale = Object.keys(d.stillServed).length
  const stampClass = score.grade <= 'B' ? 'good' : score.grade === 'C' ? 'mid' : ''
  const anchors = [d.profile?.nip05 && 'NIP-05', d.profile?.website && 'website', d.profile?.lud16 && 'LN address', (d.profileEvent?.tags ?? []).some((t) => t[0] === 'i') && 'NIP-39'].filter(Boolean)
  const counts = (c: ChapterId) => fs.filter((f) => f.chapter === c && f.severity !== 'good' && f.severity !== 'info').length

  return (
    <article className="file">
      <div className="file-head">
        <span>
          FILE NO. <b>{d.pubkey.slice(0, 8).toUpperCase()}</b>
        </span>
        <span>
          OPENED <b>{new Date(d.startedAt).toISOString().replace('T', ' ').slice(0, 16)} UTC</b>
        </span>
        <span>
          SOURCES <b>{d.coverage.filter((c) => c.reachable).length} relays{L.lnurl ? ' · 1 LNURL server' : ''} · block explorer</b>
        </span>
        <span>
          CLASSIFICATION <b style={{ color: 'var(--red)' }}>PUBLIC</b> (that&rsquo;s the problem)
        </span>
      </div>

      <div className="cover">
        <div className="subject">
          <div>
            <div className="label">Subject</div>
            <div className="name">{name}</div>
            <div className="npub">{d.npub}</div>
          </div>
          <div className={`stamp ${stampClass}`} aria-label={`Exposure grade ${score.grade}, score ${score.score} of 100`}>
            <div className="g">{running ? '…' : score.grade}</div>
            <div className="s">exposure {score.score}/100</div>
          </div>
          <div className="verdict">{running ? 'Investigation in progress…' : score.verdict}</div>
          {goods > 0 && (
            <div className="muted" style={{ fontSize: 13 }}>
              {goods} finding{goods === 1 ? '' : 's'} in the subject&rsquo;s favour.
            </div>
          )}
        </div>
        <div className="assessment">
          <div className="label">Analyst&rsquo;s assessment</div>
          <div className="facts">
            <Fact k="likely timezone" v={tp ? formatOffset(tp.offset) : '—'} sub={tp ? `${tp.regions[0] ?? ''} · ${tp.confidence} confidence` : 'not enough data'} />
            <Fact k="sleeps (local)" v={tp ? `${String(tp.quietStart).padStart(2, '0')}–${String(tp.quietEnd).padStart(2, '0')}h` : '—'} sub={tp ? `${tp.sample.toLocaleString()} timestamps` : ''} />
            <Fact k="DM contacts exposed" v={String(contacts.length)} sub={`${d.dmsSent.length + d.dmsRecv.length} NIP-04 messages`} />
            <Fact k="zap volume" v={`${(z.inSats + z.outSats).toLocaleString()}`} sub={`sats · ${z.inCount + z.outCount} receipts`} />
            <Fact k="receives via" v={L.provider?.name ?? '—'} sub={L.provider ? (L.provider.custodial === true ? 'custodial' : L.provider.custodial === false ? 'self-custodial' : 'custody unknown') : 'no lightning address'} />
            <Fact
              k="payee node"
              v={L.payeeNode?.alias ?? (L.invoice ? 'private node' : '—')}
              sub={L.payeeNode?.announced ? nodeOperatorGuess(L.payeeNode.alias) ?? ([L.payeeNode.city, L.payeeNode.country].filter(Boolean).join(', ') || 'public') : L.invoice ? `${L.invoice.payee.slice(0, 10)}…` : ''}
            />
            <Fact k="deleted, still served" v={d.deletionTargets.length ? String(new Set(Object.values(d.stillServed).flat()).size) : '—'} sub={d.deletionTargets.length ? `on ${stale} relay${stale === 1 ? '' : 's'}` : 'no deletions'} />
            <Fact k="anchor points" v={String(anchors.length)} sub={anchors.join(' · ') || 'none'} />
          </div>
          <ul className="findings">
            {top.map((f) => (
              <li key={f.id} className="finding">
                <Sev s={f.severity} />
                <div>
                  <div className="t">{f.title}</div>
                </div>
              </li>
            ))}
            {!top.length && !running && <li className="empty">No significant exposure found.</li>}
          </ul>
        </div>
      </div>

      {!isSubject && (
        <div className="unlock">
          <span>
            <b>Third parties are pseudonymised.</b> Contacts appear as &ldquo;Contact 01&rdquo;, &ldquo;Contact 02&rdquo;… unless you prove you are the subject with your NIP-07 signer. {signerNote}
          </span>
          <button className="btn" onClick={onConnect}>
            I&rsquo;m the subject: sign in
          </button>
        </div>
      )}

      <div className="book">
        <nav className="toc" aria-label="Exhibits">
          <div className="label">Contents</div>
          <ol>
            {CHAPTERS.map((c) => (
              <li key={c.id}>
                <a href={`#${c.id}`} onClick={(e) => (e.preventDefault(), document.getElementById(c.id)?.scrollIntoView({ behavior: 'smooth' }))}>
                  <span>
                    <span className="n">{c.letter}</span> {c.title}
                  </span>
                  <span>{counts(c.id) || ''}</span>
                </a>
              </li>
            ))}
            <li>
              <a href="#burn" onClick={(e) => (e.preventDefault(), document.getElementById('burn')?.scrollIntoView({ behavior: 'smooth' }))}>
                <span>
                  <span className="n">→</span> Shrink the file
                </span>
              </a>
            </li>
          </ol>
        </nav>
        <div style={{ minWidth: 0 }}>
          {CHAPTERS.map((c) => (
            <Chapter key={c.id} {...c} findings={byChapter(c.id)}>
              {c.id === 'identity' && <IdentityPanels d={d} />}
              {c.id === 'time' && <TimePanels d={d} />}
              {c.id === 'messages' && <MessagePanels d={d} offset={tp?.offset ?? 0} />}
              {c.id === 'money' && <MoneyPanels d={d} />}
              {c.id === 'social' && <SocialPanels d={d} />}
              {c.id === 'media' && <MediaPanels d={d} />}
              {c.id === 'relays' && <RelayPanels d={d} />}
            </Chapter>
          ))}
          <Remediation d={d} isSubject={isSubject} onConnect={onConnect} />
        </div>
      </div>
    </article>
  )
}

function Fact({ k, v, sub }: { k: string; v: string; sub?: string }) {
  return (
    <div className="fact">
      <div className="label">{k}</div>
      <div className="v">{v}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  )
}

function Method() {
  return (
    <section id="method" className="method" aria-label="How it works">
      <div>
        <h3>01 · Collect</h3>
        <p>Unauthenticated reads from ~20 public relays plus the subject&rsquo;s own NIP-65 relays: profile history, notes, legacy DMs, zap receipts, deletions. Exactly what any stranger can pull.</p>
      </div>
      <div>
        <h3>02 · Follow the money</h3>
        <p>The lightning address is resolved like a wallet would. The invoice signature gives up the payee node; route-hint channel IDs are decoded and checked against the chain for real funding outputs.</p>
      </div>
      <div>
        <h3>03 · Infer</h3>
        <p>A human daily rhythm is fitted to thousands of timestamps to estimate timezone and sleep. DM envelopes, zaps and replies are merged into a ranked link chart. Image headers are checked for GPS.</p>
      </div>
      <div>
        <h3>04 · Shrink it</h3>
        <p>One-click countermeasures signed by your NIP-07 extension: NIP-09 deletions for old DMs and leaky notes, a NIP-17 inbox, profile scrubbing, and rebroadcasting deletions to relays that ignored them.</p>
      </div>
    </section>
  )
}
