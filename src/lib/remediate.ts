// One-click fixes. Everything that needs a signature goes through the user's NIP-07 extension;
// the page never sees a private key. Rebroadcasting existing deletion requests needs no signature.

import { RelayPool, type NEvent } from './relay'
import { findAddresses, findPII } from './scan'
import type { Dossier } from './types'

export interface UnsignedEvent {
  kind: number
  created_at: number
  tags: string[][]
  content: string
}

interface Nip07 {
  getPublicKey(): Promise<string>
  signEvent(ev: UnsignedEvent): Promise<NEvent>
}

declare global {
  interface Window {
    nostr?: Nip07
  }
}

export function hasSigner(): boolean {
  return typeof window !== 'undefined' && !!window.nostr
}

export async function signerPubkey(): Promise<string | undefined> {
  if (!hasSigner()) return undefined
  try {
    return await window.nostr!.getPublicKey()
  } catch {
    return undefined
  }
}

const now = () => Math.floor(Date.now() / 1000)

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

/** NIP-09 deletion requests, batched so no single event gets rejected for size. */
export function deletionRequests(ids: string[], kinds: number[], reason: string): UnsignedEvent[] {
  return chunk(ids, 200).map((batch) => ({
    kind: 5,
    created_at: now(),
    tags: [...batch.map((id) => ['e', id]), ...[...new Set(kinds)].map((k) => ['k', String(k)])],
    content: reason,
  }))
}

export function planDeleteDms(d: Dossier): UnsignedEvent[] {
  return deletionRequests(
    d.dmsSent.map((e) => e.id),
    [4],
    'Removing legacy NIP-04 DMs: their metadata is public. Moving to NIP-17.',
  )
}

export const SUGGESTED_DM_RELAYS = ['wss://inbox.nostr.wine', 'wss://auth.nostr1.com', 'wss://relay.0xchat.com']

export function planDmInbox(d: Dossier, relays = SUGGESTED_DM_RELAYS): UnsignedEvent[] {
  const list = d.dmRelays.length ? d.dmRelays : relays
  return [{ kind: 10050, created_at: now(), tags: list.map((r) => ['relay', r]), content: '' }]
}

export interface LeakyNote {
  id: string
  kind: number
  reason: string
  preview: string
}

export function leakyNotes(d: Dossier): LeakyNote[] {
  const out = new Map<string, LeakyNote>()
  const byId = new Map(d.activity.map((e) => [e.id, e]))
  const preview = (id: string) => (byId.get(id)?.content ?? '').replace(/\s+/g, ' ').slice(0, 90)
  for (const a of findAddresses(d.activity)) out.set(a.noteId, { id: a.noteId, kind: byId.get(a.noteId)?.kind ?? 1, reason: `bitcoin address ${a.address.slice(0, 10)}…`, preview: preview(a.noteId) })
  for (const m of d.media) if (m.status === 'gps') out.set(m.noteId, { id: m.noteId, kind: byId.get(m.noteId)?.kind ?? 1, reason: 'photo with GPS coordinates', preview: preview(m.noteId) })
  for (const e of d.activity) {
    if (e.tags.some((t) => t[0] === 'g')) out.set(e.id, { id: e.id, kind: e.kind, reason: 'geohash location tag', preview: preview(e.id) })
    if (e.kind === 1 && findPII(e.content).phones.length) out.set(e.id, { id: e.id, kind: e.kind, reason: 'phone number', preview: preview(e.id) })
  }
  return [...out.values()]
}

export function planDeleteLeaky(d: Dossier, ids: string[]): UnsignedEvent[] {
  const notes = leakyNotes(d).filter((n) => ids.includes(n.id))
  return deletionRequests(
    notes.map((n) => n.id),
    notes.map((n) => n.kind),
    'Removing notes that leak location or financial details.',
  )
}

export const SCRUBBABLE: string[] = ['website', 'lud16', 'lud06', 'nip05', 'about']

export function planScrubProfile(d: Dossier, remove: string[]): UnsignedEvent[] {
  if (!d.profileEvent) return []
  const p = { ...(d.profile ?? {}) }
  for (const k of remove) delete p[k]
  return [{ kind: 0, created_at: now(), tags: d.profileEvent.tags.filter((t) => t[0] !== 'i'), content: JSON.stringify(p) }]
}

export interface PublishReport {
  eventId: string
  results: { relay: string; ok: boolean; message: string }[]
}

export function targetRelays(d: Dossier): string[] {
  const own = [...d.relayList.write, ...d.relayList.both]
  const reachable = d.coverage.filter((c) => c.reachable).map((c) => c.relay)
  return [...new Set([...own, ...reachable])]
}

export async function signAndPublish(d: Dossier, unsigned: UnsignedEvent[], onProgress?: (msg: string) => void): Promise<PublishReport[]> {
  if (!hasSigner()) throw new Error('No NIP-07 signer found. Install a signer extension (Alby, nos2x, Keys.band).')
  const who = await window.nostr!.getPublicKey()
  if (who !== d.pubkey) throw new Error('The connected signer is a different key than the subject of this file.')
  const pool = new RelayPool()
  const relays = targetRelays(d)
  const reports: PublishReport[] = []
  try {
    for (const [i, ev] of unsigned.entries()) {
      onProgress?.(`Signing ${i + 1}/${unsigned.length}…`)
      const signed = await window.nostr!.signEvent(ev)
      onProgress?.(`Publishing to ${relays.length} relays…`)
      const results = await Promise.all(relays.map((r) => pool.get(r).publish(signed)))
      reports.push({ eventId: signed.id, results })
    }
  } finally {
    pool.closeAll()
  }
  return reports
}

/** Push the subject's own, already-signed deletion requests to relays that still serve deleted events. */
export async function rebroadcastDeletions(d: Dossier, onProgress?: (msg: string) => void): Promise<PublishReport[]> {
  const pool = new RelayPool()
  const reports: PublishReport[] = []
  const offenders = Object.entries(d.stillServed)
  try {
    for (const del of d.deletions) {
      const refs = new Set(del.tags.filter((t) => t[0] === 'e').map((t) => t[1]))
      const relays = offenders.filter(([, ids]) => ids.some((id) => refs.has(id))).map(([r]) => r)
      if (!relays.length) continue
      onProgress?.(`Rebroadcasting ${del.id.slice(0, 8)}… to ${relays.length} relays`)
      const results = await Promise.all(relays.map((r) => pool.get(r).publish(del)))
      reports.push({ eventId: del.id, results })
    }
  } finally {
    pool.closeAll()
  }
  return reports
}
