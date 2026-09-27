// Builds the dossier the way an outside analyst would: unauthenticated reads from public relays,
// the subject's own LNURL server, and a block explorer. Nothing is sent anywhere else.

import * as nip19 from 'nostr-tools/nip19'
import { RelayPool, normalizeRelay, type Filter, type NEvent, type RelayResult } from './relay'
import { investigateLightning, lookupNode } from './lightning'
import { findAddresses, findImages, findInvoices } from './scan'
import { scanImage } from './media'
import { decodeInvoice } from './bolt11'
import type { CoverageRow, Dossier, Nip05Info, Profile, QueryName, Settings, ZapRecord } from './types'

export const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://purplepag.es',
  'wss://nostr.wine',
  'wss://relay.snort.social',
  'wss://offchain.pub',
  'wss://nostr.mom',
  'wss://relay.nos.social',
  'wss://nostr.oxtr.dev',
  'wss://nostr21.com',
  'wss://nostr.bitcoiner.social',
  'wss://nostr-pub.wellorder.net',
  'wss://relay.nostr.net',
]

export const DEFAULT_SETTINGS: Settings = {
  relays: DEFAULT_RELAYS,
  mempool: 'https://mempool.space',
  probeInvoice: true,
  lookupChain: true,
  scanImages: true,
  nip05Lookup: true,
}

const ACTIVITY_KINDS = [1, 6, 7, 16, 20, 1111, 1068, 9802, 30023, 30311]
const MAX_RELAYS = 22

export async function resolveInput(input: string): Promise<string> {
  const s = input.trim().replace(/^nostr:/, '')
  if (/^[0-9a-f]{64}$/i.test(s)) return s.toLowerCase()
  if (/^(npub|nprofile)1/.test(s)) {
    const d = nip19.decode(s)
    if (d.type === 'npub') return d.data
    if (d.type === 'nprofile') return d.data.pubkey
  }
  if (/^[^@\s]*@?[^@\s]+\.[^@\s]+$/.test(s)) {
    const [name, domain] = s.includes('@') ? s.split('@') : ['_', s]
    const r = await fetch(`https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name || '_')}`, { referrerPolicy: 'no-referrer' })
    const j = (await r.json()) as { names?: Record<string, string> }
    const pk = j.names?.[name || '_']
    if (pk && /^[0-9a-f]{64}$/i.test(pk)) return pk.toLowerCase()
    throw new Error(`${s} does not resolve to a pubkey`)
  }
  throw new Error('Paste an npub, nprofile, hex pubkey or NIP-05 address')
}

function emptyDossier(input: string, pubkey: string, relays: string[]): Dossier {
  return {
    input,
    pubkey,
    npub: nip19.npubEncode(pubkey),
    startedAt: Date.now(),
    stage: 'Opening file',
    relays,
    coverage: relays.map((relay) => ({ relay, reachable: false, counts: {}, refused: {} })),
    profileHistory: [],
    relayList: { read: [], write: [], both: [] },
    dmRelays: [],
    follows: [],
    muteListPublic: [],
    activity: [],
    dmsSent: [],
    dmsRecv: [],
    dmServedBy: {},
    dmRefusedBy: {},
    giftWraps: 0,
    zapsIn: [],
    zapsOut: [],
    deletions: [],
    deletionTargets: [],
    stillServed: {},
    deletionChecked: [],
    deletionsSeenOn: {},
    reports: [],
    names: {},
    lightning: { hintNodes: [], funding: [], zapPayees: [] },
    onchain: [],
    invoicesInNotes: [],
    media: [],
    log: [],
    errors: [],
  }
}

export function parseZap(ev: NEvent): ZapRecord | undefined {
  const tag = (n: string) => ev.tags.find((t) => t[0] === n)?.[1]
  const recipient = tag('p')
  if (!recipient) return undefined
  let request: NEvent | undefined
  try {
    request = JSON.parse(tag('description') ?? '')
  } catch {
    /* malformed */
  }
  const bolt11 = tag('bolt11')
  let sats = 0
  let payee: string | undefined
  if (bolt11) {
    try {
      const inv = decodeInvoice(bolt11)
      sats = Math.floor((inv.amountMsat ?? 0) / 1000)
      payee = inv.payee
    } catch {
      /* ignore */
    }
  }
  if (!sats && request) {
    const amt = request.tags?.find((t) => t[0] === 'amount')?.[1]
    if (amt) sats = Math.floor(Number(amt) / 1000)
  }
  const anon = !!request?.tags?.some((t) => t[0] === 'anon')
  return {
    id: ev.id,
    receiptAuthor: ev.pubkey,
    sender: anon ? undefined : (request?.pubkey ?? tag('P')),
    recipient,
    anon,
    sats,
    at: ev.created_at,
    message: typeof request?.content === 'string' ? request.content : '',
    noteId: tag('e'),
    payee,
    bolt11,
  }
}

