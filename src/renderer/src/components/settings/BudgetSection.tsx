import { RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Spinner } from '@renderer/components/ui/Spinner'
import { cn } from '@renderer/lib/cn'
import type { CostsSummaryResult } from '@shared/ipc/contract'

/** Setting key for the hard monthly spend cap (empty/unset = no limit). */
const BUDGET_KEY = 'budget_monthly_usd'

const usdFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
})

const compactFormatter = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1
})

function formatTokens(n: number): string {
  return `${compactFormatter.format(n)} tok`
}

/**
 * Budget & spend (structure layer) — shows month-to-date estimated cost (from
 * `src/main/costs/pricing.ts` list-price estimates) and lets the user set a
 * hard monthly cap the autonomous worker checks before starting new runs.
 *
 * The summary comes from `costs:summary`, which the orchestrator wires up
 * alongside per-run cost recording; until that lands (or if it ever fails) this
 * degrades to "unavailable" rather than throwing, so the section is always safe
 * to render. The budget input writes the `budget_monthly_usd` setting directly
 * — the orchestrator allowlists it and the worker reads it before each run.
 */
export function BudgetSection(): JSX.Element {
  const [summary, setSummary] = useState<CostsSummaryResult | null>(null)
  const [summaryLoading, setSummaryLoading] = useState(true)
  const [summaryUnavailable, setSummaryUnavailable] = useState(false)

  const [budgetInput, setBudgetInput] = useState('')
  const [budgetLoaded, setBudgetLoaded] = useState(false)
  const [budgetSaving, setBudgetSaving] = useState(false)
  const [budgetError, setBudgetError] = useState<string | null>(null)

  const loadSummary = useCallback(() => {
    setSummaryLoading(true)
    setSummaryUnavailable(false)
    window.sunny.costs
      .summary()
      .then((res) => setSummary(res))
      .catch(() => setSummaryUnavailable(true))
      .finally(() => setSummaryLoading(false))
  }, [])

  // Poll on mount only — the Refresh button re-triggers it on demand.
  useEffect(() => {
    loadSummary()
  }, [loadSummary])

  useEffect(() => {
    let cancelled = false
    window.sunny.settings
      .get({ key: BUDGET_KEY })
      .then((res) => {
        if (cancelled) return
        setBudgetInput(res.value ?? '')
        setBudgetLoaded(true)
      })
      .catch(() => {
        if (cancelled) return
        setBudgetLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function saveBudget(value: string): Promise<void> {
    setBudgetSaving(true)
    setBudgetError(null)
    try {
      const res = await window.sunny.settings.set({ key: BUDGET_KEY, value: value.trim() })
      if (!res.ok) {
        setBudgetError('Could not save the monthly budget.')
        return
      }
      setBudgetInput(value.trim())
      // Reflect the new cap immediately without waiting for a manual refresh.
      loadSummary()
    } catch (err: unknown) {
      setBudgetError(err instanceof Error ? err.message : 'Could not save the monthly budget.')
    } finally {
      setBudgetSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="text-xs text-fg-subtle">
        Costs are <span className="font-medium text-fg">estimates</span> based on published list
        prices, not your actual bill — org discounts or committed-use pricing aren&apos;t
        reflected. Models with no known price (Groq, OpenRouter, xAI, Perplexity) count as $0
        toward this total, so estimated spend can undercount if you use those. When the monthly
        limit is reached, autonomous runs pause — new work parks as{' '}
        <span className="font-medium text-fg">Blocked</span> until the month rolls over or you
        raise the limit.
      </p>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-fg-muted">Month-to-date spend</span>
          <button
            type="button"
            onClick={loadSummary}
            disabled={summaryLoading}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md border border-ink-700 px-2 py-1 text-xs font-medium text-fg-muted',
              'transition-colors hover:border-ink-600 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
              'disabled:cursor-not-allowed disabled:opacity-40'
            )}
          >
            {summaryLoading ? (
              <Spinner className="h-3.5 w-3.5" label="Refreshing" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            Refresh
          </button>
        </div>

        {summaryLoading && !summary ? (
          <span className="inline-flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-xs text-fg-subtle">
            <Spinner className="h-3.5 w-3.5" label="Loading spend summary" />
            Loading…
          </span>
        ) : summaryUnavailable && !summary ? (
          <span className="rounded-lg border border-dashed border-ink-700 bg-ink-900/40 px-3 py-2 text-xs text-fg-subtle">
            Spend summary unavailable right now — this doesn&apos;t affect the budget limit below.
          </span>
        ) : summary ? (
          <div className="flex items-baseline gap-3 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2.5">
            <span className="text-lg font-semibold text-fg-heading">
              {usdFormatter.format(summary.monthUsd)}
            </span>
            <span className="text-xs text-fg-subtle">
              {formatTokens(summary.monthTokensIn)} in / {formatTokens(summary.monthTokensOut)} out
            </span>
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="budget-monthly-usd" className="text-xs font-medium text-fg-muted">
          Monthly budget (USD)
        </label>
        <div className="flex items-center gap-3">
          <input
            id="budget-monthly-usd"
            type="number"
            min={0}
            step="0.01"
            inputMode="decimal"
            placeholder="No limit"
            disabled={!budgetLoaded || budgetSaving}
            value={budgetInput}
            onChange={(e) => setBudgetInput(e.target.value)}
            onBlur={() => void saveBudget(budgetInput)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
            }}
            className={cn(
              'w-40 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-fg',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
              'disabled:cursor-not-allowed disabled:opacity-50'
            )}
          />
          <button
            type="button"
            onClick={() => void saveBudget('')}
            disabled={!budgetLoaded || budgetSaving || !budgetInput}
            className={cn(
              'inline-flex items-center rounded-lg border border-ink-700 px-4 py-2 text-sm font-medium text-fg-muted',
              'transition-colors hover:border-ink-600 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
              'disabled:cursor-not-allowed disabled:opacity-40'
            )}
          >
            Clear
          </button>
          {budgetSaving ? <Spinner className="h-4 w-4" label="Saving" /> : null}
        </div>
        <span className="text-xs text-fg-subtle">Leave empty for no limit.</span>
      </div>

      {budgetError ? (
        <p className="text-xs text-status-blocked" role="alert">
          {budgetError}
        </p>
      ) : null}
    </div>
  )
}
