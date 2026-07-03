import { useEffect, useState } from 'react'
import { AgentPresetRow } from '@renderer/components/dashboard/AgentPresetRow'
import { Composer } from '@renderer/components/dashboard/Composer'
import { CorePill } from '@renderer/components/dashboard/CorePill'
import { QuickActions } from '@renderer/components/dashboard/QuickActions'
import { SearchBar } from '@renderer/components/dashboard/SearchBar'
import { dayPartFromHour } from '@renderer/lib/time'

/** Real task tallies for the dashboard summary line. */
interface TaskStats {
  done: number
  inProgress: number
  todo: number
}

/** Tally a task list into Done / In Progress / to-do (Backlog + Planned). */
function tallyTasks(tasks: { status: string }[]): TaskStats {
  let done = 0
  let inProgress = 0
  let todo = 0
  for (const task of tasks) {
    if (task.status === 'Done') done += 1
    else if (task.status === 'In Progress') inProgress += 1
    else if (task.status === 'Backlog' || task.status === 'Planned') todo += 1
  }
  return { done, inProgress, todo }
}

/** Home/dashboard view — greeting, composer, agent presets, quick actions. */
export function Dashboard(): JSX.Element {
  const [stats, setStats] = useState<TaskStats | null>(null)

  // Time-of-day greeting from the local clock — the app stores no user name.
  const greeting = `Good ${dayPartFromHour(new Date().getHours())}`

  // Pull real task counts once on mount; leave the summary in a neutral state
  // if the IPC call fails.
  useEffect(() => {
    let active = true
    void window.sunny.tasks
      .list()
      .then((tasks) => {
        if (active) setStats(tallyTasks(tasks))
      })
      .catch(() => {
        /* non-fatal: keep the zero-state summary */
      })
    return () => {
      active = false
    }
  }, [])

  return (
    <div className="flex flex-col">
      {/* Top search bar */}
      <div className="border-b border-ink-700/40 px-8 py-4">
        <div className="mx-auto max-w-2xl">
          <SearchBar />
        </div>
      </div>

      <div className="mx-auto w-full max-w-3xl px-8 py-10">
        {/* Greeting block */}
        <div className="flex flex-col items-center text-center">
          <CorePill />
          <h1 className="mt-6 text-5xl font-bold tracking-tight text-fg-heading">{greeting}</h1>
          <p className="mt-4 max-w-xl text-base text-fg-muted">
            <StatsSummary stats={stats} />
          </p>
        </div>

        {/* Composer */}
        <div className="mt-9">
          <Composer />
        </div>

        {/* Agent preset cards */}
        <div className="mt-8">
          <AgentPresetRow />
        </div>

        {/* Quick actions */}
        <div className="mt-9">
          <QuickActions />
        </div>
      </div>
    </div>
  )
}

/** Honest one-line summary of the board, with a friendly zero-state. */
function StatsSummary({ stats }: { stats: TaskStats | null }): JSX.Element {
  if (stats === null) {
    return <>How can I help you accelerate today?</>
  }

  const total = stats.done + stats.inProgress + stats.todo
  if (total === 0) {
    return <>No tasks on the board yet. How can I help you get started?</>
  }

  return (
    <>
      <span className="font-semibold text-fg">{stats.done}</span> done ·{' '}
      <span className="font-semibold text-fg">{stats.inProgress}</span> in progress ·{' '}
      <span className="font-semibold text-fg">{stats.todo}</span> to do. How can I help you
      accelerate today?
    </>
  )
}