function tally(d: Dossier, name: QueryName, results: RelayResult[]) {
  for (const r of results) {
    const row = d.coverage.find((c) => c.relay === r.relay) as CoverageRow | undefined
    if (!row) continue
    if (!r.error || r.events.length) row.reachable = true
    if (r.error && !row.reachable) row.error = r.error
    row.counts[name] = (row.counts[name] ?? 0) + r.events.length
    if (r.closed) row.refused[name] = r.closed
  }
}

function dedupe(results: RelayResult[]): { events: NEvent[]; seenOn: Map<string, Set<string>> } {
  const byId = new Map<string, NEvent>()
  const seenOn = new Map<string, Set<string>>()
  for (const r of results)
    for (const ev of r.events) {
      byId.set(ev.id, ev)
      if (!seenOn.has(ev.id)) seenOn.set(ev.id, new Set())
      seenOn.get(ev.id)!.add(r.relay)
    }
  return { events: [...byId.values()].sort((a, b) => b.created_at - a.created_at), seenOn }
}

export async function collect(
  input: string,
  settings: Settings,
  onUpdate: (d: Dossier) => void,
  signal?: AbortSignal,
): Promise<Dossier> {
  const pubkey = await resolveInput(input)
  const bootstrap = [...new Set(settings.relays.map(normalizeRelay).filter(Boolean))]
  const d = emptyDossier(input, pubkey, bootstrap)
  const pool = new RelayPool()
  const log = (text: string, tone?: 'ok' | 'warn' | 'bad') => {
    d.log.push({ at: Date.now(), text, tone })
    emit()
  }
  const emit = () => onUpdate({ ...d, log: [...d.log] })
  const stage = (s: string) => {
    d.stage = s
    log(s)
  }
  const aborted = () => signal?.aborted
  const each = (urls: string[], filter: Filter, pages = 1) =>
    Promise.all(urls.map((u) => (pages > 1 ? pool.get(u).queryPaged(filter, { pages, pageSize: filter.limit ?? 500 }) : pool.get(u).query([filter]))))

  try {
    stage(`Querying ${bootstrap.length} relays for profile and relay lists`)
    const metaRes = await each(bootstrap, { authors: [pubkey], kinds: [0, 3, 10000, 10002, 10050], limit: 60 })
    tally(d, 'meta', metaRes)
    const meta = dedupe(metaRes).events
    const kind0 = meta.filter((e) => e.kind === 0)
    d.profileEvent = kind0[0]
    d.profileHistory = kind0.slice(1)
    try {
      d.profile = d.profileEvent ? (JSON.parse(d.profileEvent.content) as Profile) : undefined
    } catch {
      d.profile = undefined
    }
    const rl = meta.find((e) => e.kind === 10002)
    if (rl) {
      d.relayListEvent = rl
      for (const t of rl.tags) {
        if (t[0] !== 'r') continue
        const url = normalizeRelay(t[1] ?? '')
        if (!url) continue
        if (t[2] === 'read') d.relayList.read.push(url)
        else if (t[2] === 'write') d.relayList.write.push(url)
        else d.relayList.both.push(url)
      }
    }
    const dmList = meta.find((e) => e.kind === 10050)
    d.dmRelays = dmList ? dmList.tags.filter((t) => t[0] === 'relay').map((t) => normalizeRelay(t[1] ?? '')).filter(Boolean) : []
    const follows = meta.find((e) => e.kind === 3)
    d.follows = follows ? follows.tags.filter((t) => t[0] === 'p').map((t) => t[1]) : []
    const mutes = meta.find((e) => e.kind === 10000)
    d.muteListPublic = mutes ? mutes.tags.filter((t) => t[0] === 'p').map((t) => t[1]) : []
    const reach = d.coverage.filter((c) => c.reachable).length
    log(`${reach}/${bootstrap.length} relays reachable · profile ${d.profile ? 'found' : 'not found'}`, reach ? 'ok' : 'bad')
    emit()
    if (aborted()) return d

    const subjectRelays = [...d.relayList.write, ...d.relayList.both, ...d.relayList.read, ...d.dmRelays]
    const all = [...new Set([...bootstrap, ...subjectRelays])].slice(0, MAX_RELAYS)
    for (const r of all) if (!d.coverage.some((c) => c.relay === r)) d.coverage.push({ relay: r, reachable: false, counts: {}, refused: {} })
    d.relays = all

    stage(`Pulling public history from ${all.length} relays`)
    const [activityRes, sentRes, recvRes, wrapRes, zinRes, zoutRes, delRes, repRes] = await Promise.all([
      each(all, { authors: [pubkey], kinds: ACTIVITY_KINDS, limit: 500 }, 2),
      each(all, { authors: [pubkey], kinds: [4], limit: 500 }),
      each(all, { '#p': [pubkey], kinds: [4], limit: 500 }),
      each(all, { '#p': [pubkey], kinds: [1059], limit: 300 }),
      each(all, { '#p': [pubkey], kinds: [9735], limit: 500 }),
      each(all, { '#P': [pubkey], kinds: [9735], limit: 500 }),
      each(all, { authors: [pubkey], kinds: [5], limit: 500 }),
      each(all, { authors: [pubkey], kinds: [1984], limit: 100 }),
    ])
    tally(d, 'activity', activityRes)
    tally(d, 'dmsSent', sentRes)
    tally(d, 'dmsRecv', recvRes)
    tally(d, 'giftWraps', wrapRes)
    tally(d, 'zapsIn', zinRes)
    tally(d, 'zapsOut', zoutRes)
    tally(d, 'deletions', delRes)
    tally(d, 'reports', repRes)

    d.activity = dedupe(activityRes).events.filter((e) => e.pubkey === pubkey)
    d.dmsSent = dedupe(sentRes).events.filter((e) => e.pubkey === pubkey)
    d.dmsRecv = dedupe(recvRes).events.filter((e) => e.tags.some((t) => t[0] === 'p' && t[1] === pubkey))
    for (const r of [...sentRes, ...recvRes]) {
      if (r.events.length) d.dmServedBy[r.relay] = (d.dmServedBy[r.relay] ?? 0) + r.events.length
      if (r.closed) d.dmRefusedBy[r.relay] = r.closed
    }
    d.giftWraps = dedupe(wrapRes).events.length
    d.zapsIn = dedupe(zinRes).events.map(parseZap).filter((z): z is ZapRecord => !!z && z.recipient === pubkey)
    d.zapsOut = dedupe(zoutRes)
      .events.map(parseZap)
      .filter((z): z is ZapRecord => !!z && z.sender === pubkey)
    d.deletions = dedupe(delRes).events.filter((e) => e.pubkey === pubkey)
    for (const r of delRes) if (r.events.length) d.deletionsSeenOn[r.relay] = r.events.filter((e) => e.pubkey === pubkey).length
    d.reports = dedupe(repRes).events
    log(
      `${d.activity.length} public events · ${d.dmsSent.length + d.dmsRecv.length} NIP-04 DMs · ${d.zapsIn.length + d.zapsOut.length} zap receipts`,
      'ok',
    )
    emit()
    if (aborted()) return d

    // Deletion compliance: ask each relay, one by one, for events the subject asked to delete.
    const targets = [...new Set(d.deletions.flatMap((e) => e.tags.filter((t) => t[0] === 'e').map((t) => t[1])))].slice(0, 250)
    d.deletionTargets = targets
    if (targets.length) {
      stage(`Checking whether ${all.length} relays honoured ${targets.length} deletion requests`)
      const reachable = d.coverage.filter((c) => c.reachable).map((c) => c.relay)
      const res = await each(reachable, { ids: targets, limit: targets.length })
      d.deletionChecked = res.filter((r) => !r.error).map((r) => r.relay)
      for (const r of res) {
        const ids = r.events.filter((e) => e.pubkey === pubkey).map((e) => e.id)
        if (ids.length) d.stillServed[r.relay] = ids
      }
      const offenders = Object.keys(d.stillServed).length
      log(`${offenders} relay${offenders === 1 ? '' : 's'} still serve deleted events`, offenders ? 'bad' : 'ok')
      emit()
    }

    // Names for counterparties (for the subject's own eyes; the UI redacts them otherwise)
    const counterparties = new Map<string, number>()
    const bump = (pk?: string, w = 1) => pk && pk !== pubkey && counterparties.set(pk, (counterparties.get(pk) ?? 0) + w)
    d.dmsSent.forEach((e) => bump(e.tags.find((t) => t[0] === 'p')?.[1], 3))
    d.dmsRecv.forEach((e) => bump(e.pubkey, 3))
    d.zapsIn.forEach((z) => bump(z.sender, 2))
    d.zapsOut.forEach((z) => bump(z.recipient, 2))
    d.activity.forEach((e) => e.kind === 1 && e.tags.forEach((t) => t[0] === 'p' && bump(t[1])))
    const top = [...counterparties.entries()].sort((a, b) => b[1] - a[1]).slice(0, 80).map(([pk]) => pk)
    if (top.length) {
      const nameRes = await each(['wss://purplepag.es', 'wss://relay.primal.net', 'wss://relay.damus.io'], { authors: top, kinds: [0], limit: top.length })
      for (const ev of dedupe(nameRes).events) {
        if (d.names[ev.pubkey]) continue
        try {
          const p = JSON.parse(ev.content) as Profile
          d.names[ev.pubkey] = { name: (p.display_name as string) || (p.name as string) || undefined, nip05: p.nip05 }
        } catch {
          /* ignore */
        }
      }
    }
    if (aborted()) return d

    // Content scans
    d.onchain = findAddresses([...d.activity, ...(d.profileEvent ? [d.profileEvent] : [])]).map((a) => ({ ...a }))
    d.invoicesInNotes = findInvoices(d.activity)

    stage('Following the money: lightning address, invoice, node, channels')
    d.lightning = await investigateLightning(
      { lud16: d.profile?.lud16, lud06: d.profile?.lud06, mempool: settings.mempool, probeInvoice: settings.probeInvoice, lookupChain: settings.lookupChain },
      log,
    )
    // Which nodes actually received the subject's zaps
    const payees = new Map<string, number>()
    for (const z of d.zapsIn) if (z.payee) payees.set(z.payee, (payees.get(z.payee) ?? 0) + 1)
    d.lightning.zapPayees = [...payees.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([pubkey, count]) => ({ pubkey, count }))
    if (settings.lookupChain) {
      await Promise.all(
        d.lightning.zapPayees.map(async (p) => {
          p.node = await lookupNode(settings.mempool, p.pubkey)
        }),
      )
    }
    emit()

    if (settings.lookupChain && d.onchain.length) {
      stage(`Looking up ${Math.min(d.onchain.length, 12)} bitcoin addresses posted in notes`)
      await Promise.all(
        d.onchain.slice(0, 12).map(async (a) => {
          try {
            const r = await fetch(`${settings.mempool}/api/address/${a.address}`, { referrerPolicy: 'no-referrer' })
            const j = (await r.json()) as { chain_stats: { tx_count: number; funded_txo_sum: number; spent_txo_sum: number }; mempool_stats: { tx_count: number } }
            a.txCount = j.chain_stats.tx_count + j.mempool_stats.tx_count
            a.receivedSats = j.chain_stats.funded_txo_sum
            a.balanceSats = j.chain_stats.funded_txo_sum - j.chain_stats.spent_txo_sum
          } catch (e) {
            a.error = String(e)
          }
        }),
      )
      emit()
    }

    if (settings.nip05Lookup && d.profile?.nip05) d.nip05 = await inspectNip05(d.profile.nip05, pubkey)
    emit()

    if (settings.scanImages) {
      const imgs = findImages(d.activity, 24)
      if (imgs.length) {
        stage(`Reading EXIF headers of ${imgs.length} images`)
        d.media = await Promise.all(imgs.map(scanImage))
        const gps = d.media.filter((m) => m.status === 'gps').length
        log(`${gps} image${gps === 1 ? '' : 's'} carry GPS coordinates`, gps ? 'bad' : 'ok')
      }
    }

    d.stage = 'File complete'
    d.finishedAt = Date.now()
    log(`File complete in ${((d.finishedAt - d.startedAt) / 1000).toFixed(1)}s`, 'ok')
    return d
  } catch (e) {
    d.errors.push(e instanceof Error ? e.message : String(e))
    d.stage = 'Stopped with errors'
    log(String(e), 'bad')
    return d
  } finally {
    pool.closeAll()
    emit()
  }
}

