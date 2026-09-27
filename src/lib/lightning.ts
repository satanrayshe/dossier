// Nostr -> Lightning -> Bitcoin. Follows the subject's lightning address the way a payer's
// wallet would, then asks what the invoice gives away about the node behind it.

import { bech32 } from '@scure/base'
import { decodeInvoice } from './bolt11'
import type { FundingLink, LightningInfo, LnNode } from './types'

interface ProviderInfo {
  name: string
  custodial: boolean | 'unknown'
  note: string
}

const PROVIDERS: [RegExp, ProviderInfo][] = [
  [/walletofsatoshi\.com$/, { name: 'Wallet of Satoshi', custodial: true, note: 'Custodial. The operator can see every payment you receive and could freeze or be compelled to report it.' }],
  [/getalby\.com$/, { name: 'Alby', custodial: 'unknown', note: 'Alby lightning address. Legacy Alby accounts are custodial; Alby Hub users forward to their own node.' }],
  [/primal\.net$/, { name: 'Primal Wallet', custodial: true, note: 'Custodial wallet run by Primal. Every zap you receive is visible to the operator.' }],
  [/coinos\.io$/, { name: 'Coinos', custodial: true, note: 'Custodial web wallet.' }],
  [/strike\.me$/, { name: 'Strike', custodial: true, note: 'Custodial and KYC-linked: your npub is tied to a verified legal identity at Strike.' }],
  [/blink\.sv$/, { name: 'Blink', custodial: true, note: 'Custodial wallet (formerly Bitcoin Beach).' }],
  [/minibits\.cash$/, { name: 'Minibits', custodial: true, note: 'Cashu ecash mint. The mint sees incoming lightning payments before they become blinded ecash.' }],
  [/npub\.cash$/, { name: 'npub.cash', custodial: true, note: 'Cashu-based address. The mint holds funds until claimed and sees every incoming payment.' }],
  [/zeuspay\.com$/, { name: 'ZEUS Pay', custodial: 'unknown', note: 'Payments are held by the ZEUS service until your wallet comes online to claim them.' }],
  [/stacker\.news$/, { name: 'Stacker News', custodial: true, note: 'Custodial balance at Stacker News.' }],
  [/fountain\.fm$/, { name: 'Fountain', custodial: true, note: 'Custodial wallet inside the Fountain podcast app.' }],
  [/rizful\.com$/, { name: 'Rizful', custodial: true, note: 'Custodial lightning address.' }],
  [/sats\.mobi$/, { name: 'sats.mobi', custodial: true, note: 'Custodial Telegram wallet.' }],
  [/nostrcheck\.me$/, { name: 'nostrcheck.me', custodial: 'unknown', note: 'Lightning address forwarding service.' }],
  [/cake\.cash|cakewallet/, { name: 'Cake Wallet', custodial: false, note: 'Self-custodial wallet.' }],
]

const NODE_HINTS: [RegExp, string][] = [
  [/walletofsatoshi/i, 'Wallet of Satoshi'],
  [/alby/i, 'Alby'],
  [/primal/i, 'Primal'],
  [/minibits/i, 'Minibits mint'],
  [/coinos/i, 'Coinos'],
  [/strike/i, 'Strike'],
  [/blink|galoy/i, 'Blink'],
  [/acinq/i, 'ACINQ (Phoenix LSP)'],
  [/breez/i, 'Breez'],
  [/voltage/i, 'Voltage (hosted node)'],
  [/megalith/i, 'Megalith LSP'],
  [/lnbits/i, 'LNbits'],
  [/fountain/i, 'Fountain'],
  [/zeus/i, 'ZEUS / Olympus LSP'],
  [/muun/i, 'Muun'],
  [/river/i, 'River'],
  [/kraken/i, 'Kraken'],
  [/binance/i, 'Binance'],
  [/bitfinex/i, 'Bitfinex'],
  [/cashu|mint/i, 'Cashu mint'],
]

export function providerForDomain(domain: string): ProviderInfo {
  for (const [re, info] of PROVIDERS) if (re.test(domain)) return info
  return { name: domain, custodial: 'unknown', note: 'Unrecognised provider. It could be a self-hosted LNbits/LNURL server or a smaller custodian.' }
}

export function nodeOperatorGuess(alias?: string): string | undefined {
  if (!alias) return undefined
  for (const [re, label] of NODE_HINTS) if (re.test(alias)) return label
  return undefined
}

export function lnurlFromProfile(lud16?: string, lud06?: string): { url: string; address?: string; domain: string } | undefined {
  if (lud16 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(lud16.trim())) {
    const [name, domain] = lud16.trim().toLowerCase().split('@')
    return { url: `https://${domain}/.well-known/lnurlp/${name}`, address: lud16.trim(), domain }
  }
  if (lud06 && /^lnurl1/i.test(lud06.trim())) {
    try {
      const { words } = bech32.decode(lud06.trim().toLowerCase() as `lnurl1${string}`, false)
      const url = new TextDecoder().decode(bech32.fromWords(words))
      return { url, domain: new URL(url).hostname }
    } catch {
      return undefined
    }
  }
  return undefined
}

async function getJson<T>(url: string, timeoutMs = 8000): Promise<T> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const r = await fetch(url, { signal: ctl.signal, referrerPolicy: 'no-referrer', credentials: 'omit' })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return (await r.json()) as T
  } finally {
    clearTimeout(t)
  }
}

async function getText(url: string, timeoutMs = 8000): Promise<string> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const r = await fetch(url, { signal: ctl.signal, referrerPolicy: 'no-referrer', credentials: 'omit' })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return await r.text()
  } finally {
    clearTimeout(t)
  }
}

