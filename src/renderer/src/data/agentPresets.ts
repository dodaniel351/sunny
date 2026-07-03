import {
  Compass,
  Network,
  PenLine,
  SearchCheck,
  ServerCog,
  TerminalSquare,
  type LucideIcon
} from 'lucide-react'

/** A preset agent card shown in the dashboard's preset row (spec §7). */
export interface AgentPreset {
  id: string
  /**
   * Display name — also the lookup key into the seeded backend agents, so these
   * MUST stay in sync with the seeded agent names (do not rename).
   */
  name: string
  /** Short uppercase role label under the name. */
  role: string
  /** One-line description of what this agent is good at. */
  description: string
  icon: LucideIcon
  /** Tailwind classes tinting the icon tile (text + bg). */
  tint: string
}

/** The built-in presets — each with a distinct accent-tinted icon tile. */
export const agentPresets: AgentPreset[] = [
  {
    id: 'orchestrator',
    name: 'Orchestrator',
    role: 'Coordinator',
    description:
      'Decomposes goals and routes each subtask to the best-suited agent and model, then synthesizes the results.',
    icon: Network,
    tint: 'text-violet-300 bg-violet-300/10'
  },
  {
    id: 'cowork',
    name: 'Cowork',
    role: 'Autonomous',
    description: 'Plans and runs multi-step work end to end — research, draft, then refine.',
    icon: Compass,
    tint: 'text-amber-300 bg-amber-300/10'
  },
  {
    id: 'research',
    name: 'Research',
    role: 'Analyst',
    description: 'Gathers, cross-checks, and synthesizes sources into structured, cited findings.',
    icon: SearchCheck,
    tint: 'text-status-queued bg-status-queued/10'
  },
  {
    id: 'code',
    name: 'Code',
    role: 'Engineer',
    description: 'Designs, writes, reviews, and debugs clean, correct code with a senior eye.',
    icon: TerminalSquare,
    tint: 'text-status-success bg-status-success/10'
  },
  {
    id: 'ops',
    name: 'Ops',
    role: 'DevOps',
    description: 'Handles deploys, CI/CD, infra, and runbooks — cautious with destructive steps.',
    icon: ServerCog,
    tint: 'text-status-info bg-status-info/10'
  },
  {
    id: 'write',
    name: 'Write copy',
    role: 'Copywriter',
    description: 'Drafts and edits clear, on-brand, persuasive copy that lands.',
    icon: PenLine,
    tint: 'text-pink-300 bg-pink-300/10'
  }
]
