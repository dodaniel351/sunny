import { type ReactNode } from 'react'

interface PageHeaderProps {
  title: string
  description?: string
  /** Optional trailing slot, e.g. an action button. */
  actions?: ReactNode
}

/** Consistent heading block for the dedicated routed views. */
export function PageHeader({ title, description, actions }: PageHeaderProps): JSX.Element {
  return (
    <header className="flex items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-fg-heading">{title}</h1>
        {description ? <p className="mt-1 text-sm text-fg-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  )
}
