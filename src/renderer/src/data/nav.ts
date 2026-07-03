import {
  Activity,
  Bot,
  CalendarClock,
  Database,
  MessageSquare,
  Network,
  Settings,
  ShieldCheck,
  SquareKanban,
  Target,
  type LucideIcon
} from 'lucide-react'

/** A primary sidebar navigation entry. */
export interface NavItem {
  to: string
  label: string
  icon: LucideIcon
}

/**
 * Primary nav. The mockup's "Workflows" is renamed to "Board" per spec §9
 * (the Kanban task store is the workflow surface). "Activity" is the structure
 * layer's durable audit feed.
 */
export const navItems: NavItem[] = [
  { to: '/chats', label: 'Chats', icon: MessageSquare },
  { to: '/board', label: 'Board', icon: SquareKanban },
  { to: '/team', label: 'Team', icon: Network },
  { to: '/objectives', label: 'Objectives', icon: Target },
  { to: '/approvals', label: 'Approvals', icon: ShieldCheck },
  { to: '/agents', label: 'Agents', icon: Bot },
  { to: '/schedules', label: 'Schedules', icon: CalendarClock },
  { to: '/memory', label: 'Memory', icon: Database },
  { to: '/activity', label: 'Activity', icon: Activity },
  { to: '/settings', label: 'Settings', icon: Settings }
]
