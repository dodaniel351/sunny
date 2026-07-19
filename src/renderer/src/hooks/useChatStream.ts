import { useEffect } from 'react'
import { useChatStore } from '@renderer/store/chatStore'
import type { Message } from '@shared/db/types'

interface UseChatStreamOptions {
  /** Called when a stream completes with the persisted assistant message. */
  onDone: (streamId: string, message: Message) => void
}

/**
 * Subscribe ONCE to `chat.onStream` and fan events into the chat store by
 * streamId. Deltas accumulate into the matching buffer; `done` invokes the
 * caller's handler (which swaps in the persisted message and clears the
 * buffer); `error` is recorded on the buffer for inline display + retry.
 *
 * The handler is read through a ref so the subscription itself stays stable for
 * the component's lifetime (subscribe on mount, unsubscribe on unmount).
 */
export function useChatStream({ onDone }: UseChatStreamOptions): void {
  const appendDelta = useChatStore((s) => s.appendDelta)
  const appendThinking = useChatStore((s) => s.appendThinking)
  const setStreamStatus = useChatStore((s) => s.setStreamStatus)
  const failStream = useChatStore((s) => s.failStream)

  useEffect(() => {
    const unsubscribe = window.sunny.chat.onStream((event) => {
      switch (event.type) {
        case 'delta':
          appendDelta(event.streamId, event.text)
          break
        case 'thinking':
          // The model's reasoning — accumulates into the bubble's collapsible
          // "Thinking" section, separate from the answer text.
          appendThinking(event.streamId, event.text)
          break
        case 'status':
          // Transient progress (e.g. web-search). Shown live, never persisted.
          setStreamStatus(event.streamId, event.text)
          break
        case 'done':
          onDone(event.streamId, event.message)
          break
        case 'error':
          failStream(event.streamId, event.message)
          break
      }
    })
    return unsubscribe
  }, [appendDelta, appendThinking, setStreamStatus, failStream, onDone])
}
