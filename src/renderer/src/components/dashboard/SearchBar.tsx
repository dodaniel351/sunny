import { Search } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useUiStore } from '@renderer/store/uiStore'

/**
 * Top knowledge-base search bar. Submitting (Enter) stages the typed query and
 * navigates to the Memory view, which seeds its search box from it once on
 * mount. Empty submissions still navigate to Memory with no filter applied.
 */
export function SearchBar(): JSX.Element {
  const navigate = useNavigate()
  const setPendingMemoryQuery = useUiStore((s) => s.setPendingMemoryQuery)
  const [value, setValue] = useState('')

  function handleSubmit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault()
    const query = value.trim()
    setPendingMemoryQuery(query.length > 0 ? query : null)
    navigate('/memory')
  }

  return (
    <form onSubmit={handleSubmit} className="relative" role="search">
      <Search
        className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle"
        aria-hidden="true"
      />
      <label htmlFor="kb-search" className="sr-only">
        Search knowledge base
      </label>
      <input
        id="kb-search"
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Search knowledge base…"
        className="w-full rounded-full border border-ink-700 bg-ink-850 py-2.5 pl-11 pr-4 text-sm text-fg placeholder:text-fg-subtle transition-colors focus:border-amber-400/50 focus:outline-none focus:ring-2 focus:ring-amber-400/30"
      />
    </form>
  )
}
