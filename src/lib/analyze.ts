// Turns the raw file into the conclusions an analyst would write down.
// Every function here is pure so the UI can re-run it as data streams in.

import type { NEvent } from './relay'
import type { Dossier, Finding, Severity } from './types'
import { clientTag, decodeGeohash, findPII } from './scan'
import { nodeOperatorGuess } from './lightning'

// ---------- pattern of life ----------

// Relative activity by local hour for social-media users (smoothed from published
// diurnal studies of Twitter/Mastodon posting). Only its shape matters.
const HUMAN_DAY = [0.62, 0.42, 0.26, 0.16, 0.11, 0.12, 0.22, 0.42, 0.62, 0.78, 0.88, 0.94, 1.0, 0.97, 0.93, 0.92, 0.94, 0.97, 1.02, 1.07, 1.12, 1.12, 1.02, 0.84]

export interface TimeProfile {
  sample: number
  hourUtc: number[]
  weekdayUtc: number[]
  grid: number[][] // [weekday][hour] in local time
  offset: number // hours, multiple of 0.5
  confidence: 'low' | 'medium' | 'high'
  zScore: number
  quietStart: number // local hour
  quietEnd: number
  peakStart: number
  peakEnd: number
  weekendShare: number
  regions: string[]
}

const REGIONS: Record<string, string[]> = {
  '-10': ['Hawaii'],
  '-9': ['Alaska'],
  '-8': ['US/Canada Pacific'],
  '-7': ['US Mountain', 'Pacific (DST)'],
  '-6': ['US Central', 'Mexico', 'Central America'],
  '-5': ['US Eastern', 'Colombia', 'Peru'],
  '-4': ['Atlantic', 'Venezuela', 'Bolivia', 'US Eastern (DST)'],
  '-3': ['Brazil', 'Argentina', 'Uruguay'],
  '-1': ['Azores', 'Cape Verde'],
  '0': ['UK', 'Portugal', 'Ghana', 'Iceland'],
  '1': ['Central Europe', 'Nigeria', 'UK (BST)'],
  '2': ['Eastern Europe', 'South Africa', 'Central Europe (DST)'],
  '3': ['Turkey', 'Moscow', 'East Africa', 'Gulf'],
  '3.5': ['Iran'],
  '4': ['UAE', 'Georgia', 'Armenia'],
  '4.5': ['Afghanistan'],
  '5': ['Pakistan', 'Uzbekistan'],
  '5.5': ['India', 'Sri Lanka'],
  '6': ['Bangladesh', 'Kazakhstan'],
  '6.5': ['Myanmar'],
  '7': ['Thailand', 'Vietnam', 'Western Indonesia'],
  '8': ['China', 'Singapore', 'Philippines', 'Western Australia'],
  '9': ['Japan', 'Korea'],
  '9.5': ['Central Australia'],
  '10': ['Eastern Australia'],
  '11': ['Eastern Australia (DST)', 'Solomon Is.'],
  '12': ['New Zealand', 'Fiji'],
  '13': ['New Zealand (DST)', 'Tonga'],
}

/** Regions within ±1h, nearest first. */
export function regionsFor(offset: number): string[] {
  const out: string[] = []
  for (const delta of [0, -0.5, 0.5, -1, 1]) for (const r of REGIONS[String(offset + delta)] ?? []) if (!out.includes(r)) out.push(r)
  return out
}

