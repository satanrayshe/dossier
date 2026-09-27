// BOLT-11 decoder that also recovers the payee node id from the invoice signature.
// Off-the-shelf light decoders skip signature recovery, but the payee key is exactly
// the thing an analyst wants: it is stable across every invoice a node issues.

import { bech32 } from '@scure/base'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'

export interface RouteHop {
  pubkey: string
  scid: string
  block: number
  txIndex: number
  output: number
  feeBaseMsat: number
  feePpm: number
  cltvDelta: number
}

export interface DecodedInvoice {
  network: string
  amountMsat?: number
  timestamp: number
  paymentHash?: string
  paymentSecret?: string
  description?: string
  descriptionHash?: string
  expiry: number
  payee: string
  payeeFromTag: boolean
  routeHints: RouteHop[][]
  featureBits: number[]
  blindedPaths: number
}

// msat per unit of each hrp multiplier (1 BTC = 1e11 msat); pico is handled separately (0.1 msat)
const MSAT_PER_UNIT: Record<string, bigint> = { m: 100_000_000n, u: 100_000n, n: 100n }

function wordsToBytesPadded(words: number[]): Uint8Array {
  let acc = 0
  let bits = 0
  const out: number[] = []
  for (const w of words) {
    acc = (acc << 5) | w
    bits += 5
    while (bits >= 8) {
      bits -= 8
      out.push((acc >> bits) & 0xff)
    }
    acc &= (1 << bits) - 1
  }
  if (bits > 0) out.push((acc << (8 - bits)) & 0xff)
  return new Uint8Array(out)
}

function wordsToInt(words: number[]): number {
  return words.reduce((n, w) => n * 32 + w, 0)
}

function readU(bytes: Uint8Array, off: number, len: number): number {
  let n = 0
  for (let i = 0; i < len; i++) n = n * 256 + bytes[off + i]
  return n
}

export function decodeScid(bytes: Uint8Array, off = 0) {
  const block = readU(bytes, off, 3)
  const txIndex = readU(bytes, off + 3, 3)
  const output = readU(bytes, off + 6, 2)
  return { block, txIndex, output, scid: `${block}x${txIndex}x${output}` }
}

function parseAmount(hrp: string): { network: string; amountMsat?: number } {
  const m = /^ln(bcrt|bc|tbs|tb|sb)(\d+)?([munp])?$/.exec(hrp)
  if (!m) throw new Error('not a lightning invoice')
  const [, network, num, mult] = m
  if (!num) return { network }
  const n = BigInt(num)
  if (!mult) return { network, amountMsat: Number(n * 100_000_000_000n) }
  if (mult === 'p') return { network, amountMsat: Number(n / 10n) }
  return { network, amountMsat: Number(n * MSAT_PER_UNIT[mult]) }
}

export function decodeInvoice(invoice: string): DecodedInvoice {
  const inv = invoice.trim().toLowerCase().replace(/^lightning:/, '')
  const { prefix, words } = bech32.decode(inv as `${string}1${string}`, false)
  const { network, amountMsat } = parseAmount(prefix)
  const sigWords = words.slice(-104)
  const data = words.slice(0, -104)
  const timestamp = wordsToInt(data.slice(0, 7))
  let i = 7
  const out: DecodedInvoice = {
    network,
    amountMsat,
    timestamp,
    expiry: 3600,
    payee: '',
    payeeFromTag: false,
    routeHints: [],
    featureBits: [],
    blindedPaths: 0,
  }
  while (i < data.length) {
    const type = data[i]
    const len = data[i + 1] * 32 + data[i + 2]
    const w = data.slice(i + 3, i + 3 + len)
    i += 3 + len
    const bytes = () => bech32.fromWordsUnsafe(w) || wordsToBytesPadded(w).slice(0, Math.floor((len * 5) / 8))
    switch (type) {
      case 1:
        out.paymentHash = bytesToHex(bytes())
        break
      case 16:
        out.paymentSecret = bytesToHex(bytes())
        break
      case 13:
        out.description = new TextDecoder().decode(bytes())
        break
      case 23:
        out.descriptionHash = bytesToHex(bytes())
        break
      case 19:
        out.payee = bytesToHex(bytes())
        out.payeeFromTag = true
        break
      case 6:
        out.expiry = wordsToInt(w)
        break
      case 3: {
        const b = bytes()
        const hops: RouteHop[] = []
        for (let o = 0; o + 51 <= b.length; o += 51) {
          const s = decodeScid(b, o + 33)
          hops.push({
            pubkey: bytesToHex(b.slice(o, o + 33)),
            ...s,
            feeBaseMsat: readU(b, o + 41, 4),
            feePpm: readU(b, o + 45, 4),
            cltvDelta: readU(b, o + 49, 2),
          })
        }
        out.routeHints.push(hops)
        break
      }
      case 5: {
        // feature bits, big-endian over words
        for (let k = 0; k < w.length; k++) {
          for (let bit = 0; bit < 5; bit++) {
            if (w[w.length - 1 - k] & (1 << bit)) out.featureBits.push(k * 5 + bit)
          }
        }
        break
      }
      case 20:
        // 'b' blinded path (BOLT12-style blinded paths inside bolt11)
        out.blindedPaths++
        break
    }
  }
  if (!out.payee) {
    const sigBytes = wordsToBytesPadded(sigWords).slice(0, 65)
    const msg = new Uint8Array([...utf8ToBytes(prefix), ...wordsToBytesPadded(data)])
    const hash = sha256(msg)
    const recovered = new Uint8Array(65)
    recovered[0] = sigBytes[64]
    recovered.set(sigBytes.slice(0, 64), 1)
    const pk = secp256k1.recoverPublicKey(recovered, hash, { prehash: false })
    out.payee = bytesToHex(pk)
  }
  return out
}

export function satsFromMsat(msat?: number): number {
  return msat ? Math.floor(msat / 1000) : 0
}