async function inspectNip05(identifier: string, pubkey: string): Promise<Nip05Info> {
  const [nameRaw, domainRaw] = identifier.includes('@') ? identifier.split('@') : ['_', identifier]
  const name = (nameRaw || '_').toLowerCase()
  const domain = (domainRaw ?? '').toLowerCase()
  const info: Nip05Info = { identifier, domain }
  const get = async (url: string) => {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 6000)
    try {
      const r = await fetch(url, { signal: ctl.signal, referrerPolicy: 'no-referrer', credentials: 'omit' })
      return (await r.json()) as { names?: Record<string, string>; relays?: Record<string, string[]> }
    } finally {
      clearTimeout(t)
    }
  }
  try {
    const one = await get(`https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`)
    info.verified = one.names?.[name]?.toLowerCase() === pubkey
    info.relaysListed = one.relays?.[pubkey]
  } catch (e) {
    info.error = String(e)
    return info
  }
  try {
    const full = await get(`https://${domain}/.well-known/nostr.json`)
    const names = Object.entries(full.names ?? {})
    if (names.length > 1) {
      info.listExposed = true
      info.namesOnDomain = names.length
      info.pubkeysOnDomain = new Set(names.map(([, pk]) => pk)).size
      info.coResidents = names.filter(([, pk]) => pk !== pubkey).slice(0, 12).map(([n, pk]) => ({ name: n, pubkey: pk }))
    } else {
      info.listExposed = false
    }
  } catch {
    info.listExposed = false
  }
  return info
}
