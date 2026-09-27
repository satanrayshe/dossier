import { collect, DEFAULT_SETTINGS } from '../src/lib/collect'
import { findings, exposureScore, timeProfile, formatOffset, dmContacts, zapSummary } from '../src/lib/analyze'
const input = process.argv[2] ?? 'npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6'
let lastLog = 0
const d = await collect(input, DEFAULT_SETTINGS, (x) => { for (const l of x.log.slice(lastLog)) console.log('  ·', l.text); lastLog = x.log.length })
const fs = findings(d)
const tp = timeProfile([...d.activity, ...d.dmsSent])
console.log('\nTZ', tp && formatOffset(tp.offset), tp?.confidence, tp?.zScore.toFixed(2), tp?.sample, 'quiet', tp?.quietStart, 'peak', tp?.peakStart)
console.log('contacts', dmContacts(d).slice(0,3).map(c => [c.pubkey.slice(0,8), c.sent, c.received]))
const z = zapSummary(d); console.log('zaps', z.inSats, z.outSats, z.inCount, z.outCount)
console.log('lightning', JSON.stringify({ addr: d.lightning.address, prov: d.lightning.provider?.name, payee: d.lightning.payeeNode, funding: d.lightning.funding, zp: d.lightning.zapPayees.map(p=>[p.node?.alias,p.count]) }).slice(0, 800))
console.log('media', d.media.map(m => m.status + ' ' + m.host).join(', '))
console.log('nip05', JSON.stringify(d.nip05))
console.log('coverage', d.coverage.map(c => `${c.relay.replace('wss://','')}:${c.reachable ? 'Y' : 'N'}`).join(' '))
console.log('\nFINDINGS'); for (const x of fs) console.log(`[${x.severity}] ${x.title}\n     ${x.detail.slice(0, 200)}`)
console.log(exposureScore(fs))
process.exit(0)
