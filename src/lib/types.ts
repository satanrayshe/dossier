import type { NEvent, RelayResult } from './relay'
import type { DecodedInvoice } from './bolt11'

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'good' | 'info'

export type Chapter = 'identity' | 'time' | 'messages' | 'money' | 'social' | 'media' | 'relays'

export interface Finding {
  id: string
  chapter: Chapter
  severity: Severity
  /** The analyst's conclusion, phrased as they would write it in the file. */
  title: string
  detail: string
  fix?: string
  action?: ActionId
}

export type ActionId = 'delete-dms' | 'dm-inbox' | 'rebroadcast-deletions' | 'scrub-profile' | 'delete-leaky-notes'

export interface Profile {
  name?: string
  display_name?: string
  about?: string
  picture?: string
  banner?: string
  website?: string
  nip05?: string
  lud16?: string
  lud06?: string
  [k: string]: unknown
}

export interface Settings {
  relays: string[]
  mempool: string
  probeInvoice: boolean
  lookupChain: boolean
  scanImages: boolean
  nip05Lookup: boolean
}

export interface CoverageRow {
  relay: string
  reachable: boolean
  error?: string
  counts: Partial<Record<QueryName, number>>
  refused: Partial<Record<QueryName, string>>
}

export type QueryName =
  | 'meta'
  | 'activity'
  | 'dmsSent'
  | 'dmsRecv'
  | 'giftWraps'
  | 'zapsIn'
  | 'zapsOut'
  | 'deletions'
  | 'reports'

export interface ZapRecord {
  id: string
  receiptAuthor: string
  sender?: string
  recipient: string
  anon: boolean
  sats: number
  at: number
  message: string
  noteId?: string
  payee?: string
  bolt11?: string
}

export interface LnNode {
  pubkey: string
  alias?: string
  sockets?: string[]
  city?: string
  country?: string
  isp?: string
  capacity?: number
  channels?: number
  firstSeen?: number
  announced: boolean
}

export interface FundingLink {
  scid: string
  hintNode: string
  status: 'alias' | 'resolved' | 'not-found' | 'skipped'
  txid?: string
  vout?: number
  valueSats?: number
  scriptType?: string
  spent?: boolean
  inputs?: { address?: string; valueSats: number }[]
}

export interface LightningInfo {
  address?: string
  domain?: string
  provider?: { name: string; custodial: boolean | 'unknown'; note: string }
  lnurl?: { callback: string; nostrPubkey?: string; allowsNostr?: boolean; minSendable?: number; commentAllowed?: number }
  lnurlError?: string
  invoice?: DecodedInvoice
  invoiceError?: string
  payeeNode?: LnNode
  hintNodes: LnNode[]
  funding: FundingLink[]
  zapPayees: { pubkey: string; count: number; node?: LnNode }[]
}

export interface OnchainLink {
  address: string
  noteId: string
  at: number
  txCount?: number
  receivedSats?: number
  balanceSats?: number
  error?: string
}

export interface InvoiceInNote {
  noteId: string
  at: number
  payee: string
  amountSats: number
}

export interface MediaFinding {
  url: string
  noteId: string
  at: number
  host: string
  contentAddressed: boolean
  status: 'gps' | 'exif' | 'clean' | 'blocked' | 'error'
  lat?: number
  lon?: number
  camera?: string
  taken?: string
}

export interface Nip05Info {
  identifier: string
  domain: string
  verified?: boolean
  namesOnDomain?: number
  pubkeysOnDomain?: number
  coResidents?: { name: string; pubkey: string }[]
  listExposed?: boolean
  relaysListed?: string[]
  error?: string
}

export interface Dossier {
  input: string
  pubkey: string
  npub: string
  startedAt: number
  finishedAt?: number
  stage: string
  relays: string[]
  coverage: CoverageRow[]
  profileEvent?: NEvent
  profile?: Profile
  profileHistory: NEvent[]
  relayList: { read: string[]; write: string[]; both: string[] }
  relayListEvent?: NEvent
  dmRelays: string[]
  follows: string[]
  muteListPublic: string[]
  activity: NEvent[]
  dmsSent: NEvent[]
  dmsRecv: NEvent[]
  dmServedBy: Record<string, number>
  dmRefusedBy: Record<string, string>
  giftWraps: number
  zapsIn: ZapRecord[]
  zapsOut: ZapRecord[]
  deletions: NEvent[]
  deletionTargets: string[]
  stillServed: Record<string, string[]>
  deletionChecked: string[]
  /** how many of the subject's kind-5 events each relay returned */
  deletionsSeenOn: Record<string, number>
  reports: NEvent[]
  names: Record<string, { name?: string; nip05?: string }>
  lightning: LightningInfo
  onchain: OnchainLink[]
  invoicesInNotes: InvoiceInNote[]
  media: MediaFinding[]
  nip05?: Nip05Info
  log: { at: number; text: string; tone?: 'ok' | 'warn' | 'bad' }[]
  errors: string[]
}

export type RelayResults = Record<QueryName, RelayResult[]>