interface MempoolNode {
  public_key: string
  alias?: string
  sockets?: string
  city?: { en?: string } | null
  country?: { en?: string } | null
  as_organization?: string
  capacity?: number
  active_channel_count?: number
  first_seen?: number
}

const nodeCache = new Map<string, Promise<LnNode>>()

export function lookupNode(mempool: string, pubkey: string): Promise<LnNode> {
  const key = `${mempool}|${pubkey}`
  let p = nodeCache.get(key)
  if (!p) {
    p = getJson<MempoolNode>(`${mempool}/api/v1/lightning/nodes/${pubkey}`)
      .then((n) => ({
        pubkey,
        alias: n.alias,
        sockets: n.sockets ? n.sockets.split(',').filter(Boolean) : [],
        city: n.city?.en,
        country: n.country?.en,
        isp: n.as_organization,
        capacity: n.capacity,
        channels: n.active_channel_count,
        firstSeen: n.first_seen,
        announced: true,
      }))
      .catch(() => ({ pubkey, announced: false }))
    nodeCache.set(key, p)
  }
  return p
}

interface MempoolTx {
  txid: string
  vin: { prevout?: { scriptpubkey_address?: string; value: number } }[]
  vout: { scriptpubkey_type: string; value: number }[]
}

export async function resolveScid(mempool: string, scid: { scid: string; block: number; txIndex: number; output: number }, hintNode: string, tip?: number): Promise<FundingLink> {
  const base: FundingLink = { scid: scid.scid, hintNode, status: 'alias' }
  // Block 0 or a height in the future can't be a real funding location: it's an scid alias,
  // which is exactly the protection option_scid_alias is meant to provide.
  if (scid.block < 150_000 || (tip && scid.block > tip)) return base
  try {
    const hash = await getText(`${mempool}/api/block-height/${scid.block}`)
    const txid = await getText(`${mempool}/api/block/${hash.trim()}/txid/${scid.txIndex}`)
    const tx = await getJson<MempoolTx>(`${mempool}/api/tx/${txid.trim()}`)
    const out = tx.vout[scid.output]
    if (!out || !['v0_p2wsh', 'v1_p2tr'].includes(out.scriptpubkey_type)) return { ...base, status: 'not-found' }
    let spent: boolean | undefined
    try {
      const os = await getJson<{ spent: boolean }>(`${mempool}/api/tx/${tx.txid}/outspend/${scid.output}`)
      spent = os.spent
    } catch {
      /* optional */
    }
    return {
      ...base,
      status: 'resolved',
      txid: tx.txid,
      vout: scid.output,
      valueSats: out.value,
      scriptType: out.scriptpubkey_type,
      spent,
      inputs: tx.vin.map((v) => ({ address: v.prevout?.scriptpubkey_address, valueSats: v.prevout?.value ?? 0 })),
    }
  } catch {
    return { ...base, status: 'not-found' }
  }
}

export async function chainTip(mempool: string): Promise<number | undefined> {
  try {
    return Number(await getText(`${mempool}/api/blocks/tip/height`, 5000))
  } catch {
    return undefined
  }
}

export async function investigateLightning(
  opts: { lud16?: string; lud06?: string; mempool: string; probeInvoice: boolean; lookupChain: boolean },
  log: (text: string, tone?: 'ok' | 'warn' | 'bad') => void,
): Promise<LightningInfo> {
  const info: LightningInfo = { hintNodes: [], funding: [], zapPayees: [] }
  const target = lnurlFromProfile(opts.lud16, opts.lud06)
  if (!target) {
    log('No lightning address in the profile')
    return info
  }
  info.address = target.address
  info.domain = target.domain
  info.provider = providerForDomain(target.domain)
  try {
    const j = await getJson<{ callback: string; nostrPubkey?: string; allowsNostr?: boolean; minSendable?: number; commentAllowed?: number; status?: string; reason?: string }>(target.url)
    if (j.status === 'ERROR') throw new Error(j.reason ?? 'LNURL error')
    info.lnurl = { callback: j.callback, nostrPubkey: j.nostrPubkey, allowsNostr: j.allowsNostr, minSendable: j.minSendable, commentAllowed: j.commentAllowed }
    log(`LNURL ${target.domain} answered`, 'ok')
  } catch (e) {
    info.lnurlError = e instanceof Error ? e.message : String(e)
    log(`LNURL ${target.domain} unreachable (${info.lnurlError})`, 'warn')
    return info
  }
  if (!opts.probeInvoice) return info
  try {
    const cb = new URL(info.lnurl.callback)
    cb.searchParams.set('amount', String(Math.max(info.lnurl.minSendable ?? 1000, 1000)))
    const r = await getJson<{ pr?: string; reason?: string }>(cb.toString())
    if (!r.pr) throw new Error(r.reason ?? 'no invoice returned')
    info.invoice = decodeInvoice(r.pr)
    log(`Invoice decoded: payee node ${info.invoice.payee.slice(0, 12)}…`, 'ok')
  } catch (e) {
    info.invoiceError = e instanceof Error ? e.message : String(e)
    log(`Could not obtain an invoice (${info.invoiceError})`, 'warn')
    return info
  }
  if (!opts.lookupChain) return info
  info.payeeNode = await lookupNode(opts.mempool, info.invoice.payee)
  const hops = info.invoice.routeHints.flat()
  info.hintNodes = await Promise.all([...new Set(hops.map((h) => h.pubkey))].map((pk) => lookupNode(opts.mempool, pk)))
  const tip = await chainTip(opts.mempool)
  info.funding = await Promise.all(hops.map((h) => resolveScid(opts.mempool, h, h.pubkey, tip)))
  return info
}
