import { createContext, useContext, type ReactNode } from 'react'
import * as nip19 from 'nostr-tools/nip19'
import type { Finding, Severity } from '../lib/types'

export interface Identity {
  /** true once the viewer has proven (via NIP-07) that they are the subject */
  unlocked: boolean
  aliasOf: (pk: string) => number
  names: Record<string, { name?: string; nip05?: string }>
}

export const IdentityCtx = createContext<Identity>({ unlocked: false, aliasOf: () => 0, names: {} })

const PALETTE = ['#b3261e', '#25507a', '#9a5b00', '#2e6b3c', '#6b3d8f', '#8a6d1f', '#1f6f73', '#8f3b5c', '#4a5a1f', '#5c4033']

export function aliasColor(n: number): string {
  return PALETTE[n % PALETTE.length]
}

export function shortNpub(pk: string): string {
  try {
    const n = nip19.npubEncode(pk)
    return `${n.slice(0, 10)}…${n.slice(-4)}`
  } catch {
    return pk.slice(0, 10)
  }
}

/** A third party. Pseudonymised unless the viewer is the subject of the file. */
export function Who({ pk, plain }: { pk?: string; plain?: boolean }) {
  const { unlocked, aliasOf, names } = useContext(IdentityCtx)
  if (!pk) return <span className="alias muted">anonymous</span>
  const n = aliasOf(pk)
  const label = `Contact ${String(n).padStart(2, '0')}`
  if (!unlocked) {
    return (
      <span className="alias" title="Third parties are pseudonymised. Sign in as the subject to see who they are.">
        {!plain && <span className="dot" style={{ background: aliasColor(n) }} />}
        {label}
      </span>
    )
  }
  const nm = names[pk]
  return (
    <span className="alias" title={pk}>
      {!plain && <span className="dot" style={{ background: aliasColor(n) }} />}
      <a href={`https://njump.me/${nip19.npubEncode(pk)}`} target="_blank" rel="noreferrer noopener">
        {nm?.name || shortNpub(pk)}
      </a>
    </span>
  )
}

export function Sev({ s }: { s: Severity }) {
  const label = s === 'good' ? 'in favour' : s
  return <span className={`sev ${s}`}>{label}</span>
}

export function FindingList({ items }: { items: Finding[] }) {
  if (!items.length) return <p className="empty">Nothing to report in this section.</p>
  return (
    <ul className="findings">
      {items.map((f) => (
        <li key={f.id} className="finding">
          <Sev s={f.severity} />
          <div>
            <div className="t">{f.title}</div>
            <div className="d">{f.detail}</div>
            {f.fix && <div className="fix">{f.fix}</div>}
          </div>
        </li>
      ))}
    </ul>
  )
}

export function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="panel">
      <h3>{title}</h3>
      {children}
    </div>
  )
}

export const fmtDate = (t?: number) => (t ? new Date(t * 1000).toISOString().slice(0, 10) : '—')
export const fmtAgo = (t?: number) => {
  if (!t) return '—'
  const s = Date.now() / 1000 - t
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  if (s < 86400 * 60) return `${Math.round(s / 86400)}d ago`
  if (s < 86400 * 365 * 2) return `${Math.round(s / (86400 * 30))}mo ago`
  return `${(s / (86400 * 365)).toFixed(1)}y ago`
}
export const sats = (n: number) => `${n.toLocaleString()} sats`
export const btc = (s: number) => `${(s / 1e8).toFixed(s >= 1e6 ? 4 : 6)} BTC`
export const host = (r: string) => r.replace(/^wss?:\/\//, '')
