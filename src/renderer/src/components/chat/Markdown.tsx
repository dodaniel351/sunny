import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { CodeBlock } from './CodeBlock'

// Markdown renderer for assistant chat turns. Element components are styled to
// match Sunny's dark theme; fenced code blocks render in a CodeBlock window with
// syntax coloring + copy. GitHub-flavored markdown (tables, task lists, strike,
// autolinks) via remark-gfm, plus remark-breaks so a single newline becomes a
// <br> (line-structured output from small local models keeps its breaks, like
// every other chat app). `pre` is a pass-through so CodeBlock owns the frame.

// The `code` renderer, parameterized by whether the message is mid-stream: while
// streaming, fenced blocks render as escaped plaintext (no per-delta highlight
// of a growing block); the final render highlights once. Inline code is
// unaffected.
function makeCodeRenderer(streaming: boolean): Components['code'] {
  const CodeRenderer: Components['code'] = ({ className, children }) => {
    const text = String(children ?? '')
    const match = /language-(\w+)/.exec(className ?? '')
    const isBlock = Boolean(match) || text.includes('\n')
    if (!isBlock) {
      return (
        <code className="rounded bg-ink-900 px-1 py-0.5 font-mono text-[0.85em] text-amber-200">
          {children}
        </code>
      )
    }
    return <CodeBlock code={text.replace(/\n$/, '')} language={match?.[1]} streaming={streaming} />
  }
  CodeRenderer.displayName = 'MarkdownCode'
  return CodeRenderer
}

const components: Components = {
  h1: ({ children }) => (
    <h1 className="mb-1.5 mt-3 text-base font-bold text-fg-heading first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-1.5 mt-3 text-[15px] font-bold text-fg-heading first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-1 mt-2.5 text-sm font-semibold text-fg-heading first:mt-0">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="mb-1 mt-2 text-sm font-semibold text-fg-muted first:mt-0">{children}</h4>
  ),
  p: ({ children }) => <p className="my-1.5 leading-relaxed first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-1.5 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-1.5 list-decimal space-y-1 pl-5">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-amber-300 underline-offset-2 hover:underline"
    >
      {children}
    </a>
  ),
  strong: ({ children }) => <strong className="font-semibold text-fg-heading">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  hr: () => <hr className="my-3 border-ink-700" />,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-amber-400/40 pl-3 text-fg-muted">
      {children}
    </blockquote>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-ink-700 bg-ink-900 px-2 py-1 text-left font-semibold text-fg-heading">
      {children}
    </th>
  ),
  td: ({ children }) => <td className="border border-ink-700 px-2 py-1 align-top">{children}</td>,
  // CodeBlock renders its own frame, so the surrounding <pre> just passes through.
  pre: ({ children }) => <>{children}</>,
  code: makeCodeRenderer(false)
}

// A parallel component map for a mid-stream bubble: identical except code blocks
// skip highlighting until the stream settles. Precomputed (not built per render)
// so both maps are stable references.
const streamingComponents: Components = {
  ...components,
  code: makeCodeRenderer(true)
}

const remarkPlugins = [remarkGfm, remarkBreaks]

/**
 * Render assistant message content as themed markdown with code windows.
 * `break-words` keeps a long unbroken token (a 300-char URL/JWT) inside the
 * bubble instead of painting past it.
 */
export function Markdown({
  content,
  streaming = false
}: {
  content: string
  streaming?: boolean
}): JSX.Element {
  return (
    <div className="break-words text-sm text-fg">
      <ReactMarkdown remarkPlugins={remarkPlugins} components={streaming ? streamingComponents : components}>
        {content}
      </ReactMarkdown>
    </div>
  )
}
