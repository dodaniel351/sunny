import { Chip } from '@renderer/components/ui/Chip'
import { learnAction, quickActions, type QuickAction } from '@renderer/data/quickActions'
import { useUiStore } from '@renderer/store/uiStore'

/** Centered quick-action chip rows beneath the agent presets. */
export function QuickActions(): JSX.Element {
  const setComposerDraft = useUiStore((s) => s.setComposerDraft)

  /** Drop the chip's starter into the composer and move focus there to type. */
  function applyStarter({ starter }: QuickAction): void {
    setComposerDraft(starter)
    const composer = document.getElementById('composer')
    if (composer instanceof HTMLTextAreaElement) composer.focus()
  }

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="flex flex-wrap justify-center gap-2.5">
        {quickActions.map((action) => (
          <Chip
            key={action.id}
            aria-label={`Start a "${action.label}" prompt`}
            onClick={() => applyStarter(action)}
          >
            <action.icon className="h-4 w-4" aria-hidden="true" />
            {action.label}
          </Chip>
        ))}
      </div>
      <Chip
        aria-label={`Start an "${learnAction.label}" prompt`}
        onClick={() => applyStarter(learnAction)}
      >
        <learnAction.icon className="h-4 w-4" aria-hidden="true" />
        {learnAction.label}
      </Chip>
    </div>
  )
}
