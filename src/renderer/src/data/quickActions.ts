import {
  Bug,
  CalendarClock,
  FileSearch,
  Lightbulb,
  ListChecks,
  PenLine,
  Scale,
  Sparkles,
  type LucideIcon
} from 'lucide-react'

/** A quick-action chip under the agent presets. */
export interface QuickAction {
  id: string
  label: string
  icon: LucideIcon
  /** Starter prompt the chip drops into the dashboard composer (cursor at end). */
  starter: string
}

/**
 * Primary chip row. Each starter is a strong, specific opening that asks for the
 * context it needs before acting, so a single tap turns into a real task.
 */
export const quickActions: QuickAction[] = [
  {
    id: 'plan',
    label: 'Plan',
    icon: CalendarClock,
    starter:
      'Help me plan a project. First ask me about the goal, constraints, and timeline, then propose a clear step-by-step plan with milestones.'
  },
  {
    id: 'research',
    label: 'Research',
    icon: FileSearch,
    starter:
      'Research the following topic and give me a structured briefing with key findings, trade-offs, and sources I can verify:\n\n'
  },
  {
    id: 'write',
    label: 'Write',
    icon: PenLine,
    starter:
      'Help me write this. Ask me for the audience, goal, and tone first, then draft it and offer two alternative angles:\n\n'
  },
  {
    id: 'debug',
    label: 'Debug',
    icon: Bug,
    starter:
      "Help me debug this. Here's what's happening, what I expected, and the relevant code or error — walk me through the likely cause and a fix:\n\n"
  },
  {
    id: 'review',
    label: 'Review',
    icon: ListChecks,
    starter:
      'Review the following for correctness, clarity, and anything I missed. Give specific, actionable feedback prioritized by impact:\n\n'
  },
  {
    id: 'decide',
    label: 'Decide',
    icon: Scale,
    starter:
      'Help me make a decision. Ask about my options and what I care about, then compare them on those criteria and give a clear recommendation.'
  },
  {
    id: 'brainstorm',
    label: 'Brainstorm',
    icon: Lightbulb,
    starter:
      'Brainstorm ideas with me. Ask one or two quick questions to focus the goal, then give me a diverse, ranked shortlist with the reasoning for each.'
  }
]

/** The single centered "Explain" chip on its own row. */
export const learnAction: QuickAction = {
  id: 'explain',
  label: 'Explain',
  icon: Sparkles,
  starter:
    'Explain this clearly, starting from the fundamentals and building up with a concrete example. Ask me what level to pitch it at first:\n\n'
}
