import type { ReactNode } from 'react'
import * as nip19 from 'nostr-tools/nip19'
import { clients, dmContacts, formatOffset, geotags, innerCircle, timeProfile, zapSummary, type TimeProfile } from '../lib/analyze'
import { nodeOperatorGuess } from '../lib/lightning'
import type { Dossier, Finding } from '../lib/types'
import { FindingList, Panel, Who, btc, fmtAgo, fmtDate, host, sats } from './common'
import { LinkChart } from './LinkChart'

export function Chapter({ id, letter, title, intro, findings, children }: { id: string; letter: string; title: string; intro: string; findings: Finding[]; children?: ReactNode }) {
  return (
    <section className="chapter" id={id} aria-labelledby={`${id}-h`}>
      <div className="exhibit">Exhibit {letter}</div>
      <h2 id={`${id}-h`}>{title}</h2>
      <p className="intro">{intro}</p>
      <FindingList items={findings} />
      {children}
    </section>
  )
}

// ---------- identity ----------

export function IdentityPanels({ d }: { d: Dossier }) {
  const p = d.profile ?? {}
  const rows: [string, ReactNode][] = []
  const push = (k: string, v: unknown) => v && rows.push([k, String(v)])
  push('name', p.name)
  push('display name', p.display_name)
  push('nip-05', p.nip05)
  push('lightning', p.lud16 ?? p.lud06)
  push('website', p.website)
  if (p.picture) rows.push(['avatar host', safeHost(String(p.picture))])
  if (p.banner) rows.push(['banner host', safeHost(String(p.banner))])
  return (
    <>
      <Panel title="Profile fields an analyst records">
        {rows.length ? (
          <div className="tbl-wrap">
            <table className="tbl">
              <tbody>
                {rows.map(([k, v]) => (
                  <tr key={k}>
                    <td className="label" style={{ width: 130 }}>
                      {k}
                    </td>
                    <td className="mono">{v}</td>
                  </tr>
                ))}
                <tr>
                  <td className="label">profile updated</td>
                  <td className="mono">{fmtDate(d.profileEvent?.created_at)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : (
          <p className="empty">No profile fields.</p>
        )}
      </Panel>
      {d.nip05?.coResidents?.length ? (
        <Panel title={`Other keys listed on ${d.nip05.domain}`}>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>name</th>
                  <th>key</th>
                </tr>
              </thead>
              <tbody>
                {d.nip05.coResidents.map((c) => (
                  <tr key={c.name + c.pubkey}>
                    <td className="mono">{c.name}@{d.nip05!.domain}</td>
                    <td>
                      <Who pk={c.pubkey} plain />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}
    </>
  )
}

function safeHost(u: string) {
  try {
    return new URL(u).hostname
  } catch {
    return u.slice(0, 40)
  }
}

// ---------- pattern of life ----------

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function Heatmap({ tp }: { tp: TimeProfile }) {
  const max = Math.max(1, ...tp.grid.flat())
  const level = (v: number) => (v === 0 ? 0 : Math.min(4, 1 + Math.floor((v / max) * 3.999)))
  const inQuiet = (h: number) => (tp.quietStart <= tp.quietEnd ? h >= tp.quietStart && h < tp.quietEnd : h >= tp.quietStart || h < tp.quietEnd)
  return (
    <div className="tbl-wrap">
      <div className="heat" role="img" aria-label={`Activity by weekday and local hour, ${formatOffset(tp.offset)}`}>
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={h} className="h" style={inQuiet(h) ? { color: 'var(--blue)' } : undefined}>
            {h % 3 === 0 ? String(h).padStart(2, '0') : ''}
          </span>
        ))}
        {[1, 2, 3, 4, 5, 6, 0].map((wd) => (
          <FragmentRow key={wd} label={DAYS[wd]} cells={tp.grid[wd].map((v) => level(v))} values={tp.grid[wd]} />
        ))}
      </div>
      <div className="legend">
        less <i style={{ background: 'var(--heat-0)' }} />
        <i style={{ background: 'var(--heat-1)' }} />
        <i style={{ background: 'var(--heat-2)' }} />
        <i style={{ background: 'var(--heat-3)' }} />
        <i style={{ background: 'var(--heat-4)' }} /> more · local time {formatOffset(tp.offset)} · <span style={{ color: 'var(--blue)' }}>blue hours</span> = inferred sleep
      </div>
    </div>
  )
}

function FragmentRow({ label, cells, values }: { label: string; cells: number[]; values: number[] }) {
  return (
    <>
      <span className="w">{label}</span>
      {cells.map((lv, h) => (
        <span key={h} className="c" title={`${label} ${String(h).padStart(2, '0')}:00 · ${values[h]} events`} style={{ background: `var(--heat-${lv})` }} />
      ))}
    </>
  )
}

export function TimePanels({ d }: { d: Dossier }) {
  const tp = timeProfile([...d.activity, ...d.dmsSent])
  const cl = clients(d)
  const geo = geotags(d)
  return (
    <>
      {tp ? (
        <Panel title={`When the subject is awake · ${tp.sample.toLocaleString()} timestamps`}>
          <Heatmap tp={tp} />
          <div className="stats" style={{ marginTop: 14 }}>
            <Stat k="inferred offset" v={formatOffset(tp.offset)} sub={tp.regions.slice(0, 3).join(', ')} />
            <Stat k="sleeps" v={`${pad(tp.quietStart)}–${pad(tp.quietEnd)}`} sub="local, quietest 6h" />
            <Stat k="peak" v={`${pad(tp.peakStart)}–${pad(tp.peakEnd)}`} sub="local, busiest 3h" />
            <Stat k="weekends" v={`${Math.round(tp.weekendShare * 100)}%`} sub={tp.weekendShare < 0.2 ? 'weekday-heavy: a work pattern' : tp.weekendShare > 0.35 ? 'weekend-heavy: a hobby pattern' : 'even spread'} />
          </div>
        </Panel>
      ) : (
        <p className="empty">Fewer than 20 timestamped events. Not enough to fit a daily rhythm.</p>
      )}
      {cl.length > 0 && (
        <Panel title="Software fingerprint (client tags)">
          <div className="tbl-wrap">
            <table className="tbl">
              <tbody>
                {cl.slice(0, 8).map((c) => (
                  <tr key={c.name}>
                    <td className="mono">{c.name}</td>
                    <td className="num">{c.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
      {geo.length > 0 && (
        <Panel title="Geotags">
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>when</th>
                  <th>geohash</th>
                  <th>approx. position</th>
                  <th className="num">± km</th>
                </tr>
              </thead>
              <tbody>
                {geo.slice(0, 10).map((g) => (
                  <tr key={g.noteId}>
                    <td className="mono">{fmtDate(g.at)}</td>
                    <td className="mono">{g.hash}</td>
                    <td className="mono">
                      {g.lat.toFixed(3)}, {g.lon.toFixed(3)}
                    </td>
                    <td className="num">{g.errKm}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </>
  )
}

const pad = (h: number) => `${String(h).padStart(2, '0')}:00`

function Stat({ k, v, sub, small }: { k: string; v: ReactNode; sub?: string; small?: boolean }) {
  return (
    <div className="stat">
      <div className="label">{k}</div>
      <div className={`v ${small ? 'sm' : ''}`}>{v}</div>
      {sub && <div className="muted" style={{ fontSize: 12 }}>{sub}</div>}
    </div>
  )
}

// ---------- messages ----------

export function MessagePanels({ d, offset }: { d: Dossier; offset: number }) {
  const contacts = dmContacts(d)
  const max = Math.max(1, ...contacts.map((c) => c.sent + c.received))
  const served = Object.entries(d.dmServedBy).sort((a, b) => b[1] - a[1])
  const refused = Object.entries(d.dmRefusedBy)
  const typicalHour = (hours: number[]) => {
    const best = hours.indexOf(Math.max(...hours))
    return (((best + offset) % 24) + 24) % 24
  }
  return (
    <>
      <Panel title={`Who the subject talks to in private · ${contacts.length} contacts`}>
        {contacts.length ? (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>contact</th>
                  <th className="num">sent</th>
                  <th className="num">received</th>
                  <th>volume</th>
                  <th>usual hour</th>
                  <th>since</th>
                  <th>last</th>
                </tr>
              </thead>
              <tbody>
                {contacts.slice(0, 15).map((c) => (
                  <tr key={c.pubkey}>
                    <td>
                      <Who pk={c.pubkey} />
                    </td>
                    <td className="num">{c.sent}</td>
                    <td className="num">{c.received}</td>
                    <td style={{ width: 120 }}>
                      <div className="bar">
                        <i style={{ width: `${((c.sent + c.received) / max) * 100}%` }} />
                      </div>
                    </td>
                    <td className="mono">{pad(Math.round(typicalHour(c.hours)) % 24)}</td>
                    <td className="mono">{fmtDate(c.first)}</td>
                    <td className="mono">{fmtAgo(c.last)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {contacts.length > 15 && <p className="muted" style={{ fontSize: 13 }}>…and {contacts.length - 15} more.</p>}
          </div>
        ) : (
          <p className="empty">No legacy (kind-4) DMs visible to an outsider.</p>
        )}
      </Panel>
      {(served.length > 0 || refused.length > 0) && (
        <Panel title="Which relays gave the DM metadata away">
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>relay</th>
                  <th>answer to an unauthenticated stranger</th>
                </tr>
              </thead>
              <tbody>
                {served.map(([r, n]) => (
                  <tr key={r}>
                    <td className="mono">{host(r)}</td>
                    <td style={{ color: 'var(--red)' }}>served {n} DM events</td>
                  </tr>
                ))}
                {refused.map(([r, why]) => (
                  <tr key={r}>
                    <td className="mono">{host(r)}</td>
                    <td style={{ color: 'var(--green)' }}>refused · {why.replace(/^ERROR:\s*/i, '').slice(0, 80)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </>
  )
}

// ---------- money ----------

export function MoneyPanels({ d }: { d: Dossier }) {
  const z = zapSummary(d)
  const L = d.lightning
  const payee = L.payeeNode
  const funding = L.funding.find((f) => f.status === 'resolved')
  const chain: { k: string; v: string; s?: string; tone?: 'hot' | 'ok' }[] = []
  if (L.address || L.domain) chain.push({ k: 'lightning address', v: L.address ?? L.domain ?? '', s: L.provider ? `${L.provider.name}${L.provider.custodial === true ? ' · custodial' : ''}` : undefined, tone: L.provider?.custodial === true ? 'hot' : undefined })
  if (L.lnurl) chain.push({ k: 'lnurl server', v: host(new URL(L.lnurl.callback).host), s: L.lnurl.allowsNostr ? 'publishes zap receipts' : 'no zap receipts' })
  else if (L.lnurlError) chain.push({ k: 'lnurl server', v: 'unreachable', s: L.lnurlError })
  if (L.invoice) chain.push({ k: 'invoice', v: `${L.invoice.routeHints.length} route hint${L.invoice.routeHints.length === 1 ? '' : 's'}`, s: L.invoice.blindedPaths ? 'blinded paths' : `payee key ${L.invoice.payeeFromTag ? 'in n-tag' : 'recovered from signature'}` })
  if (L.invoice)
    chain.push({
      k: 'payee node',
      v: payee?.alias ?? `${L.invoice.payee.slice(0, 14)}…`,
      s: payee?.announced ? [nodeOperatorGuess(payee.alias), payee.city, payee.country, payee.isp].filter(Boolean).join(' · ') || 'public node' : 'unannounced (private) node',
      tone: payee?.announced && !nodeOperatorGuess(payee.alias) && (payee.sockets ?? []).some((s) => !s.includes('.onion')) ? 'hot' : undefined,
    })
  if (L.funding.length)
    chain.push(
      funding
        ? { k: 'channel funding', v: `${funding.txid?.slice(0, 12)}…:${funding.vout}`, s: `${btc(funding.valueSats ?? 0)} · ${funding.inputs?.length ?? 0} inputs${funding.spent ? ' · closed' : ''}`, tone: 'hot' }
        : { k: 'channel funding', v: 'hidden', s: 'scid alias: no on-chain pointer', tone: 'ok' },
    )
  return (
    <>
      {chain.length > 0 && (
        <Panel title="Following the lightning address">
          <div className="chain">
            <div className="node">
              <div className="k">npub</div>
              <div className="v">{d.npub.slice(0, 14)}…</div>
              <div className="s">kind-0 profile</div>
            </div>
            {chain.map((c, i) => (
              <ChainStep key={i} {...c} />
            ))}
          </div>
          {funding?.inputs?.length ? (
            <div className="tbl-wrap" style={{ marginTop: 12 }}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>funding input address</th>
                    <th className="num">value</th>
                  </tr>
                </thead>
                <tbody>
                  {funding.inputs.slice(0, 8).map((inp, i) => (
                    <tr key={i}>
                      <td className="mono">{inp.address ?? 'unknown'}</td>
                      <td className="num">{btc(inp.valueSats)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </Panel>
      )}
      {(z.inCount > 0 || z.outCount > 0) && (
        <Panel title="Zap ledger (public receipts, kind 9735)">
          <div className="stats">
            <Stat k="received" v={sats(z.inSats)} sub={`${z.inCount} zaps · ${z.senders.length} payers`} />
            <Stat k="sent" v={sats(z.outSats)} sub={`${z.outCount} zaps · ${z.recipients.length} payees`} />
            <Stat k="largest in" v={z.largestIn ? sats(z.largestIn.sats) : '—'} sub={fmtDate(z.largestIn?.at)} />
            <Stat small k="history" v={`${fmtDate(z.first).slice(0, 7)} → ${fmtDate(z.last).slice(0, 7)}`} sub={`${z.withMessages} with public messages`} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 20, marginTop: 14 }}>
            <LedgerTable title="Top payers" rows={z.senders.slice(0, 8)} max={z.senders[0]?.sats ?? 1} />
            <LedgerTable title="Top payees" rows={z.recipients.slice(0, 8)} max={z.recipients[0]?.sats ?? 1} />
          </div>
        </Panel>
      )}
      {L.zapPayees.length > 0 && (
        <Panel title="Where the zaps actually landed (bolt11 payee keys)">
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>node</th>
                  <th>operator guess</th>
                  <th>location</th>
                  <th className="num">zaps</th>
                </tr>
              </thead>
              <tbody>
                {L.zapPayees.map((p) => (
                  <tr key={p.pubkey}>
                    <td className="mono">{p.node?.alias ?? `${p.pubkey.slice(0, 16)}… (private)`}</td>
                    <td>{nodeOperatorGuess(p.node?.alias) ?? '—'}</td>
                    <td>{[p.node?.city, p.node?.country].filter(Boolean).join(', ') || '—'}</td>
                    <td className="num">{p.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
      {d.onchain.length > 0 && (
        <Panel title="Bitcoin addresses posted in notes">
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>address</th>
                  <th>posted</th>
                  <th className="num">txs</th>
                  <th className="num">received</th>
                  <th className="num">balance</th>
                </tr>
              </thead>
              <tbody>
                {d.onchain.map((a) => (
                  <tr key={a.address}>
                    <td className="mono">{a.address}</td>
                    <td className="mono">
                      <a href={`https://njump.me/${nip19.noteEncode(a.noteId)}`} target="_blank" rel="noreferrer noopener">
                        {fmtDate(a.at)}
                      </a>
                    </td>
                    <td className="num">{a.txCount ?? '—'}</td>
                    <td className="num">{a.receivedSats !== undefined ? btc(a.receivedSats) : '—'}</td>
                    <td className="num">{a.balanceSats !== undefined ? btc(a.balanceSats) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </>
  )
}

function ChainStep({ k, v, s, tone }: { k: string; v: string; s?: string; tone?: 'hot' | 'ok' }) {
  return (
    <>
      <div className="arrow" aria-hidden>
        →
      </div>
      <div className={`node ${tone ?? ''}`}>
        <div className="k">{k}</div>
        <div className="v">{v}</div>
        {s && <div className="s">{s}</div>}
      </div>
    </>
  )
}

function LedgerTable({ title, rows, max }: { title: string; rows: { pubkey: string; sats: number; count: number }[]; max: number }) {
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th>{title}</th>
            <th className="num">sats</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.length ? (
            rows.map((r) => (
              <tr key={r.pubkey}>
                <td>
                  <Who pk={r.pubkey} />
                </td>
                <td className="num">{r.sats.toLocaleString()}</td>
                <td style={{ width: 70 }}>
                  <div className="bar">
                    <i className="b" style={{ width: `${(r.sats / max) * 100}%` }} />
                  </div>
                </td>
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={3} className="muted">
                none
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

// ---------- social ----------

export function SocialPanels({ d }: { d: Dossier }) {
  const ties = innerCircle(d, 16)
  const name = (d.profile?.display_name as string) || d.profile?.name || 'subject'
  if (!ties.length) return <p className="empty">Not enough interactions to chart.</p>
  return (
    <>
      <Panel title="Link chart">
        <LinkChart subjectName={String(name).slice(0, 20)} ties={ties} />
      </Panel>
      <Panel title="Ranked ties">
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>contact</th>
                <th className="num">DMs</th>
                <th className="num">zaps</th>
                <th className="num">replies</th>
                <th>follows</th>
              </tr>
            </thead>
            <tbody>
              {ties.slice(0, 10).map((t) => (
                <tr key={t.pubkey}>
                  <td>
                    <Who pk={t.pubkey} />
                  </td>
                  <td className="num">{t.dms || '—'}</td>
                  <td className="num">{t.zaps || '—'}</td>
                  <td className="num">{t.replies || '—'}</td>
                  <td className="mono">{t.follows ? 'yes' : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  )
}

// ---------- media ----------

export function MediaPanels({ d }: { d: Dossier }) {
  if (!d.media.length) return <p className="empty">No images found in recent notes, or image scanning is off.</p>
  const label = { gps: 'GPS in EXIF', exif: 'camera metadata', clean: 'clean', blocked: 'unreadable (CORS)', error: 'fetch failed' }
  const color = { gps: 'var(--red)', exif: 'var(--amber)', clean: 'var(--green)', blocked: 'var(--muted)', error: 'var(--muted)' }
  return (
    <Panel title={`${d.media.length} most recent images, first 192 KB of each`}>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>posted</th>
              <th>host</th>
              <th>result</th>
              <th>detail</th>
            </tr>
          </thead>
          <tbody>
            {d.media.map((m) => (
              <tr key={m.url}>
                <td className="mono">{fmtDate(m.at)}</td>
                <td className="mono">
                  {m.host}
                  {m.contentAddressed ? ' · sha256' : ''}
                </td>
                <td style={{ color: color[m.status] }}>{label[m.status]}</td>
                <td className="mono">{m.status === 'gps' ? `${m.lat?.toFixed(5)}, ${m.lon?.toFixed(5)}` : [m.camera, m.taken?.slice(0, 10)].filter(Boolean).join(' · ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

// ---------- relays ----------

export function RelayPanels({ d }: { d: Dossier }) {
  const rows = [...d.coverage].sort((a, b) => Number(b.reachable) - Number(a.reachable))
  const own = new Set([...d.relayList.write, ...d.relayList.both, ...d.relayList.read, ...d.dmRelays])
  return (
    <Panel title={`Coverage: ${d.coverage.filter((c) => c.reachable).length}/${d.coverage.length} relays answered`}>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>relay</th>
              <th className="num">events</th>
              <th className="num">DMs</th>
              <th className="num">zaps</th>
              <th className="num">deleted, still served</th>
              <th>note</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const dm = (c.counts.dmsSent ?? 0) + (c.counts.dmsRecv ?? 0)
              const stale = d.stillServed[c.relay]?.length ?? 0
              const refused = c.refused.dmsSent || c.refused.dmsRecv
              return (
                <tr key={c.relay}>
                  <td className="mono">
                    {host(c.relay)}
                    {own.has(c.relay) ? <span className="muted"> · subject's</span> : null}
                  </td>
                  <td className="num">{c.reachable ? (c.counts.activity ?? 0) : '—'}</td>
                  <td className="num" style={dm ? { color: 'var(--red)' } : undefined}>
                    {c.reachable ? (refused ? 'auth' : dm) : '—'}
                  </td>
                  <td className="num">{c.reachable ? (c.counts.zapsIn ?? 0) + (c.counts.zapsOut ?? 0) : '—'}</td>
                  <td className="num" style={stale ? { color: 'var(--red)' } : undefined}>
                    {c.reachable && d.deletionTargets.length ? stale : '—'}
                  </td>
                  <td className="muted" style={{ fontSize: 12.5 }}>
                    {c.reachable ? '' : (c.error ?? 'no answer')}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}
