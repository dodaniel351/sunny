import { lazy } from 'react'
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from '@renderer/components/layout/AppShell'
import { Dashboard } from '@renderer/routes/Dashboard'

/**
 * Heavy route pages are code-split via React.lazy so they land in their own
 * Vite chunks instead of the main bundle (recharts/d3-force in Memory,
 * @dnd-kit in Board, etc.). Dashboard stays eager — it's the landing route and
 * should feel instant. The Suspense boundary that covers these lives in
 * AppShell, around the routed <Outlet />.
 *
 * Each route uses a named export, so we remap it to `default` for React.lazy.
 */
const Chats = lazy(() => import('@renderer/routes/Chats').then((m) => ({ default: m.Chats })))
const ChatView = lazy(() =>
  import('@renderer/routes/ChatView').then((m) => ({ default: m.ChatView }))
)
const Board = lazy(() => import('@renderer/routes/Board').then((m) => ({ default: m.Board })))
const Objectives = lazy(() =>
  import('@renderer/routes/Objectives').then((m) => ({ default: m.Objectives }))
)
const Approvals = lazy(() =>
  import('@renderer/routes/Approvals').then((m) => ({ default: m.Approvals }))
)
const Team = lazy(() => import('@renderer/routes/Team').then((m) => ({ default: m.Team })))
const Agents = lazy(() => import('@renderer/routes/Agents').then((m) => ({ default: m.Agents })))
const Schedules = lazy(() =>
  import('@renderer/routes/Schedules').then((m) => ({ default: m.Schedules }))
)
const Memory = lazy(() => import('@renderer/routes/Memory').then((m) => ({ default: m.Memory })))
const Activity = lazy(() =>
  import('@renderer/routes/Activity').then((m) => ({ default: m.Activity }))
)
const Settings = lazy(() =>
  import('@renderer/routes/Settings').then((m) => ({ default: m.Settings }))
)

/**
 * Renderer root. HashRouter is required because Electron loads the renderer over
 * file:// — BrowserRouter's history API can't resolve those paths.
 */
export default function App(): JSX.Element {
  return (
    <HashRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/chats" element={<Chats />} />
          <Route path="/chats/:chatId" element={<ChatView />} />
          <Route path="/board" element={<Board />} />
          <Route path="/team" element={<Team />} />
          <Route path="/objectives" element={<Objectives />} />
          <Route path="/approvals" element={<Approvals />} />
          <Route path="/agents" element={<Agents />} />
          <Route path="/schedules" element={<Schedules />} />
          <Route path="/memory" element={<Memory />} />
          <Route path="/activity" element={<Activity />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  )
}
