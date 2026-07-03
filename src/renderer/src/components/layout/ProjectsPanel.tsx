import { Check, ChevronDown, ChevronRight, Folder, MessageSquare, Plus, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { cn } from '@renderer/lib/cn'
import { compactTimestamp } from '@renderer/lib/time'
import { useChatStore } from '@renderer/store/chatStore'
import { useUiStore } from '@renderer/store/uiStore'
import type { ChatSummary } from '@shared/ipc/contract'

/** Group key for chats that don't belong to any project. */
const UNFILED = '__unfiled__'

/** Newest-activity-first ordering for chats within a project folder. */
function byRecency(a: ChatSummary, b: ChatSummary): number {
  const at = a.lastMessageAt ?? a.updated_at
  const bt = b.lastMessageAt ?? b.updated_at
  return bt.localeCompare(at)
}

/**
 * The PROJECTS panel: each project is a collapsible folder whose chats are
 * nested underneath (with a recency stamp), plus an "Unfiled" group for chats
 * with no project. Picking a folder sets the active project scope; "New chat"
 * opens a fresh chat in it. The active chat is highlighted.
 */
export function ProjectsPanel(): JSX.Element {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const projects = useUiStore((s) => s.projects)
  const activeProjectId = useUiStore((s) => s.activeProjectId)
  const setActiveProject = useUiStore((s) => s.setActiveProject)
  const loadProjects = useUiStore((s) => s.loadProjects)
  const selectedProvider = useUiStore((s) => s.selectedProvider)
  const selectedModel = useUiStore((s) => s.selectedModel)
  const chatsVersion = useChatStore((s) => s.chatsVersion)
  const bumpChats = useChatStore((s) => s.bumpChats)

  const [chats, setChats] = useState<ChatSummary[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const newNameRef = useRef<HTMLInputElement>(null)

  const activeChatId = pathname.startsWith('/chats/') ? pathname.slice('/chats/'.length) : null

  // Load all chats (with project_id) for the tree; refresh on navigation so a
  // new/renamed chat shows up without a manual reload.
  const refresh = useCallback(async (): Promise<void> => {
    try {
      const list = await window.sunny.chats.list({})
      setChats(list)
    } catch {
      // Non-fatal — keep the last good tree.
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh, pathname, chatsVersion])

  async function handleDeleteChat(id: string): Promise<void> {
    try {
      await window.sunny.chats.delete({ chatId: id })
      bumpChats()
      if (id === activeChatId) navigate('/')
    } finally {
      setConfirmDeleteId(null)
    }
  }

  // Chats grouped by project id (or UNFILED). A chat whose project is unknown
  // here (none, or an archived project not in the loaded list) falls to Unfiled
  // so it's never hidden.
  const grouped = useMemo(() => {
    const known = new Set(projects.map((p) => p.id))
    const map = new Map<string, ChatSummary[]>()
    for (const c of chats) {
      const key = c.project_id && known.has(c.project_id) ? c.project_id : UNFILED
      const arr = map.get(key)
      if (arr) arr.push(c)
      else map.set(key, [c])
    }
    for (const arr of map.values()) arr.sort(byRecency)
    return map
  }, [chats, projects])

  // Keep the active chat's project (and the active project) expanded.
  useEffect(() => {
    const activeChat = chats.find((c) => c.id === activeChatId)
    const toOpen = activeChat?.project_id ?? (activeChat ? UNFILED : null)
    if (toOpen) setExpanded((prev) => (prev.has(toOpen) ? prev : new Set(prev).add(toOpen)))
  }, [activeChatId, chats])

  useEffect(() => {
    if (activeProjectId) {
      setExpanded((prev) => (prev.has(activeProjectId) ? prev : new Set(prev).add(activeProjectId)))
    }
  }, [activeProjectId])

  useEffect(() => {
    if (creating) newNameRef.current?.focus()
  }, [creating])

  function toggle(key: string): void {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  async function handleNewChat(): Promise<void> {
    const chat = await window.sunny.chats.create({
      projectId: activeProjectId ?? undefined,
      provider: selectedProvider ?? undefined,
      model: selectedModel ?? undefined
    })
    await refresh()
    navigate(`/chats/${chat.id}`)
  }

  async function handleCreateProject(e: FormEvent): Promise<void> {
    e.preventDefault()
    const name = newName.trim()
    if (!name) return
    try {
      const project = await window.sunny.projects.create({ name })
      await loadProjects()
      setActiveProject(project.id)
      setExpanded((prev) => new Set(prev).add(project.id))
    } finally {
      setNewName('')
      setCreating(false)
    }
  }

  const unfiled = grouped.get(UNFILED) ?? []

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-r border-ink-700/60 bg-ink-900">
      <div className="flex items-center justify-between gap-2 px-4 pb-2 pt-4">
        <span className="text-xs font-bold uppercase tracking-widest text-fg-subtle">Projects</span>
        <button
          type="button"
          onClick={() => setCreating((v) => !v)}
          aria-label="New project"
          title="New project"
          className="flex h-6 w-6 items-center justify-center rounded-lg text-fg-subtle transition-colors hover:bg-ink-800 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      {creating ? (
        <form onSubmit={handleCreateProject} className="px-3 pb-2">
          <input
            ref={newNameRef}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setCreating(false)
                setNewName('')
              }
            }}
            placeholder="Project name…"
            aria-label="New project name"
            className="w-full rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1.5 text-sm text-fg placeholder:text-fg-subtle focus:border-amber-400/50 focus:outline-none focus:ring-2 focus:ring-amber-400/30"
          />
        </form>
      ) : null}

      <div className="px-3 pb-2">
        <button
          type="button"
          onClick={() => void handleNewChat()}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-amber-400 px-3 py-2 text-sm font-semibold text-ink-950 shadow-glow transition-colors hover:bg-amber-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          New Chat
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-4">
        {projects.map((project) => {
          const projectChats = grouped.get(project.id) ?? []
          return (
            <ProjectFolder
              key={project.id}
              name={project.name}
              count={projectChats.length}
              open={expanded.has(project.id)}
              active={activeProjectId === project.id}
              chats={projectChats}
              activeChatId={activeChatId}
              confirmDeleteId={confirmDeleteId}
              onRequestDelete={setConfirmDeleteId}
              onCancelDelete={() => setConfirmDeleteId(null)}
              onConfirmDelete={(id) => void handleDeleteChat(id)}
              onToggle={() => {
                toggle(project.id)
                setActiveProject(project.id)
              }}
            />
          )
        })}

        {unfiled.length > 0 ? (
          <ProjectFolder
            name="Unfiled"
            count={unfiled.length}
            open={expanded.has(UNFILED)}
            active={activeProjectId === null}
            chats={unfiled}
            activeChatId={activeChatId}
            confirmDeleteId={confirmDeleteId}
            onRequestDelete={setConfirmDeleteId}
            onCancelDelete={() => setConfirmDeleteId(null)}
            onConfirmDelete={(id) => void handleDeleteChat(id)}
            onToggle={() => {
              toggle(UNFILED)
              setActiveProject(null)
            }}
          />
        ) : null}

        {projects.length === 0 && unfiled.length === 0 ? (
          <p className="px-3 pt-4 text-xs leading-relaxed text-fg-subtle">
            No projects yet. Create one with ＋, or start a chat — it lands in Unfiled.
          </p>
        ) : null}
      </div>
    </aside>
  )
}

