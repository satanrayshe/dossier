import { nip19 } from 'nostr-tools'
import { RelayPool } from '../src/lib/relay'
const pool = new RelayPool(); const queryMany = pool.queryMany.bind(pool)
import { decodeInvoice } from '../src/lib/bolt11'

const npub = process.argv[2] ?? 'npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6'
const pk = nip19.decode(npub).data as string
const relays = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.nostr.band', 'wss://purplepag.es', 'wss://nostr.wine', 'wss://relay.snort.social', 'wss://offchain.pub']
const t0 = Date.now()
const meta = await queryMany(relays, [{ authors: [pk], kinds: [0, 3, 10002, 10050], limit: 20 }])
console.log('meta', meta.events.map(e => [e.kind, e.created_at]), Date.now() - t0)
for (const r of meta.perRelay) console.log(' ', r.relay, r.events.length, r.eose, r.error, r.closed, r.ms)
const k0 = meta.events.find(e => e.kind === 0)
const prof = k0 ? JSON.parse(k0.content) : {}
console.log('profile', { name: prof.name, nip05: prof.nip05, lud16: prof.lud16 })
const t1 = Date.now()
const notes = await queryMany(relays, [{ authors: [pk], kinds: [1], limit: 500 }])
console.log('notes', notes.events.length, Date.now() - t1)
const dms = await queryMany(relays, [{ authors: [pk], kinds: [4], limit: 200 }])
console.log('sent dms', dms.events.length); for (const r of dms.perRelay) console.log(' ', r.relay, r.events.length, r.closed ?? '', r.error ?? '')
const rdms = await queryMany(relays, [{ '#p': [pk], kinds: [4], limit: 200 }])
console.log('recv dms', rdms.events.length); for (const r of rdms.perRelay) console.log(' ', r.relay, r.events.length, r.closed ?? '', r.error ?? '')
const zaps = await queryMany(relays, [{ '#p': [pk], kinds: [9735], limit: 200 }])
console.log('zaps recv', zaps.events.length)
const zs = await queryMany(relays, [{ '#P': [pk], kinds: [9735], limit: 200 }])
console.log('zaps sent', zs.events.length)
const z = zaps.events[0]
if (z) {
  const b = z.tags.find(t => t[0] === 'bolt11')?.[1]
  if (b) { const d = decodeInvoice(b); console.log('zap invoice', d.payee, d.amountMsat, d.routeHints.length) }
}
if (prof.lud16) {
  const [name, domain] = prof.lud16.split('@')
  const r = await fetch(`https://${domain}/.well-known/lnurlp/${name}`)
  const j = await r.json(); console.log('lnurl', j.callback, j.nostrPubkey, j.minSendable, r.headers.get('access-control-allow-origin'))
  const cb = new URL(j.callback); cb.searchParams.set('amount', String(Math.max(j.minSendable, 1000)))
  const inv = await (await fetch(cb)).json()
  if (inv.pr) { const d = decodeInvoice(inv.pr); console.log('invoice', d.payee, d.payeeFromTag, JSON.stringify(d.routeHints), d.featureBits, d.blindedPaths) 
    const node = await fetch(`https://mempool.space/api/v1/lightning/nodes/${d.payee}`)
    console.log('node', node.status, (await node.text()).slice(0, 400))
  } else console.log(inv)
}
pool.closeAll()
