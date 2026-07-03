import { Suspense } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { useCorePing } from '@renderer/hooks/useCorePing'
import { useProjectsInit } from '@renderer/hooks/useProjectsInit'
import { useApprovalsBadge } from '@renderer/hooks/useApprovalsBadge'
import { useReviewBadge } from '@renderer/hooks/useReviewBadge'
import { ToolConfirmDialog } from '@renderer/components/chat/ToolConfirmDialog'
import { Spinner } from '@renderer/components/ui/Spinner'
import { IconRail } from './IconRail'
import { ProjectsPanel } from './ProjectsPanel'

/**
 * App shell: a thin section rail, then — for the Chats section (home + any
 * /chats route) — the Projects navigator (collapsible project folders with their
 * chats nested under them), then the routed content. Other sections (Board,
 * Agents, Schedules, Memory, Settings) use the full content width.
 */
export function AppShell(): JSX.Element {
  const { pathname } = useLocation()
  const showProjects = pathname === '/' || pathname.startsWith('/chats')

  // Prove the IPC pipe once on mount; status surfaces in the icon rail footer.
  useCorePing()
  // Seed the active-project scope (list + persisted selection) once on mount.
  useProjectsInit()
  // Keep the rail's pending-approvals badge live across every route.
  useApprovalsBadge()
  // Keep the rail's Activity badge (agent completions to review) live everywhere.
  useReviewBadge()

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-ink-950 text-fg">
      <IconRail />
      {showProjects ? <ProjectsPanel /> : null}
      <main className="flex-1 overflow-y-auto">
        {/* Only the routed page content is lazy; the shell chrome stays eager. */}
        <Suspense
          fallback={
            <div className="flex h-full w-full items-center justify-center bg-ink-950">
              <Spinner className="h-6 w-6" label="Loading page" />
            </div>
          }
        >
          <Outlet />
        </Suspense>
      </main>
      <ToolConfirmDialog />
    </div>
  )
}