interface ProjectFolderProps {
  name: string
  count: number
  open: boolean
  active: boolean
  chats: ChatSummary[]
  activeChatId: string | null
  confirmDeleteId: string | null
  onRequestDelete: (id: string) => void
  onCancelDelete: () => void
  onConfirmDelete: (id: string) => void
  onToggle: () => void
}

/** One collapsible project folder row + its nested chats when open. */
function ProjectFolder({
  name,
  count,
  open,
  active,
  chats,
  activeChatId,
  confirmDeleteId,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
  onToggle
}: ProjectFolderProps): JSX.Element {
  return (
    <div className="mb-0.5">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={cn(
          'flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm font-semibold transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
          active ? 'text-fg-heading' : 'text-fg-muted hover:bg-ink-850 hover:text-fg'
        )}
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
        )}
        <Folder className="h-4 w-4 shrink-0 text-amber-300/80" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{name}</span>
        <span className="shrink-0 rounded-md bg-ink-800 px-1.5 text-xs font-medium text-fg-subtle">
          {count}
        </span>
      </button>

      {open ? (
        <ul className="mb-1 mt-0.5 flex flex-col">
          {chats.length === 0 ? (
            <li className="py-1.5 pl-9 pr-2 text-xs text-fg-subtle">No chats yet</li>
          ) : (
            chats.map((chat) => {
              const isActive = chat.id === activeChatId
              const confirming = confirmDeleteId === chat.id
              return (
                <li key={chat.id} className="group/row relative">
                  <Link
                    to={`/chats/${chat.id}`}
                    title={chat.title ?? 'Untitled chat'}
                    className={cn(
                      'relative flex items-center gap-2 rounded-lg py-1.5 pl-9 pr-2 text-sm transition-colors',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
                      isActive
                        ? 'bg-amber-400/10 text-amber-200'
                        : 'text-fg-muted hover:bg-ink-850 hover:text-fg'
                    )}
                  >
                    {isActive ? (
                      <span
                        className="absolute inset-y-1 left-1 w-0.5 rounded-full bg-amber-400"
                        aria-hidden="true"
                      />
                    ) : null}
                    <MessageSquare className="h-3.5 w-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">{chat.title ?? 'Untitled chat'}</span>
                    <span
                      className={cn(
                        'shrink-0 text-[11px] text-fg-subtle',
                        // Hide the timestamp when the row's actions are showing.
                        'group-hover/row:invisible',
                        confirming ? 'invisible' : ''
                      )}
                    >
                      {compactTimestamp(chat.lastMessageAt ?? chat.updated_at)}
                    </span>
                  </Link>

                  {/* Delete affordance: a trash icon on hover, then an inline confirm. */}
                  <div className="absolute inset-y-0 right-1 flex items-center gap-0.5">
                    {confirming ? (
                      <>
                        <button
                          type="button"
                          aria-label="Confirm delete"
                          onClick={() => onConfirmDelete(chat.id)}
                          className="flex h-6 w-6 items-center justify-center rounded-md text-status-blocked hover:bg-status-blocked/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
                        >
                          <Check className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          aria-label="Cancel delete"
                          onClick={onCancelDelete}
                          className="flex h-6 w-6 items-center justify-center rounded-md text-fg-subtle hover:bg-ink-800 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
                        >
                          <X className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        aria-label={`Delete ${chat.title ?? 'chat'}`}
                        onClick={() => onRequestDelete(chat.id)}
                        className="hidden h-6 w-6 items-center justify-center rounded-md text-fg-subtle hover:bg-ink-800 hover:text-status-blocked focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60 group-hover/row:flex"
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </li>
              )
            })
          )}
        </ul>
      ) : null}
    </div>
  )
}
