import { describe, expect, it } from 'vitest'
import { decodeInvoice } from '../bolt11'
import { formatOffset, timeProfile } from '../analyze'
import { decodeGeohash, findPII, isValidBtcAddress } from '../scan'
import { parseZap } from '../collect'
import type { NEvent } from '../relay'

describe('bolt11', () => {
  // First test vector from BOLT #11
  const SPEC =
    'lnbc1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq9qrsgq357wnc5r2ueh7ck6q93dj32dlqnls087fxdwk8qakdyafkq3yap9us6v52vjjsrvywa6rt52cm9r9zqt8r2t7mlcwspyetp5h2tztugp9lfyql'

  it('recovers the payee node from the signature', () => {
    const inv = decodeInvoice(SPEC)
    expect(inv.payee).toBe('03e7156ae33b0a208d0744199163177e909e80176e55d97a2f221ede0f934dd9ad')
    expect(inv.payeeFromTag).toBe(false)
    expect(inv.description).toBe('Please consider supporting this project')
    expect(inv.amountMsat).toBeUndefined()
  })
})

describe('timezone inference', () => {
  const synth = (offset: number, n = 900) => {
    // draw posting times from a human day in local time, then shift to UTC
    const weights = [2, 1, 0.5, 0.3, 0.2, 0.3, 1, 2, 3, 4, 5, 5, 6, 5, 5, 5, 5, 6, 7, 8, 9, 9, 7, 4]
    const total = weights.reduce((a, b) => a + b, 0)
    const out: NEvent[] = []
    let seed = 7
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    const base = Date.UTC(2026, 0, 5) / 1000
    for (let i = 0; i < n; i++) {
      let r = rnd() * total
      let h = 0
      while (r > weights[h]) r -= weights[h++]
      const day = Math.floor(rnd() * 120)
      const local = base + day * 86400 + h * 3600 + Math.floor(rnd() * 3600)
      out.push({ id: String(i), pubkey: 'x', created_at: Math.round(local - offset * 3600), kind: 1, tags: [], content: '', sig: '' })
    }
    return out
  }

  for (const tz of [5.5, -5, 1, 9]) {
    it(`recovers ${formatOffset(tz)} within an hour`, () => {
      const tp = timeProfile(synth(tz))!
      expect(Math.abs(tp.offset - tz)).toBeLessThanOrEqual(1)
      expect(tp.confidence).not.toBe('low')
    })
  }

  it('refuses to guess from tiny samples', () => {
    expect(timeProfile(synth(0, 10))).toBeUndefined()
  })
})

describe('scanners', () => {
  it('validates bitcoin addresses by checksum', () => {
    expect(isValidBtcAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')).toBe(true)
    expect(isValidBtcAddress('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')).toBe(true)
    expect(isValidBtcAddress('bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297')).toBe(true)
    expect(isValidBtcAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb')).toBe(false)
  })

  it('does not mistake NIP-05 handles for email addresses', () => {
    expect(findPII('follow cody@jumble.social and verbiricha@habla.news').emails).toEqual([])
    expect(findPII('contact me at alice@proton.me').emails).toEqual(['alice@proton.me'])
    expect(findPII('business inquiries: bob@example.org').emails).toEqual(['bob@example.org'])
  })

  it('decodes geohashes', () => {
    const g = decodeGeohash('tdr1y')!
    expect(g.lat).toBeCloseTo(12.97, 0)
    expect(g.lon).toBeCloseTo(77.6, 0)
  })
})

describe('zap receipts', () => {
  it('extracts payer, amount and anonymity from the embedded request', () => {
    const request = { pubkey: 'a'.repeat(64), kind: 9734, content: 'gm', tags: [['p', 'b'.repeat(64)], ['amount', '21000']], created_at: 1, id: 'r', sig: '' }
    const receipt: NEvent = {
      id: 'z',
      pubkey: 'c'.repeat(64),
      kind: 9735,
      created_at: 100,
      content: '',
      sig: '',
      tags: [
        ['p', 'b'.repeat(64)],
        ['description', JSON.stringify(request)],
      ],
    }
    const z = parseZap(receipt)!
    expect(z.sender).toBe('a'.repeat(64))
    expect(z.sats).toBe(21)
    expect(z.message).toBe('gm')
    expect(z.anon).toBe(false)
    const anon = parseZap({ ...receipt, tags: [receipt.tags[0], ['description', JSON.stringify({ ...request, tags: [...request.tags, ['anon']] })]] })!
    expect(anon.sender).toBeUndefined()
    expect(anon.anon).toBe(true)
  })
})
