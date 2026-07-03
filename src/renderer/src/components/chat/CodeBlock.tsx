import 'highlight.js/styles/github-dark.css'
import hljs from 'highlight.js/lib/common'
import { Check, Copy } from 'lucide-react'
import { useMemo, useState } from 'react'

interface CodeBlockProps {
  code: string
  language?: string
  /** While the message is mid-stream, skip highlighting (see below). */
  streaming?: boolean
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * A fenced code block rendered as a code window: a header with the language and a
 * copy button, and syntax-highlighted body (highlight.js, github-dark theme). The
 * copy button copies the raw code. Used by the chat Markdown renderer.
 *
 * While `streaming`, the body renders as escaped plaintext rather than running
 * highlight.js — an untagged fence would otherwise re-run `hljs.highlightAuto`
 * (~37 grammars) over the whole growing block on every delta. Highlighting
 * happens once on the final (non-streaming) render.
 */
export function CodeBlock({ code, language, streaming = false }: CodeBlockProps): JSX.Element {
  const [copied, setCopied] = useState(false)

  const { html, lang } = useMemo(() => {
    if (streaming) return { html: escapeHtml(code), lang: language ?? '' }
    const known = language && hljs.getLanguage(language) ? language : undefined
    try {
      const res = known
        ? hljs.highlight(code, { language: known })
        : hljs.highlightAuto(code)
      return { html: res.value, lang: known ?? res.language ?? '' }
    } catch {
      return { html: escapeHtml(code), lang: language ?? '' }
    }
  }, [code, language, streaming])

  async function handleCopy(): Promise<void> {
    try {
      await window.sunny.clipboard.writeText(code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // non-fatal
    }
  }

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-ink-700">
      <div className="flex items-center justify-between border-b border-ink-700 bg-ink-900 px-3 py-1">
        <span className="font-mono text-[10px] uppercase tracking-wide text-fg-subtle">
          {lang || 'code'}
        </span>
        <button
          type="button"
          onClick={() => void handleCopy()}
          className="flex items-center gap-1 rounded px-1 text-[10px] font-medium text-fg-subtle transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
        >
          {copied ? (
            <Check className="h-3 w-3 text-status-success" aria-hidden="true" />
          ) : (
            <Copy className="h-3 w-3" aria-hidden="true" />
          )}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="hljs overflow-x-auto px-3 py-2.5 text-xs leading-relaxed">
        <code dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  )
}
