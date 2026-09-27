import { useContext, useMemo } from 'react'
import { forceCollide, forceLink, forceManyBody, forceRadial, forceSimulation, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force'
import type { Tie } from '../lib/analyze'
import { IdentityCtx, aliasColor, shortNpub } from './common'

interface N extends SimulationNodeDatum {
  id: string
  r: number
  subject?: boolean
  tie?: Tie
}
interface L extends SimulationLinkDatum<N> {
  kind: 'dm' | 'zap' | 'reply'
  w: number
}

const W = 760
const H = 440

/** Analyst-style link chart: the subject in the middle, ties weighted by channel. */
export function LinkChart({ subjectName, ties }: { subjectName: string; ties: Tie[] }) {
  const { unlocked, aliasOf, names } = useContext(IdentityCtx)
  const layout = useMemo(() => {
    const nodes: N[] = [{ id: 'subject', r: 16, subject: true, fx: W / 2, fy: H / 2 }]
    const links: L[] = []
    const max = Math.max(1, ...ties.map((t) => t.score))
    for (const t of ties) {
      nodes.push({ id: t.pubkey, r: 6 + 10 * Math.sqrt(t.score / max), tie: t })
      if (t.dms) links.push({ source: 'subject', target: t.pubkey, kind: 'dm', w: t.dms })
      if (t.zaps) links.push({ source: 'subject', target: t.pubkey, kind: 'zap', w: t.zaps })
      if (t.replies) links.push({ source: 'subject', target: t.pubkey, kind: 'reply', w: t.replies })
    }
    // closer ties sit nearer the subject; the ring is elliptical to use the wide canvas
    const ring = (d: N) => (d.subject ? 0 : 120 + (1 - (d.tie?.score ?? 0) / max) * 70)
    const sim = forceSimulation(nodes)
      .force('charge', forceManyBody().strength(-220))
      .force('link', forceLink<N, L>(links).id((d) => d.id).distance((l) => ring(l.target as N)).strength(0.05))
      .force('radial', forceRadial<N>(ring, W / 2, H / 2).strength(0.9))
      .force('collide', forceCollide<N>((d) => d.r + 30))
      .stop()
    for (let i = 0; i < 320; i++) sim.tick()
    for (const n of nodes) {
      if (!n.subject) n.x = W / 2 + ((n.x ?? 0) - W / 2) * 1.55
      n.x = Math.max(40, Math.min(W - 40, n.x ?? 0))
      n.y = Math.max(24, Math.min(H - 24, n.y ?? 0))
    }
    return { nodes, links }
  }, [ties])

  const color = { dm: 'var(--red)', zap: 'var(--amber)', reply: 'var(--rule-strong)' }
  const offset = { dm: -4, zap: 4, reply: 0 }
  return (
    <figure style={{ margin: 0 }}>
      <svg className="linkchart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Link chart of the subject's closest ties">
        {layout.links.map((l, i) => {
          const s = l.source as N
          const t = l.target as N
          const dx = (t.x ?? 0) - (s.x ?? 0)
          const dy = (t.y ?? 0) - (s.y ?? 0)
          const len = Math.hypot(dx, dy) || 1
          const ox = (-dy / len) * offset[l.kind]
          const oy = (dx / len) * offset[l.kind]
          return (
            <line
              key={i}
              x1={(s.x ?? 0) + ox}
              y1={(s.y ?? 0) + oy}
              x2={(t.x ?? 0) + ox}
              y2={(t.y ?? 0) + oy}
              stroke={color[l.kind]}
              strokeWidth={Math.min(5, 1 + Math.log2(1 + l.w))}
              strokeDasharray={l.kind === 'dm' ? '5 3' : undefined}
              opacity={0.85}
            />
          )
        })}
        {layout.nodes.map((n) => {
          if (n.subject)
            return (
              <g key="subject" transform={`translate(${n.x},${n.y})`}>
                <circle r={n.r + 5} fill="none" stroke="var(--red)" strokeWidth={1.5} />
                <circle r={n.r} fill="var(--ink)" />
                <text y={-n.r - 12} textAnchor="middle" style={{ fontWeight: 600, fontSize: 12 }}>
                  {subjectName}
                </text>
              </g>
            )
          const a = aliasOf(n.id)
          const label = unlocked ? names[n.id]?.name || shortNpub(n.id) : `Contact ${String(a).padStart(2, '0')}`
          return (
            <g key={n.id} transform={`translate(${n.x},${n.y})`}>
              <title>{`${label}: ${n.tie?.dms ?? 0} DMs · ${n.tie?.zaps ?? 0} zaps · ${n.tie?.replies ?? 0} replies`}</title>
              <circle r={n.r} fill={aliasColor(a)} stroke="var(--sheet)" strokeWidth={2} />
              <text y={n.r + 12} textAnchor="middle">
                {label.length > 16 ? label.slice(0, 15) + '…' : label}
              </text>
            </g>
          )
        })}
      </svg>
      <figcaption className="key">
        <span>
          <i style={{ borderColor: 'var(--red)', borderTopStyle: 'dashed' }} />
          private messages
        </span>
        <span>
          <i style={{ borderColor: 'var(--amber)' }} />
          zaps
        </span>
        <span>
          <i style={{ borderColor: 'var(--rule-strong)' }} />
          public replies
        </span>
        <span>line weight = volume · node size = closeness</span>
      </figcaption>
    </figure>
  )
}
