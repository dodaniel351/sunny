import type { ProviderStatus } from '@shared/ipc/contract'

// Shared "is this provider/model actually pickable" predicates. These were
// duplicated across uiStore, ModelSelector, DefaultModelSection, and (missing
// from) ScheduleForm; centralizing them keeps every picker's notion of "usable"
// identical. Pure functions over ProviderStatus — no store, no IPC.

/** A provider is pickable only when connected AND toggled on by the user. */
export function isUsableProvider(p: ProviderStatus): boolean {
  return p.connected && p.enabled
}

/** A model is pickable unless its id is in the provider's disabled list. */
export function isUsableModel(p: ProviderStatus, modelId: string): boolean {
  return !p.disabledModels.includes(modelId)
}

/** A provider's models minus any the user has switched off. */
export function usableModels(provider: ProviderStatus): ProviderStatus['models'] {
  return provider.models.filter((m) => isUsableModel(provider, m.id))
}

/** The provider's preferred model (its declared default if usable, else first usable). */
export function firstUsableModel(p: ProviderStatus): string | null {
  const preferred =
    p.models.find((m) => m.id === p.defaultModel && isUsableModel(p, p.defaultModel)) ??
    p.models.find((m) => isUsableModel(p, m.id))
  return preferred ? preferred.id : null
}
