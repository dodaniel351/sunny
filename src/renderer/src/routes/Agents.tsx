import { AgentsLibrary } from '@renderer/components/agents/AgentsLibrary'

/** Agent library — presets plus user-created configurations (spec §7). */
export function Agents(): JSX.Element {
  return (
    <div className="mx-auto w-full max-w-5xl px-8 py-10">
      <AgentsLibrary />
    </div>
  )
}
