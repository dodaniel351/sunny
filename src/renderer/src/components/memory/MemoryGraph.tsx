import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum
} from 'd3-force'
import { Brain } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EmptyState } from '@renderer/components/ui/EmptyState'
import { Spinner } from '@renderer/components/ui/Spinner'
import type { MemoryEntity, MemoryRelation } from '@shared/db/types'
import { entityColor, graphColors, provenanceDash } from './memoryMeta'

interface MemoryGraphProps {
  entities: MemoryEntity[]
  relations: MemoryRelation[]
  loading: boolean
  error: string | null
  /** Whether the graph tab is currently shown — drives sim start/stop. */
  active: boolean
  selectedId: string | null
  onSelect: (entity: { id: string; name: string }) => void
}

// A simulation node carries the entity plus mutable d3 position fields.
interface GraphNode extends SimulationNodeDatum {
  id: string
  entity: MemoryEntity
  radius: number
  color: string
}

// After ForceLink initialization, source/target are resolved to node objects.
interface GraphLink extends SimulationLinkDatum<GraphNode> {
  id: string
  relation: string
  provenance: string
  dash: string | undefined
}

interface Transform {
  x: number
  y: number
  k: number
}

const MIN_ZOOM = 0.25
const MAX_ZOOM = 4
const BASE_RADIUS = 8
const MAX_RADIUS = 26

/** Scale a node radius from its mention_count (sqrt keeps big hubs in check). */
function radiusFor(mentionCount: number): number {
  const r = BASE_RADIUS + Math.sqrt(Math.max(0, mentionCount)) * 4
  return Math.min(MAX_RADIUS, r)
}

/** Truncate a label so long names don't blow out the layout. */
function truncate(label: string, max = 22): string {
  return label.length > max ? `${label.slice(0, max - 1)}…` : label
}

/**
 * Force-directed knowledge graph rendered as SVG. The d3 simulation is created in
 * an effect keyed on the (id-stable) entity/relation sets; it mutates node x/y in
 * place and, on each `tick`, we schedule a single requestAnimationFrame that
 * writes the positions straight onto the SVG elements via refs (no React re-render
 * per frame — keeps ~200 nodes smooth). The sim is stopped on unmount and whenever
 * the tab isn't `active`.
 *
 * Interactions: drag a node (pointer events set fx/fy and re-heat the sim),
 * wheel to zoom and drag the background to pan (a transform on the root <g>), and
 * click a node to select it (loads the detail panel in the parent).
 */