export function formatOffset(o: number): string {
  const sign = o < 0 ? '−' : '+'
  const a = Math.abs(o)
  const h = Math.floor(a)
  const m = Math.round((a - h) * 60)
  return `UTC${sign}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

export function timeProfile(events: NEvent[]): TimeProfile | undefined {
  // Only events a human authored in real time: gift wraps and similar randomise created_at.
  const ts = events.filter((e) => e.kind !== 1059 && e.kind !== 13).map((e) => e.created_at)
  if (ts.length < 20) return undefined
  const BINS = 96
  const h = new Array<number>(BINS).fill(0)
  const hourUtc = new Array<number>(24).fill(0)
  const weekdayUtc = new Array<number>(7).fill(0)
  for (const t of ts) {
    const date = new Date(t * 1000)
    const mins = date.getUTCHours() * 60 + date.getUTCMinutes()
    h[Math.floor(mins / 15)]++
    hourUtc[date.getUTCHours()]++
    weekdayUtc[date.getUTCDay()]++
  }
  // circular smoothing (σ ≈ 45 min)
  const kernel = [-4, -3, -2, -1, 0, 1, 2, 3, 4].map((k) => ({ k, w: Math.exp(-(k * k) / (2 * 3 * 3)) }))
  const sm = h.map((_, i) => kernel.reduce((s, { k, w }) => s + w * h[(i + k + BINS) % BINS], 0))
  const tmpl = Array.from({ length: BINS }, (_, i) => {
    const x = i / 4
    const a = Math.floor(x) % 24
    const b = (a + 1) % 24
    const f = x - Math.floor(x)
    return HUMAN_DAY[a] * (1 - f) + HUMAN_DAY[b] * f
  })
  const tMean = tmpl.reduce((a, b) => a + b, 0) / BINS
  const scores: { o: number; s: number }[] = []
  // offsets from −12h to +14h in 15-minute steps
  for (let q = -48; q <= 56; q++) {
    let s = 0
    for (let b = 0; b < BINS; b++) s += sm[b] * (tmpl[(((b + q) % BINS) + BINS) % BINS] - tMean)
    scores.push({ o: q / 4, s })
  }
  const best = scores.reduce((a, b) => (b.s > a.s ? b : a))
  const mean = scores.reduce((a, b) => a + b.s, 0) / scores.length
  const std = Math.sqrt(scores.reduce((a, b) => a + (b.s - mean) ** 2, 0) / scores.length) || 1
  const zScore = (best.s - mean) / std
  let offset = Math.round(best.o * 2) / 2
  if (offset > 14) offset -= 24
  const confidence: TimeProfile['confidence'] = ts.length >= 400 && zScore >= 1.6 ? 'high' : ts.length >= 120 && zScore >= 1.3 ? 'medium' : 'low'

  // local-time views
  const localHour = new Array<number>(24).fill(0)
  const grid = Array.from({ length: 7 }, () => new Array<number>(24).fill(0))
  let weekend = 0
  for (const t of ts) {
    const local = new Date((t + offset * 3600) * 1000)
    const hr = local.getUTCHours()
    const wd = local.getUTCDay()
    localHour[hr]++
    grid[wd][hr]++
    if (wd === 0 || wd === 6) weekend++
  }
  const windowSum = (start: number, len: number) => Array.from({ length: len }, (_, i) => localHour[(start + i) % 24]).reduce((a, b) => a + b, 0)
  let quietStart = 0
  let peakStart = 0
  for (let s = 0; s < 24; s++) {
    if (windowSum(s, 6) < windowSum(quietStart, 6)) quietStart = s
    if (windowSum(s, 3) > windowSum(peakStart, 3)) peakStart = s
  }
  return {
    sample: ts.length,
    hourUtc,
    weekdayUtc,
    grid,
    offset,
    confidence,
    zScore,
    quietStart,
    quietEnd: (quietStart + 6) % 24,
    peakStart,
    peakEnd: (peakStart + 3) % 24,
    weekendShare: weekend / ts.length,
    regions: regionsFor(offset),
  }
}

// ---------- private messages ----------

export interface Contact {
  pubkey: string
  sent: number
  received: number
  first: number
  last: number
  hours: number[]
}

export function dmContacts(d: Dossier): Contact[] {
  const map = new Map<string, Contact>()
  const touch = (pk: string, at: number, dir: 'sent' | 'received') => {
    let c = map.get(pk)
    if (!c) map.set(pk, (c = { pubkey: pk, sent: 0, received: 0, first: at, last: at, hours: new Array(24).fill(0) }))
    c[dir]++
    c.first = Math.min(c.first, at)
    c.last = Math.max(c.last, at)
    c.hours[new Date(at * 1000).getUTCHours()]++
  }
  for (const e of d.dmsSent) {
    const p = e.tags.find((t) => t[0] === 'p')?.[1]
    if (p && p !== d.pubkey) touch(p, e.created_at, 'sent')
  }
  for (const e of d.dmsRecv) if (e.pubkey !== d.pubkey) touch(e.pubkey, e.created_at, 'received')
  return [...map.values()].sort((a, b) => b.sent + b.received - (a.sent + a.received))
}

// ---------- money ----------

export interface ZapSummary {
  inSats: number
  outSats: number
  inCount: number
  outCount: number
  anonIn: number
  senders: { pubkey: string; sats: number; count: number }[]
  recipients: { pubkey: string; sats: number; count: number }[]
  largestIn?: { sats: number; at: number }
  withMessages: number
  first?: number
  last?: number
  receiptSigners: { pubkey: string; count: number }[]
}

export function zapSummary(d: Dossier): ZapSummary {
  const group = (items: { pk?: string; sats: number }[]) => {
    const m = new Map<string, { pubkey: string; sats: number; count: number }>()
    for (const it of items) {
      if (!it.pk) continue
      const g = m.get(it.pk) ?? { pubkey: it.pk, sats: 0, count: 0 }
      g.sats += it.sats
      g.count++
      m.set(it.pk, g)
    }
    return [...m.values()].sort((a, b) => b.sats - a.sats)
  }
  const signers = new Map<string, number>()
  d.zapsIn.forEach((z) => signers.set(z.receiptAuthor, (signers.get(z.receiptAuthor) ?? 0) + 1))
  const all = [...d.zapsIn, ...d.zapsOut].map((z) => z.at)
  const largest = d.zapsIn.reduce<{ sats: number; at: number } | undefined>((m, z) => (!m || z.sats > m.sats ? { sats: z.sats, at: z.at } : m), undefined)
  return {
    inSats: d.zapsIn.reduce((s, z) => s + z.sats, 0),
    outSats: d.zapsOut.reduce((s, z) => s + z.sats, 0),
    inCount: d.zapsIn.length,
    outCount: d.zapsOut.length,
    anonIn: d.zapsIn.filter((z) => z.anon).length,
    senders: group(d.zapsIn.map((z) => ({ pk: z.sender, sats: z.sats }))),
    recipients: group(d.zapsOut.map((z) => ({ pk: z.recipient, sats: z.sats }))),
    largestIn: largest,
    withMessages: [...d.zapsIn, ...d.zapsOut].filter((z) => z.message.trim()).length,
    first: all.length ? Math.min(...all) : undefined,
    last: all.length ? Math.max(...all) : undefined,
    receiptSigners: [...signers.entries()].map(([pubkey, count]) => ({ pubkey, count })).sort((a, b) => b.count - a.count),
  }
}

// ---------- social ----------

export interface Tie {
  pubkey: string
  score: number
  dms: number
  zaps: number
  replies: number
  follows: boolean
}

export function innerCircle(d: Dossier, limit = 12): Tie[] {
  const m = new Map<string, Tie>()
  const get = (pk: string) => {
    let t = m.get(pk)
    if (!t) m.set(pk, (t = { pubkey: pk, score: 0, dms: 0, zaps: 0, replies: 0, follows: false }))
    return t
  }
  for (const c of dmContacts(d)) get(c.pubkey).dms += c.sent + c.received
  for (const z of d.zapsIn) if (z.sender) get(z.sender).zaps++
  for (const z of d.zapsOut) get(z.recipient).zaps++
  for (const e of d.activity)
    if (e.kind === 1)
      for (const t of e.tags)
        if (t[0] === 'p' && t[1] && t[1] !== d.pubkey && /^[0-9a-f]{64}$/.test(t[1])) get(t[1]).replies++
  const follows = new Set(d.follows)
  for (const t of m.values()) {
    t.follows = follows.has(t.pubkey)
    // private channels weigh more than public replies: that's what an analyst cares about
    t.score = t.dms * 4 + t.zaps * 2 + Math.min(t.replies, 40) + (t.follows ? 3 : 0)
  }
  return [...m.values()].filter((t) => t.dms + t.zaps + t.replies > 0).sort((a, b) => b.score - a.score).slice(0, limit)
}

export function clients(d: Dossier): { name: string; count: number }[] {
  const m = new Map<string, number>()
  for (const e of d.activity) {
    const c = clientTag(e)
    if (c) m.set(c, (m.get(c) ?? 0) + 1)
  }
  return [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count)
}

export function geotags(d: Dossier): { hash: string; lat: number; lon: number; errKm: number; at: number; noteId: string }[] {
  const out: { hash: string; lat: number; lon: number; errKm: number; at: number; noteId: string }[] = []
  for (const e of d.activity) {
    const g = e.tags.filter((t) => t[0] === 'g' && t[1]).map((t) => t[1]).sort((a, b) => b.length - a.length)[0]
    if (!g) continue
    const p = decodeGeohash(g)
    if (p) out.push({ hash: g, ...p, at: e.created_at, noteId: e.id })
  }
  return out
}

// ---------- findings ----------

const fmtDate = (t: number) => new Date(t * 1000).toISOString().slice(0, 10)
const IRREGULAR: Record<string, string> = { person: 'people', address: 'addresses', 'email address': 'email addresses', 'bitcoin address': 'bitcoin addresses' }
const plural = (n: number, w: string) => `${n.toLocaleString()} ${n === 1 ? w : (IRREGULAR[w] ?? `${w}s`)}`
const hh = (h: number) => `${String(h).padStart(2, '0')}:00`

export function findings(d: Dossier): Finding[] {
  const f: Finding[] = []
  const add = (x: Finding) => f.push(x)
  const p = d.profile ?? {}

  // --- identity
  if (!d.profileEvent && d.stage !== 'Opening file') {
    add({ id: 'no-profile', chapter: 'identity', severity: 'info', title: 'No profile metadata found', detail: 'None of the queried relays returned a kind-0 profile for this key.' })
  }
  if (p.website) {
    add({ id: 'website', chapter: 'identity', severity: 'low', title: `Links out to ${String(p.website).replace(/^https?:\/\//, '').slice(0, 60)}`, detail: 'A website in the profile ties this key to whoever controls that domain (WHOIS, hosting, analytics on the site).' })
  }
  if (d.nip05) {
    const n = d.nip05
    if (n.listExposed && (n.namesOnDomain ?? 0) <= 25) {
      add({
        id: 'nip05-coresidents',
        chapter: 'identity',
        severity: 'medium',
        title: `${n.domain} publishes ${plural(n.namesOnDomain ?? 0, 'name')} for ${plural(n.pubkeysOnDomain ?? 0, 'key')}`,
        detail: `The NIP-05 server returns its full directory when asked without a name. On a small or personal domain, the other keys listed there are likely alts, family or colleagues of the subject.`,
        fix: 'Configure the nostr.json endpoint to answer only the ?name= that is asked for.',
      })
    } else if (n.verified) {
      add({ id: 'nip05', chapter: 'identity', severity: 'low', title: `Verified as ${n.identifier}`, detail: `NIP-05 ties the key to ${n.domain}. Whoever runs that domain can see every lookup of it, and the domain itself can be traced through its registrar and hosting.` })
    }
  }
  const pii = findPII([String(p.about ?? ''), ...d.activity.filter((e) => e.kind === 1).map((e) => e.content)].join('\n'))
  if (pii.emails.length || pii.phones.length) {
    add({
      id: 'pii',
      chapter: 'identity',
      severity: 'high',
      title: `Contact details in public text: ${[...pii.emails.slice(0, 2), ...pii.phones.slice(0, 1)].join(', ')}`,
      detail: `${plural(pii.emails.length, 'email address')} and ${plural(pii.phones.length, 'phone number')} appear in public text. These are the anchor points analysts use to jump from a pseudonym to a legal identity.`,
      fix: 'Delete the notes (NIP-09) and remove the details from your profile.',
      action: 'delete-leaky-notes',
    })
  }
  const idTags = (d.profileEvent?.tags ?? []).filter((t) => t[0] === 'i')
  if (idTags.length) {
    add({ id: 'nip39', chapter: 'identity', severity: 'medium', title: `Linked accounts: ${idTags.map((t) => t[1]).join(', ')}`, detail: 'NIP-39 external identity claims publicly bind this key to accounts on other platforms.' })
  }
  if (d.profileHistory.length) {
    const cur = JSON.stringify(p)
    const differing = d.profileHistory.filter((e) => e.content !== d.profileEvent?.content && e.content !== cur)
    if (differing.length) {
      const oldNames = new Set<string>()
      for (const e of differing) {
        try {
          const o = JSON.parse(e.content)
          if (o.name && o.name !== p.name) oldNames.add(o.name)
          if (o.display_name && o.display_name !== p.display_name) oldNames.add(o.display_name)
          if (o.lud16 && o.lud16 !== p.lud16) oldNames.add(o.lud16)
        } catch {
          /* ignore */
        }
      }
      add({
        id: 'stale-profile',
        chapter: 'identity',
        severity: oldNames.size ? 'medium' : 'low',
        title: `Older profile versions still served${oldNames.size ? `: ${[...oldNames].slice(0, 3).join(', ')}` : ''}`,
        detail: `${plural(differing.length, 'older kind-0 event')} (oldest ${fmtDate(Math.min(...differing.map((e) => e.created_at)))}) are still returned by some relays. Replaceable events are not replaced everywhere.`,
      })
    }
  }

  // --- time
  const tp = timeProfile([...d.activity, ...d.dmsSent])
  if (tp) {
    const sev: Severity = tp.confidence === 'high' ? 'high' : tp.confidence === 'medium' ? 'medium' : 'low'
    add({
      id: 'timezone',
      chapter: 'time',
      severity: sev,
      title: `Likely lives around ${formatOffset(tp.offset)}: ${tp.regions.slice(0, 3).join(', ') || 'unknown region'}`,
      detail: `Fitted a human daily rhythm to ${plural(tp.sample, 'timestamp')}. Quiet ${hh(tp.quietStart)}–${hh(tp.quietEnd)} local, most active ${hh(tp.peakStart)}–${hh(tp.peakEnd)}. Confidence: ${tp.confidence} (±1h; daylight saving and night-owl habits shift it). Nostr timestamps are exact to the second and never expire.`,
      fix: 'Schedule posts, or post from a client that jitters created_at. There is no way to rewrite the history already published.',
    })
  }
  const geo = geotags(d)
  if (geo.length) {
    const best = geo.reduce((a, b) => (b.errKm < a.errKm ? b : a))
    add({
      id: 'geohash',
      chapter: 'time',
      severity: best.errKm < 5 ? 'critical' : 'high',
      title: `Geotagged ${plural(geo.length, 'event')}: ≈${best.lat.toFixed(3)}, ${best.lon.toFixed(3)} (±${best.errKm} km)`,
      detail: 'Events carry NIP-52 style geohash "g" tags. Precise hashes resolve to a street or building.',
      fix: 'Delete geotagged events and disable location tagging in your client.',
      action: 'delete-leaky-notes',
    })
  }
  const cl = clients(d)
  if (cl.length) {
    add({ id: 'clients', chapter: 'time', severity: 'low', title: `Posts from ${cl.slice(0, 3).map((c) => c.name).join(', ')}`, detail: `Client tags on ${plural(cl.reduce((s, c) => s + c.count, 0), 'event')} fingerprint the apps (and so the devices/OS) in use.` })
  }

  // --- messages
  const contacts = dmContacts(d)
  const dmTotal = d.dmsSent.length + d.dmsRecv.length
  if (dmTotal) {
    const last = Math.max(...[...d.dmsSent, ...d.dmsRecv].map((e) => e.created_at))
    const recent = Date.now() / 1000 - last < 90 * 86400
    add({
      id: 'dm-metadata',
      chapter: 'messages',
      severity: recent && dmTotal > 20 ? 'critical' : 'high',
      title: `Private conversations with ${plural(contacts.length, 'person')} are publicly mapped`,
      detail: `${plural(dmTotal, 'NIP-04 direct message')} (${d.dmsSent.length} sent, ${d.dmsRecv.length} received, last ${fmtDate(last)}). Content is encrypted, but sender, recipient and exact time are plaintext on every relay that stores them.`,
      fix: 'Switch to NIP-17 (gift-wrapped) DMs, which hide sender and time, and request deletion of the old kind-4 events.',
      action: 'delete-dms',
    })
    const leakers = Object.keys(d.dmServedBy)
    if (leakers.length)
      add({
        id: 'dm-relays',
        chapter: 'relays',
        severity: 'medium',
        title: `${plural(leakers.length, 'relay')} hand DM metadata to anyone who asks`,
        detail: `${leakers.map((r) => r.replace('wss://', '')).join(', ')} answered an unauthenticated request for the subject's kind-4 events.`,
      })
  }
  const refusers = Object.keys(d.dmRefusedBy)
  if (refusers.length)
    add({ id: 'dm-auth', chapter: 'relays', severity: 'good', title: `${plural(refusers.length, 'relay')} refused to serve DMs without AUTH`, detail: `${refusers.map((r) => r.replace('wss://', '')).join(', ')} require NIP-42 authentication as author or recipient before returning DM events.` })
  if (d.dmRelays.length || d.giftWraps) {
    add({
      id: 'nip17',
      chapter: 'messages',
      severity: 'good',
      title: d.dmRelays.length ? `NIP-17 inbox configured (${d.dmRelays.length} relay${d.dmRelays.length === 1 ? '' : 's'})` : `Receives gift-wrapped DMs`,
      detail: `${plural(d.giftWraps, 'gift wrap')} addressed to this key were visible. Gift wraps reveal only the recipient and a randomised timestamp.`,
    })
  } else if (dmTotal) {
    add({ id: 'no-nip17', chapter: 'messages', severity: 'medium', title: 'No NIP-17 DM inbox published', detail: 'Without a kind-10050 relay list, contacts’ clients fall back to legacy kind-4 DMs.', fix: 'Publish a kind-10050 DM relay list.', action: 'dm-inbox' })
  }

  // --- money
  const z = zapSummary(d)
  if (z.inCount || z.outCount) {
    add({
      id: 'zaps',
      chapter: 'money',
      severity: z.inCount + z.outCount > 30 ? 'high' : 'medium',
      title: `Payment history: ${z.inSats.toLocaleString()} sats in, ${z.outSats.toLocaleString()} sats out`,
      detail: `${plural(z.inCount, 'zap')} received from ${plural(z.senders.length, 'identified sender')}${z.anonIn ? ` (${z.anonIn} anonymous)` : ''}, ${plural(z.outCount, 'zap')} sent to ${plural(z.recipients.length, 'recipient')}. Every receipt names payer, payee, amount and time, and embeds the bolt11 invoice.`,
      fix: 'Zap receipts are public by design. For payments you want private, pay invoices directly or send ecash inside a NIP-17 DM.',
    })
  }
  const L = d.lightning
  if (L.provider) {
    const custodial = L.provider.custodial === true
    add({
      id: 'ln-provider',
      chapter: 'money',
      severity: custodial ? 'medium' : 'low',
      title: `Receives money through ${L.provider.name}${custodial ? ' (custodial)' : ''}`,
      detail: `${L.address ?? L.domain}: ${L.provider.note}`,
    })
  }
  if (L.invoice) {
    const node = L.payeeNode
    if (node?.announced) {
      const clearnet = (node.sockets ?? []).filter((s) => !s.includes('.onion'))
      const who = nodeOperatorGuess(node.alias)
      add({
        id: 'ln-node',
        chapter: 'money',
        severity: clearnet.length && !who ? 'critical' : 'medium',
        title: `Invoices resolve to node "${node.alias ?? node.pubkey.slice(0, 12)}"${node.city || node.country ? ` in ${[node.city, node.country].filter(Boolean).join(', ')}` : ''}`,
        detail: `Payee ${node.pubkey.slice(0, 16)}… is a public node${who ? ` operated by ${who}` : ''} with ${node.channels ?? '?'} channels and ${((node.capacity ?? 0) / 1e8).toFixed(2)} BTC capacity${clearnet.length ? `, reachable at ${clearnet.join(', ')}${node.isp ? ` (${node.isp})` : ''}` : ''}.`,
        fix: who ? undefined : 'Run the node behind Tor only, and receive through an LSP or blinded paths so invoices don’t name your node.',
      })
    } else {
      add({
        id: 'ln-payee',
        chapter: 'money',
        severity: 'medium',
        title: `Every invoice is signed by the same private node ${L.invoice.payee.slice(0, 12)}…`,
        detail: 'The payee key is unannounced, but it is stable: it links every invoice this address issues, including ones pasted elsewhere, to one wallet.',
        fix: 'Wallets that support BOLT12 or blinded paths hide the final node key.',
      })
    }
    const resolved = L.funding.filter((x) => x.status === 'resolved')
    if (resolved.length) {
      const total = resolved.reduce((s, x) => s + (x.valueSats ?? 0), 0)
      add({
        id: 'ln-funding',
        chapter: 'money',
        severity: 'critical',
        title: `Route hints expose on-chain channel funding: ${(total / 1e8).toFixed(5)} BTC`,
        detail: `Short channel ID ${resolved.map((x) => x.scid).join(', ')} decodes to a real funding output (${resolved.map((x) => x.txid?.slice(0, 10) + '…:' + x.vout).join(', ')}). The inputs of that transaction are coins the subject’s wallet or its LSP controlled.`,
        fix: 'Use a wallet/LSP that issues scid aliases (option_scid_alias) in route hints.',
      })
    } else if (L.funding.length && L.funding.every((x) => x.status === 'alias')) {
      add({ id: 'ln-alias', chapter: 'money', severity: 'good', title: 'Route hints use scid aliases', detail: 'The short channel IDs in the invoice do not point to real on-chain outputs, so the channel funding transaction stays hidden.' })
    }
    if (L.invoice.blindedPaths) add({ id: 'ln-blinded', chapter: 'money', severity: 'good', title: 'Invoice uses blinded paths', detail: 'The final hops are encrypted, hiding the receiving node.' })
  }
  if (L.zapPayees.length) {
    const named = L.zapPayees.filter((x) => x.node?.alias).map((x) => `${x.node!.alias} (${x.count})`)
    const operators = new Set(L.zapPayees.map((x) => nodeOperatorGuess(x.node?.alias) ?? x.node?.alias).filter(Boolean))
    if (named.length)
      add({
        id: 'zap-nodes',
        chapter: 'money',
        severity: operators.size > 1 ? 'medium' : 'low',
        title: `Zaps landed at: ${named.slice(0, 3).join(', ')}`,
        detail: `Decoded from the bolt11 invoices inside zap receipts. ${operators.size > 1 ? `${operators.size} different operators: a custody history, with dates, that survives changing the lightning address.` : 'This reveals custody even if the lightning address changes later.'}`,
      })
  }
  const funded = d.onchain.filter((a) => (a.txCount ?? 0) > 0)
  if (d.onchain.length) {
    const recv = funded.reduce((s, a) => s + (a.receivedSats ?? 0), 0)
    add({
      id: 'onchain',
      chapter: 'money',
      severity: funded.length ? 'critical' : 'high',
      title: `Posted ${plural(d.onchain.length, 'bitcoin address', )} in public notes`,
      detail: funded.length
        ? `${plural(funded.length, 'address')} have on-chain history (${(recv / 1e8).toFixed(5)} BTC received in total). Every coin that touched them is now linked to this npub, and so is everything they were later merged with.`
        : 'None show history yet, but any future payment to them is linked to this npub.',
      fix: 'Delete the notes and never reuse the addresses. Use silent payments or a fresh address per payer.',
      action: 'delete-leaky-notes',
    })
  }
  if (d.invoicesInNotes.length) {
    const payees = new Set(d.invoicesInNotes.map((i) => i.payee))
    add({ id: 'invoices', chapter: 'money', severity: 'medium', title: `Pasted ${plural(d.invoicesInNotes.length, 'lightning invoice')} in notes`, detail: `They are signed by ${plural(payees.size, 'node key')}, which links those payments to this npub.` })
  }

  // --- social
  const ic = innerCircle(d)
  const privateTies = ic.filter((t) => t.dms > 0 && (t.zaps > 0 || t.replies > 2))
  if (privateTies.length) {
    add({ id: 'inner-circle', chapter: 'social', severity: 'high', title: `Inner circle of ${plural(privateTies.length, 'person')} identified`, detail: 'These contacts show up in both private channels (DMs) and public ones (zaps, replies). Cross-channel ties are how analysts rank who matters to a target.' })
  } else if (ic.length) {
    add({ id: 'ties', chapter: 'social', severity: 'low', title: `Closest public ties: ${ic.length}`, detail: 'Ranked from replies, zaps and follows.' })
  }
  if (d.muteListPublic.length)
    add({ id: 'mutes', chapter: 'social', severity: 'low', title: `Public mute list names ${plural(d.muteListPublic.length, 'account')}`, detail: 'Unencrypted entries in the kind-10000 mute list show who the subject is avoiding.', fix: 'Move mute entries into the encrypted part of the list.' })
  if (d.reports.length) add({ id: 'reports', chapter: 'social', severity: 'low', title: `Filed ${plural(d.reports.length, 'public report')}`, detail: 'NIP-56 reports (kind 1984) show who the subject flagged and why.' })

  // --- media
  const gps = d.media.filter((m) => m.status === 'gps')
  if (gps.length) {
    add({
      id: 'exif-gps',
      chapter: 'media',
      severity: 'critical',
      title: `${plural(gps.length, 'photo')} carry GPS coordinates`,
      detail: `e.g. ${gps[0].lat?.toFixed(5)}, ${gps[0].lon?.toFixed(5)}${gps[0].camera ? ` (${gps[0].camera})` : ''}. ${gps.some((g) => g.contentAddressed) ? 'Some are on content-addressed (Blossom-style) hosts, which cannot strip metadata without changing the file hash.' : ''}`,
      fix: 'Delete those notes, ask the host to remove the files, and strip EXIF before uploading.',
      action: 'delete-leaky-notes',
    })
  }
  const exifOnly = d.media.filter((m) => m.status === 'exif')
  if (exifOnly.length) add({ id: 'exif', chapter: 'media', severity: 'low', title: `${plural(exifOnly.length, 'photo')} carry camera metadata`, detail: `Device model and capture time survive in the file${exifOnly[0].camera ? ` (e.g. ${exifOnly[0].camera})` : ''}.` })
  const blocked = d.media.filter((m) => m.status === 'blocked').length
  if (d.media.length && !gps.length && blocked < d.media.length)
    add({ id: 'media-clean', chapter: 'media', severity: 'good', title: `No GPS found in ${plural(d.media.length - blocked, 'readable image')}`, detail: blocked ? `${blocked} could not be read from the browser (CORS).` : 'The images checked were stripped before upload.' })

  // --- relays
  const offenders = Object.entries(d.stillServed)
  if (offenders.length) {
    const n = new Set(offenders.flatMap(([, ids]) => ids)).size
    const hasRequest = (relay: string) => (d.deletionsSeenOn[relay] ?? 0) > 0
    const ignored = offenders.filter(([r]) => hasRequest(r))
    const missed = offenders.filter(([r]) => !hasRequest(r))
    add({
      id: 'deletion-ignored',
      chapter: 'relays',
      severity: 'high',
      title: `${plural(offenders.length, 'relay')} still serve ${plural(n, 'event')} the subject deleted`,
      detail: `${ignored.length ? `Ignored the deletion request they hold: ${ignored.map(([r, ids]) => `${r.replace('wss://', '')} (${ids.length})`).join(', ')}. ` : ''}${missed.length ? `Never received the request: ${missed.map(([r, ids]) => `${r.replace('wss://', '')} (${ids.length})`).join(', ')}.` : ''}`,
      fix: 'Rebroadcast your existing deletion requests to these relays (no new signature needed).',
      action: 'rebroadcast-deletions',
    })
  } else if (d.deletionTargets.length && d.deletionChecked.length) {
    add({ id: 'deletion-ok', chapter: 'relays', severity: 'good', title: `Deletions honoured on ${plural(d.deletionChecked.length, 'relay')}`, detail: `None of ${plural(d.deletionTargets.length, 'deleted event')} came back.` })
  }
  const writeRelays = [...d.relayList.write, ...d.relayList.both]
  if (writeRelays.length)
    add({ id: 'relay-list', chapter: 'relays', severity: 'info', title: `Publishes to ${plural(writeRelays.length, 'relay')}`, detail: `Each of ${writeRelays.map((r) => r.replace('wss://', '')).join(', ')} sees the subject’s IP address on every connection unless a proxy or Tor is used.` })

  return f
}

const WEIGHT: Record<Severity, number> = { critical: 22, high: 11, medium: 5, low: 1.5, info: 0, good: -3 }

export function exposureScore(fs: Finding[]): { score: number; grade: string; verdict: string } {
  const raw = fs.reduce((s, x) => s + WEIGHT[x.severity], 0)
  const score = Math.max(0, Math.min(100, Math.round(raw)))
  const grade = score <= 10 ? 'A' : score <= 25 ? 'B' : score <= 45 ? 'C' : score <= 70 ? 'D' : 'F'
  const verdict =
    grade === 'A' ? 'Thin file. Little to work with.' : grade === 'B' ? 'Some leads, nothing decisive.' : grade === 'C' ? 'Workable file. Several solid leads.' : grade === 'D' ? 'Rich file. Pattern of life and money trail established.' : 'Open book. An analyst can build a full profile.'
  return { score, grade, verdict }
}

export const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info', 'good']
