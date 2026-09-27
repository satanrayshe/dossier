// Minimal relay client. We talk to each relay individually (instead of merging through a pool)
// because several exhibits depend on *which* relay returned *what*: deletion compliance,
// DM-query refusals, stale profile versions. One socket per relay, many subscriptions on it.

import { verifyEvent } from 'nostr-tools/pure'

export interface NEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

export type Filter = {
  ids?: string[]
  authors?: string[]
  kinds?: number[]
  since?: number
  until?: number
  limit?: number
} & { [tag: `#${string}`]: string[] }

export interface RelayResult {
  relay: string
  events: NEvent[]
  eose: boolean
  /** relay answered CLOSED — usually "auth-required" for DMs */
  closed?: string
  error?: string
  ms: number
}

const verified = new Map<string, boolean>()
function isValid(ev: NEvent): boolean {
  let ok = verified.get(ev.id)
  if (ok === undefined) {
    try {
      ok = verifyEvent(ev as Parameters<typeof verifyEvent>[0])
    } catch {
      ok = false
    }
    verified.set(ev.id, ok)
  }
  return ok
}

interface PendingSub {
  events: NEvent[]
  seen: Set<string>
  started: number
  resolve: (r: RelayResult) => void
  timer: ReturnType<typeof setTimeout>
}

let subCounter = 0

export class RelaySession {
  readonly url: string
  private ws?: WebSocket
  private ready?: Promise<void>
  private failed?: string
  private subs = new Map<string, PendingSub>()
  private oks = new Map<string, (r: { ok: boolean; message: string }) => void>()

  constructor(url: string) {
    this.url = url
  }

  private connect(timeoutMs: number): Promise<void> {
    if (this.ready) return this.ready
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.failed = 'connect timeout'
        reject(new Error(this.failed))
        try {
          this.ws?.close()
        } catch {
          /* ignore */
        }
      }, timeoutMs)
      let ws: WebSocket
      try {
        ws = new WebSocket(this.url)
      } catch (e) {
        clearTimeout(timer)
        this.failed = String(e)
        reject(e)
        return
      }
      this.ws = ws
      ws.onopen = () => {
        clearTimeout(timer)
        resolve()
      }
      ws.onerror = () => {
        clearTimeout(timer)
        this.failed ??= 'connection failed'
        reject(new Error(this.failed))
      }
      ws.onclose = () => {
        this.failed ??= 'connection closed'
        for (const [id, s] of this.subs) this.finish(id, s, { error: s.events.length ? undefined : this.failed })
        for (const [, cb] of this.oks) cb({ ok: false, message: this.failed })
        this.oks.clear()
      }
      ws.onmessage = (msg) => this.onMessage(msg)
    })
    return this.ready
  }

  private onMessage(msg: MessageEvent) {
    let data: unknown
    try {
      data = JSON.parse(typeof msg.data === 'string' ? msg.data : '')
    } catch {
      return
    }
    if (!Array.isArray(data)) return
    const [type, sid, payload, extra] = data
    if (type === 'OK') {
      const cb = this.oks.get(sid)
      if (cb) {
        this.oks.delete(sid)
        cb({ ok: !!payload, message: String(extra ?? '') })
      }
      return
    }
    const sub = this.subs.get(sid)
    if (!sub) return
    if (type === 'EVENT' && payload && typeof payload === 'object') {
      const ev = payload as NEvent
      if (!sub.seen.has(ev.id) && isValid(ev)) {
        sub.seen.add(ev.id)
        sub.events.push(ev)
      }
    } else if (type === 'EOSE') {
      this.finish(sid, sub, { eose: true })
    } else if (type === 'CLOSED') {
      this.finish(sid, sub, { closed: String(payload || 'closed') })
    }
    // AUTH challenges are ignored on purpose: an outside analyst can't authenticate as the subject.
  }

  private finish(sid: string, sub: PendingSub, extra: Partial<RelayResult>) {
    if (!this.subs.has(sid)) return
    this.subs.delete(sid)
    clearTimeout(sub.timer)
    if (this.ws?.readyState === WebSocket.OPEN && !extra.closed) {
      try {
        this.ws.send(JSON.stringify(['CLOSE', sid]))
      } catch {
        /* ignore */
      }
    }
    sub.resolve({ relay: this.url, events: sub.events, eose: false, ms: Date.now() - sub.started, ...extra })
  }

  async query(filters: Filter[], timeoutMs = 8000): Promise<RelayResult> {
    const started = Date.now()
    if (this.failed) return { relay: this.url, events: [], eose: false, error: this.failed, ms: 0 }
    try {
      await this.connect(Math.min(timeoutMs, 6000))
    } catch {
      return { relay: this.url, events: [], eose: false, error: this.failed ?? 'connection failed', ms: Date.now() - started }
    }
    return new Promise((resolve) => {
      const sid = `dx${(++subCounter).toString(36)}`
      const sub: PendingSub = {
        events: [],
        seen: new Set(),
        started,
        resolve,
        timer: setTimeout(() => this.finish(sid, sub, { error: sub.events.length ? undefined : 'timeout' }), timeoutMs),
      }
      this.subs.set(sid, sub)
      try {
        this.ws!.send(JSON.stringify(['REQ', sid, ...filters]))
      } catch (e) {
        this.finish(sid, sub, { error: String(e) })
      }
    })
  }

  /** Page backwards through history for one filter. */
  async queryPaged(filter: Filter, { pages = 3, pageSize = 500, timeoutMs = 8000 } = {}): Promise<RelayResult> {
    const all: NEvent[] = []
    let until = filter.until
    let last: RelayResult | undefined
    for (let p = 0; p < pages; p++) {
      last = await this.query([{ ...filter, limit: pageSize, ...(until ? { until } : {}) }], timeoutMs)
      all.push(...last.events)
      // relays cap page sizes differently (300, 500, 1000); stop only when a page comes back thin
      if (last.events.length < 100 || last.error || last.closed) break
      until = Math.min(...last.events.map((e) => e.created_at)) - 1
    }
    return { ...(last as RelayResult), events: all }
  }

  async publish(ev: NEvent, timeoutMs = 8000): Promise<{ relay: string; ok: boolean; message: string }> {
    try {
      await this.connect(6000)
    } catch {
      return { relay: this.url, ok: false, message: this.failed ?? 'connection failed' }
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.oks.delete(ev.id)
        resolve({ relay: this.url, ok: false, message: 'timeout' })
      }, timeoutMs)
      this.oks.set(ev.id, (r) => {
        clearTimeout(timer)
        resolve({ relay: this.url, ...r })
      })
      this.ws!.send(JSON.stringify(['EVENT', ev]))
    })
  }

  get error() {
    return this.failed
  }

  close() {
    try {
      this.ws?.close()
    } catch {
      /* ignore */
    }
  }
}