export function MemoryGraph({
  entities,
  relations,
  loading,
  error,
  active,
  selectedId,
  onSelect
}: MemoryGraphProps): JSX.Element {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const sizeRef = useRef({ width: 800, height: 560 })
  const [size, setSize] = useState({ width: 800, height: 560 })

  const [transform, setTransform] = useState<Transform>({ x: 0, y: 0, k: 1 })
  // Hovered relation id → reveal its mid-edge label.
  const [hoveredLink, setHoveredLink] = useState<string | null>(null)

  // Refs to the live <g> wrappers per node so the rAF tick can move them without
  // re-rendering React. Keyed by node id.
  const nodeEls = useRef(new Map<string, SVGGElement>())
  const linkEls = useRef(new Map<string, SVGLineElement>())
  const linkLabelEls = useRef(new Map<string, SVGTextElement>())

  const simRef = useRef<Simulation<GraphNode, GraphLink> | null>(null)
  const rafRef = useRef<number | null>(null)
  const draggingRef = useRef<string | null>(null)

  // Build sim datums. Only entities that exist back the links (drop dangling
  // relations so ForceLink doesn't choke on unknown ids).
  const { nodes, links } = useMemo(() => {
    const nodeList: GraphNode[] = entities.map((entity) => ({
      id: entity.id,
      entity,
      radius: radiusFor(entity.mention_count),
      color: entityColor(entity.type)
    }))
    const ids = new Set(nodeList.map((n) => n.id))
    const linkList: GraphLink[] = relations
      .filter((rel) => ids.has(rel.source_id) && ids.has(rel.target_id))
      .map((rel) => ({
        id: rel.id,
        source: rel.source_id,
        target: rel.target_id,
        relation: rel.relation,
        provenance: rel.provenance,
        dash: provenanceDash(rel.provenance)
      }))
    return { nodes: nodeList, links: linkList }
  }, [entities, relations])

  // Track the SVG's measured size so the center force + viewBox match the box.
  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    const observer = new ResizeObserver((batch) => {
      const rect = batch[0]?.contentRect
      if (!rect) return
      const next = { width: Math.max(320, rect.width), height: Math.max(320, rect.height) }
      sizeRef.current = next
      setSize(next)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Position writer: copy node x/y onto the SVG elements. Called from the tick.
  const paint = useCallback(() => {
    rafRef.current = null
    for (const node of nodes) {
      const el = nodeEls.current.get(node.id)
      if (el && node.x !== undefined && node.y !== undefined) {
        el.setAttribute('transform', `translate(${node.x},${node.y})`)
      }
    }
    for (const link of links) {
      const src = link.source as GraphNode
      const tgt = link.target as GraphNode
      if (typeof src !== 'object' || typeof tgt !== 'object') continue
      const lineEl = linkEls.current.get(link.id)
      if (lineEl && src.x !== undefined && tgt.x !== undefined) {
        lineEl.setAttribute('x1', String(src.x))
        lineEl.setAttribute('y1', String(src.y ?? 0))
        lineEl.setAttribute('x2', String(tgt.x))
        lineEl.setAttribute('y2', String(tgt.y ?? 0))
      }
      const labelEl = linkLabelEls.current.get(link.id)
      if (labelEl && src.x !== undefined && tgt.x !== undefined) {
        labelEl.setAttribute('x', String(((src.x ?? 0) + (tgt.x ?? 0)) / 2))
        labelEl.setAttribute('y', String(((src.y ?? 0) + (tgt.y ?? 0)) / 2))
      }
    }
  }, [nodes, links])

  const schedulePaint = useCallback(() => {
    if (rafRef.current === null) rafRef.current = requestAnimationFrame(paint)
  }, [paint])

  // Create / recreate the simulation when the graph data changes. Runs only while
  // the tab is active so a hidden graph isn't burning CPU.
  useEffect(() => {
    if (!active || nodes.length === 0) return
    const { width, height } = sizeRef.current
    const sim = forceSimulation<GraphNode>(nodes)
      .force(
        'link',
        forceLink<GraphNode, GraphLink>(links)
          .id((d) => d.id)
          .distance(90)
          .strength(0.4)
      )
      .force('charge', forceManyBody<GraphNode>().strength(-260))
      .force('center', forceCenter<GraphNode>(width / 2, height / 2))
      .force(
        'collide',
        forceCollide<GraphNode>().radius((d) => d.radius + 6)
      )
    sim.on('tick', schedulePaint)
    simRef.current = sim

    return () => {
      sim.on('tick', null)
      sim.stop()
      simRef.current = null
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [active, nodes, links, schedulePaint])

  // Keep the center force aligned with the live size without rebuilding the sim.
  useEffect(() => {
    const sim = simRef.current
    if (!sim) return
    sim.force('center', forceCenter<GraphNode>(size.width / 2, size.height / 2))
    sim.alpha(0.3).restart()
  }, [size.width, size.height])

  // --- Node drag (pointer events) -------------------------------------------
  const handleNodePointerDown = useCallback(
    (event: React.PointerEvent<SVGGElement>, node: GraphNode) => {
      event.stopPropagation()
      ;(event.target as Element).setPointerCapture?.(event.pointerId)
      draggingRef.current = node.id
      simRef.current?.alphaTarget(0.3).restart()
    },
    []
  )

  const handleNodePointerMove = useCallback(
    (event: React.PointerEvent<SVGGElement>, node: GraphNode) => {
      if (draggingRef.current !== node.id) return
      event.stopPropagation()
      const svg = svgRef.current
      if (!svg) return
      const rect = svg.getBoundingClientRect()
      // Invert the pan/zoom transform to map screen → sim coordinates.
      node.fx = (event.clientX - rect.left - transform.x) / transform.k
      node.fy = (event.clientY - rect.top - transform.y) / transform.k
      schedulePaint()
    },
    [transform, schedulePaint]
  )

  const handleNodePointerUp = useCallback((node: GraphNode) => {
    if (draggingRef.current !== node.id) return
    draggingRef.current = null
    simRef.current?.alphaTarget(0)
    // Release the fixed position so the node settles back into the layout.
    node.fx = null
    node.fy = null
  }, [])

  // --- Background pan + wheel zoom -------------------------------------------
  const panRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null)

  const handleBgPointerDown = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      if (event.target !== svgRef.current) return
      ;(event.currentTarget as Element).setPointerCapture(event.pointerId)
      panRef.current = { x: event.clientX, y: event.clientY, tx: transform.x, ty: transform.y }
    },
    [transform.x, transform.y]
  )

  const handleBgPointerMove = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    const pan = panRef.current
    if (!pan) return
    setTransform((prev) => ({
      ...prev,
      x: pan.tx + (event.clientX - pan.x),
      y: pan.ty + (event.clientY - pan.y)
    }))
  }, [])

  const handleBgPointerUp = useCallback(() => {
    panRef.current = null
  }, [])

  const handleWheel = useCallback((event: React.WheelEvent<SVGSVGElement>) => {
    event.preventDefault()
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const px = event.clientX - rect.left
    const py = event.clientY - rect.top
    setTransform((prev) => {
      const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1
      const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, prev.k * factor))
      if (k === prev.k) return prev
      // Zoom toward the cursor: keep the point under the pointer stationary.
      const x = px - ((px - prev.x) / prev.k) * k
      const y = py - ((py - prev.y) / prev.k) * k
      return { x, y, k }
    })
  }, [])

  const resetView = useCallback(() => setTransform({ x: 0, y: 0, k: 1 }), [])

  // --- Render states ---------------------------------------------------------
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 rounded-2xl border border-ink-700/70 bg-ink-850 text-sm text-fg-muted">
        <Spinner label="Loading knowledge graph" />
        Building the knowledge graph…
      </div>
    )
  }

  if (error) {
    return (
      <div
        className="flex h-full items-center justify-center rounded-2xl border border-status-blocked/40 bg-status-blocked/10 px-6 text-center text-sm text-status-blocked"
        role="alert"
      >
        {error}
      </div>
    )
  }

  if (entities.length === 0) {
    return (
      <div className="rounded-2xl border border-ink-700/70 bg-ink-850">
        <EmptyState
          icon={Brain}
          title="No memory yet"
          description="Chat with an agent and Sunny will build its knowledge graph automatically."
        />
      </div>
    )
  }

  return (
    <div className="relative h-full overflow-hidden rounded-2xl border border-ink-700/70 bg-ink-900">
      <svg
        ref={svgRef}
        role="img"
        aria-label={`Knowledge graph with ${entities.length} entities and ${links.length} relations. Switch to the list view for an accessible alternative.`}
        className="h-full w-full touch-none select-none"
        style={{ cursor: panRef.current ? 'grabbing' : 'grab' }}
        onPointerDown={handleBgPointerDown}
        onPointerMove={handleBgPointerMove}
        onPointerUp={handleBgPointerUp}
        onPointerLeave={handleBgPointerUp}
        onWheel={handleWheel}
      >
        <g transform={`translate(${transform.x},${transform.y}) scale(${transform.k})`}>
          {/* Edges */}
          <g>
            {links.map((link) => {
              const isHovered = hoveredLink === link.id
              return (
                <line
                  key={link.id}
                  ref={(el) => {
                    if (el) linkEls.current.set(link.id, el)
                    else linkEls.current.delete(link.id)
                  }}
                  stroke={isHovered ? graphColors.amber : graphColors.ink700}
                  strokeWidth={isHovered ? 2 : 1.25}
                  strokeOpacity={isHovered ? 0.9 : 0.55}
                  strokeDasharray={link.dash}
                  onPointerEnter={() => setHoveredLink(link.id)}
                  onPointerLeave={() => setHoveredLink((cur) => (cur === link.id ? null : cur))}
                />
              )
            })}
          </g>

          {/* Mid-edge relation labels (revealed on hover) */}
          <g>
            {links.map((link) => (
              <text
                key={link.id}
                ref={(el) => {
                  if (el) linkLabelEls.current.set(link.id, el)
                  else linkLabelEls.current.delete(link.id)
                }}
                textAnchor="middle"
                dy="-3"
                fontSize={9}
                fill={graphColors.fgMuted}
                pointerEvents="none"
                style={{ opacity: hoveredLink === link.id ? 1 : 0, transition: 'opacity 120ms' }}
              >
                {link.relation}
              </text>
            ))}
          </g>

          {/* Nodes */}
          <g>
            {nodes.map((node) => {
              const selected = node.id === selectedId
              return (
                <g
                  key={node.id}
                  ref={(el) => {
                    if (el) nodeEls.current.set(node.id, el)
                    else nodeEls.current.delete(node.id)
                  }}
                  className="cursor-pointer"
                  onPointerDown={(e) => handleNodePointerDown(e, node)}
                  onPointerMove={(e) => handleNodePointerMove(e, node)}
                  onPointerUp={() => handleNodePointerUp(node)}
                  onClick={(e) => {
                    e.stopPropagation()
                    onSelect({ id: node.id, name: node.entity.name })
                  }}
                >
                  <title>{`${node.entity.name} (${node.entity.type})`}</title>
                  <circle
                    r={node.radius}
                    fill={node.color}
                    fillOpacity={selected ? 1 : 0.85}
                    stroke={selected ? graphColors.amber : graphColors.ink850}
                    strokeWidth={selected ? 3 : 1.5}
                  />
                  <text
                    x={0}
                    y={node.radius + 12}
                    textAnchor="middle"
                    fontSize={10}
                    fontWeight={selected ? 600 : 400}
                    fill={selected ? graphColors.fg : graphColors.fgMuted}
                    pointerEvents="none"
                  >
                    {truncate(node.entity.name)}
                  </text>
                </g>
              )
            })}
          </g>
        </g>
      </svg>

      {/* Lightweight controls */}
      <div className="absolute right-3 top-3 flex items-center gap-2">
        <button
          type="button"
          onClick={resetView}
          className="rounded-lg border border-ink-700 bg-ink-850/90 px-2.5 py-1 text-xs font-medium text-fg-muted backdrop-blur transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
        >
          Reset view
        </button>
      </div>

      {/* Provenance legend */}
      <div className="pointer-events-none absolute bottom-3 left-3 flex flex-col gap-1 rounded-lg border border-ink-700/70 bg-ink-850/90 px-3 py-2 text-[11px] text-fg-muted backdrop-blur">
        <span className="flex items-center gap-2">
          <svg width="22" height="6" aria-hidden="true">
            <line x1="0" y1="3" x2="22" y2="3" stroke={graphColors.fgMuted} strokeWidth="1.5" />
          </svg>
          Extracted
        </span>
        <span className="flex items-center gap-2">
          <svg width="22" height="6" aria-hidden="true">
            <line
              x1="0"
              y1="3"
              x2="22"
              y2="3"
              stroke={graphColors.fgMuted}
              strokeWidth="1.5"
              strokeDasharray="5 4"
            />
          </svg>
          Inferred / ambiguous
        </span>
      </div>
    </div>
  )
}
