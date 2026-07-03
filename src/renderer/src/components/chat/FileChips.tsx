import { Download, FileText } from 'lucide-react'
import { formatKb, type FileAttachmentRef } from '@renderer/lib/attachments'
import { cn } from '@renderer/lib/cn'

interface FileChipsProps {
  files: FileAttachmentRef[]
  className?: string
}

/**
 * Download chips for files an agent generated (the create_file tool). Click the
 * name to Open in the OS default app, or the download icon to Save a copy.
 */
export function FileChips({ files, className }: FileChipsProps): JSX.Element | null {
  if (files.length === 0) return null
  return (
    <div className={cn('flex flex-wrap gap-2', className)}>
      {files.map((f, i) => (
        <div
          key={`${f.path}-${i}`}
          className="inline-flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1.5"
        >
          <FileText className="h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" />
          <button
            type="button"
            onClick={() => void window.sunny.files.open({ path: f.path })}
            title="Open"
            className="max-w-[14rem] truncate text-xs font-medium text-fg transition-colors hover:text-amber-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
          >
            {f.name}
          </button>
          <span className="shrink-0 text-[10px] uppercase tracking-wide text-fg-subtle">
            {f.format}
            {f.bytes ? ` · ${formatKb(f.bytes)}` : ''}
          </span>
          <button
            type="button"
            onClick={() => void window.sunny.files.saveAs({ path: f.path, name: f.name })}
            aria-label={`Save a copy of ${f.name}`}
            title="Save a copy"
            className="shrink-0 rounded p-0.5 text-fg-subtle transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  )
}