export class RelayPool {
  private sessions = new Map<string, RelaySession>()

  get(url: string): RelaySession {
    let s = this.sessions.get(url)
    if (!s) this.sessions.set(url, (s = new RelaySession(url)))
    return s
  }

  async queryMany(
    urls: string[],
    filters: Filter[],
    { timeoutMs = 8000, pages = 1 }: { timeoutMs?: number; pages?: number } = {},
  ): Promise<MultiResult> {
    const perRelay = await Promise.all(
      urls.map((u) =>
        pages > 1 && filters.length === 1
          ? this.get(u).queryPaged(filters[0], { pages, timeoutMs, pageSize: filters[0].limit ?? 500 })
          : this.get(u).query(filters, timeoutMs),
      ),
    )
    return mergeResults(perRelay)
  }

  closeAll() {
    for (const s of this.sessions.values()) s.close()
    this.sessions.clear()
  }
}

export interface MultiResult {
  events: NEvent[]
  seenOn: Map<string, Set<string>>
  perRelay: RelayResult[]
}

export function mergeResults(perRelay: RelayResult[]): MultiResult {
  const byId = new Map<string, NEvent>()
  const seenOn = new Map<string, Set<string>>()
  for (const r of perRelay) {
    for (const ev of r.events) {
      byId.set(ev.id, ev)
      let s = seenOn.get(ev.id)
      if (!s) seenOn.set(ev.id, (s = new Set()))
      s.add(r.relay)
    }
  }
  const events = [...byId.values()].sort((a, b) => b.created_at - a.created_at)
  return { events, seenOn, perRelay }
}

export function normalizeRelay(url: string): string {
  const u = url.trim().replace(/\/+$/, '').toLowerCase()
  if (!/^wss?:\/\/[^\s/]+/.test(u)) return ''
  return u
}
