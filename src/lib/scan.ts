// Content scanners: things people paste into notes without thinking about what they link.

import { bech32, bech32m, createBase58check } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2.js'
import { decodeInvoice } from './bolt11'
import type { NEvent } from './relay'

const b58c = createBase58check(sha256)

export function isValidBtcAddress(addr: string): boolean {
  const a = addr.trim()
  if (/^bc1/i.test(a)) {
    const lower = a.toLowerCase()
    for (const codec of [bech32, bech32m]) {
      try {
        const { prefix, words } = codec.decode(lower as `bc1${string}`, 90)
        if (prefix !== 'bc') continue
        const version = words[0]
        if ((version === 0 && codec === bech32) || (version > 0 && codec === bech32m)) return true
      } catch {
        /* try next */
      }
    }
    return false
  }
  if (/^[13]/.test(a)) {
    try {
      const raw = b58c.decode(a)
      return raw.length === 21 && (raw[0] === 0x00 || raw[0] === 0x05)
    } catch {
      return false
    }
  }
  return false
}

const ADDR_RE = /\b(bc1[ac-hj-np-z02-9]{25,87}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})\b/gi
const INVOICE_RE = /\b(lnbc[0-9a-z]{80,})\b/gi
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
const PHONE_RE = /(?<![\w/.-])\+\d[\d\s().-]{8,16}\d(?![\w/-])/g
const IMG_RE = /https?:\/\/[^\s<>"')]+?\.(?:jpe?g|png|webp|heic|tiff?)(?:\?[^\s<>"')]*)?/gi
const SHA256_PATH = /\/[0-9a-f]{64}(?:\.[a-z0-9]+)?(?:$|\?)/i

export function findAddresses(events: NEvent[]): { address: string; noteId: string; at: number }[] {
  const out = new Map<string, { address: string; noteId: string; at: number }>()
  for (const ev of events) {
    if (ev.kind !== 1 && ev.kind !== 30023 && ev.kind !== 0) continue
    for (const m of ev.content.matchAll(ADDR_RE)) {
      const a = m[1]
      if (!out.has(a) && isValidBtcAddress(a)) out.set(a, { address: a, noteId: ev.id, at: ev.created_at })
    }
  }
  return [...out.values()]
}

export function findInvoices(events: NEvent[]): { noteId: string; at: number; payee: string; amountSats: number }[] {
  const out: { noteId: string; at: number; payee: string; amountSats: number }[] = []
  for (const ev of events) {
    if (ev.kind !== 1) continue
    for (const m of ev.content.matchAll(INVOICE_RE)) {
      try {
        const d = decodeInvoice(m[1])
        out.push({ noteId: ev.id, at: ev.created_at, payee: d.payee, amountSats: Math.floor((d.amountMsat ?? 0) / 1000) })
      } catch {
        /* not a valid invoice */
      }
    }
  }
  return out
}

// user@domain on Nostr is usually a NIP-05 handle or lightning address, not a mailbox.
// Only count it as an email when the domain is a mail provider or the text says so.
const MAIL_DOMAINS = /@(gmail|googlemail|proton(mail)?|pm|tutanota|tuta|outlook|hotmail|live|yahoo|icloud|me|fastmail|hey|zoho|gmx|yandex|mail|aol|posteo|disroot|riseup|mailbox)\./i
const MAIL_CONTEXT = /(e-?mail|mail me|contact|reach me|write to|inquir|business)[^\n]{0,40}$/i

export function findPII(text: string): { emails: string[]; phones: string[] } {
  const emails = [
    ...new Set(
      [...text.matchAll(EMAIL_RE)]
        .filter((m) => MAIL_DOMAINS.test(m[0]) || MAIL_CONTEXT.test(text.slice(Math.max(0, (m.index ?? 0) - 48), m.index)))
        .map((m) => m[0]),
    ),
  ].filter((e) => !/\.(png|jpe?g|gif|webp)$/i.test(e))
  const phones = [...new Set([...text.matchAll(PHONE_RE)].map((m) => m[0].trim()))].filter((p) => p.replace(/\D/g, '').length >= 10)
  return { emails, phones }
}

export function findImages(events: NEvent[], max = 30): { url: string; noteId: string; at: number; host: string; contentAddressed: boolean }[] {
  const seen = new Set<string>()
  const out: { url: string; noteId: string; at: number; host: string; contentAddressed: boolean }[] = []
  for (const ev of [...events].sort((a, b) => b.created_at - a.created_at)) {
    if (ev.kind !== 1 && ev.kind !== 20) continue
    const urls = [...ev.content.matchAll(IMG_RE)].map((m) => m[0])
    for (const t of ev.tags) if (t[0] === 'imeta') for (const f of t) if (f.startsWith('url ')) urls.push(f.slice(4))
    for (const url of urls) {
      if (seen.has(url)) continue
      seen.add(url)
      let host = ''
      try {
        host = new URL(url).hostname
      } catch {
        continue
      }
      out.push({ url, noteId: ev.id, at: ev.created_at, host, contentAddressed: SHA256_PATH.test(new URL(url).pathname) })
      if (out.length >= max) return out
    }
  }
  return out
}

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz'
export function decodeGeohash(hash: string): { lat: number; lon: number; errKm: number } | undefined {
  let even = true
  const lat = [-90, 90]
  const lon = [-180, 180]
  for (const c of hash.toLowerCase()) {
    const idx = BASE32.indexOf(c)
    if (idx < 0) return undefined
    for (let bit = 4; bit >= 0; bit--) {
      const on = (idx >> bit) & 1
      const range = even ? lon : lat
      const mid = (range[0] + range[1]) / 2
      if (on) range[0] = mid
      else range[1] = mid
      even = !even
    }
  }
  const latErr = (lat[1] - lat[0]) / 2
  return { lat: (lat[0] + lat[1]) / 2, lon: (lon[0] + lon[1]) / 2, errKm: Math.round(latErr * 111) }
}

export function clientTag(ev: NEvent): string | undefined {
  const t = ev.tags.find((x) => x[0] === 'client')
  return t?.[1]
}
