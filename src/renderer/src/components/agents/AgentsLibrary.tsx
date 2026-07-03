import { Plus } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { PageHeader } from '@renderer/components/ui/PageHeader'
import { Spinner } from '@renderer/components/ui/Spinner'
import { useProviders } from '@renderer/hooks/useProviders'
import { cn } from '@renderer/lib/cn'
import type { Agent, AgentLifecycle } from '@shared/db/types'
import { AgentCard } from './AgentCard'
import { AgentForm, type AgentFormValues } from './AgentForm'
import { DeleteAgentDialog } from './DeleteAgentDialog'

/** Editor state: closed, creating, editing an agent, or duplicating a preset. */
type EditorState =
  | { mode: 'closed' }
  | { mode: 'create'; seed: Agent | null }
  | { mode: 'edit'; agent: Agent }

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong. Please try again.'
}

/**
 * The Agents library body (spec §7). Loads `agents.list()`, renders preset +
 * user agents in a grid alongside a create tile, and drives the create/edit and
 * delete flows. Presets are protected: they can be duplicated and edited but
 * not deleted.
 */
export function AgentsLibrary(): JSX.Element {
  // Ensure providers are loaded so the form's model picker has options.
  useProviders()

  const [agents, setAgents] = useState<Agent[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [editor, setEditor] = useState<EditorState>({ mode: 'closed' })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const [pendingDelete, setPendingDelete] = useState<Agent | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const loadAgents = useCallback(async (): Promise<void> => {
    try {
      const list = await window.sunny.agents.list()
      setAgents(list)
      setLoadError(null)
    } catch (err) {
      setLoadError(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadAgents()
  }, [loadAgents])

  function openCreate(): void {
    setSaveError(null)
    setEditor({ mode: 'create', seed: null })
  }

  function openEdit(agent: Agent): void {
    setSaveError(null)
    setEditor({ mode: 'edit', agent })
  }

  function openDuplicate(agent: Agent): void {
    setSaveError(null)
    // Seed the create form from a preset, renamed so it saves as a new agent.
    setEditor({
      mode: 'create',
      seed: { ...agent, id: '', is_preset: 0, name: `${agent.name} copy` }
    })
  }

  function closeEditor(): void {
    if (saving) return
    setEditor({ mode: 'closed' })
    setSaveError(null)
  }

  async function handleSubmit(values: AgentFormValues): Promise<void> {
    setSaving(true)
    setSaveError(null)
    try {
      if (editor.mode === 'edit') {
        await window.sunny.agents.update({
          id: editor.agent.id,
          name: values.name,
          role: values.role,
          systemPrompt: values.systemPrompt,
          provider: values.provider,
          model: values.model,
          permissionMode: values.permissionMode,
          webAccess: values.webAccess,
          allowedTools: values.allowedTools
        })
      } else {
        await window.sunny.agents.create({
          name: values.name,
          role: values.role ?? undefined,
          systemPrompt: values.systemPrompt ?? undefined,
          provider: values.provider ?? undefined,
          model: values.model ?? undefined,
          permissionMode: values.permissionMode,
          webAccess: values.webAccess,
          allowedTools: values.allowedTools
        })
      }
      await loadAgents()
      setEditor({ mode: 'closed' })
    } catch (err) {
      setSaveError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  function requestDelete(agent: Agent): void {
    setDeleteError(null)
    setPendingDelete(agent)
  }

  // Pause/resume/terminate an agent (governance lifecycle). Optimistic: reflect
  // the new state immediately, then reconcile from the server (revert on error).
  async function handleSetLifecycle(agent: Agent, state: AgentLifecycle): Promise<void> {
    setAgents((prev) => prev.map((a) => (a.id === agent.id ? { ...a, lifecycle_state: state } : a)))
    try {
      await window.sunny.agents.setLifecycle({ id: agent.id, state })
    } catch {
      await loadAgents()
    }
  }

  function cancelDelete(): void {
    if (deleting) return
    setPendingDelete(null)
    setDeleteError(null)
  }

  async function confirmDelete(): Promise<void> {
    if (!pendingDelete) return
    setDeleting(true)
    setDeleteError(null)
    try {
      await window.sunny.agents.delete({ id: pendingDelete.id })
      await loadAgents()
      setPendingDelete(null)
    } catch (err) {
      setDeleteError(errorMessage(err))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
      <PageHeader
        title="Agents"
        description="Named configurations — a role, a default model, an allowed tool set, and a permission mode."
        actions={
          <button
            type="button"
            onClick={openCreate}
            className="flex items-center gap-2 rounded-xl bg-amber-400 px-3.5 py-2 text-sm font-semibold text-ink-950 transition-colors hover:bg-amber-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            New Agent
          </button>
        }
      />

      {loadError ? (
        <div
          role="alert"
          className="mt-8 rounded-2xl border border-status-blocked/40 bg-status-blocked/5 px-4 py-3 text-sm text-status-blocked"
        >
          Couldn&apos;t load agents: {loadError}
        </div>
      ) : null}

      {loading ? (
        <div className="mt-12 flex items-center justify-center gap-2 text-sm text-fg-muted">
          <Spinner label="Loading agents" />
          Loading agents…
        </div>
      ) : (
        <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {agents.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              onEdit={openEdit}
              onDuplicate={openDuplicate}
              onDelete={requestDelete}
              onSetLifecycle={(a, state) => void handleSetLifecycle(a, state)}
            />
          ))}

          <button
            type="button"
            onClick={openCreate}
            className={cn(
              'flex min-h-[180px] flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-ink-700 bg-ink-850/40 p-5 text-fg-muted',
              'transition-colors hover:border-amber-400/40 hover:text-fg',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60'
            )}
          >
            <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-ink-700 bg-ink-800">
              <Plus className="h-5 w-5 text-amber-300" aria-hidden="true" />
            </span>
            <span className="text-sm font-semibold">Create agent</span>
          </button>
        </div>
      )}

      {editor.mode !== 'closed' ? (
        <AgentForm
          mode={editor.mode === 'edit' ? 'edit' : 'create'}
          agent={editor.mode === 'edit' ? editor.agent : editor.seed}
          saving={saving}
          error={saveError}
          onSubmit={(values) => void handleSubmit(values)}
          onClose={closeEditor}
        />
      ) : null}

      {pendingDelete ? (
        <DeleteAgentDialog
          agent={pendingDelete}
          deleting={deleting}
          error={deleteError}
          onConfirm={() => void confirmDelete()}
          onClose={cancelDelete}
        />
      ) : null}
    </>
  )
}
