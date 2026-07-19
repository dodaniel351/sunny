import { create } from 'zustand'
import type { ImageAttachment } from '@shared/ipc/contract'

/** A single in-flight streaming assistant turn, keyed by its streamId. */
export interface StreamBuffer {
  streamId: string
  chatId: string
  /** Text accumulated from `delta` events so far. */
  text: string
  /** Reasoning accumulated from `thinking` events — rendered in the bubble's
   *  collapsible "Thinking" section, never merged into the answer text. */
  thinking: string
  /**
   * Transient progress text from `status` events (e.g. "🔎 Searching the web…").
   * Shown live near the streaming bubble but NEVER appended to the saved answer;
   * cleared when the next `delta` arrives or on done/error.
   */
  status: string | null
  /** Set when a `done` event arrives — the bubble is then replaced by the
   * persisted message and the buffer is cleared by the chat view. */
  done: boolean
  /** Set when an `error` event arrives; surfaced inline so the user can retry. */
  error: string | null
}

/** A working folder bound to a chat ("Chat in Folder"). */
export interface ChatFolder {
  path: string
  name: string
}

interface ChatState {
  /** Active stream buffers keyed by streamId (only in-flight streams live here). */
  streams: Record<string, StreamBuffer>
  /**
   * A first message handed off from the dashboard composer to a freshly created
   * chat. The chat view consumes it once on mount, then clears it.
   */
  pendingFirstMessage: {
    chatId: string
    content: string
    images?: ImageAttachment[]
    /** Whether the dashboard composer had web search toggled on for this turn. */
    webSearch?: boolean
  } | null
  /** The working folder per chat, injected as context on every send for that chat. */
  chatFolders: Record<string, ChatFolder>
  /**
   * A folder chosen on the dashboard before the chat exists. The chat view
   * consumes it once on mount into `chatFolders`, then clears it (mirrors
   * `pendingFirstMessage`).
   */
  pendingFolder: ChatFolder | null
  startStream: (streamId: string, chatId: string) => void
  appendDelta: (streamId: string, text: string) => void
  /** Append reasoning text from a `thinking` event to the buffer. */
  appendThinking: (streamId: string, text: string) => void
  /** Record the latest transient status text (web-search progress, etc.). */
  setStreamStatus: (streamId: string, status: string) => void
  failStream: (streamId: string, error: string) => void
  clearStream: (streamId: string) => void
  setPendingFirstMessage: (
    chatId: string,
    content: string,
    images?: ImageAttachment[],
    webSearch?: boolean
  ) => void
  consumePendingFirstMessage: (
    chatId: string
  ) => { content: string; images: ImageAttachment[]; webSearch: boolean } | null
  setChatFolder: (chatId: string, folder: ChatFolder | null) => void
  setPendingFolder: (folder: ChatFolder | null) => void
  consumePendingFolder: () => ChatFolder | null
  /** Bumped whenever a chat is created/renamed/moved/deleted so the Projects
   *  tree re-fetches even when the route doesn't change. */
  chatsVersion: number
  bumpChats: () => void
}

/** Streaming-state store: per-chat assistant buffers + the dashboard handoff. */
export const useChatStore = create<ChatState>((set, get) => ({
  streams: {},
  chatsVersion: 0,
  bumpChats: () => set((s) => ({ chatsVersion: s.chatsVersion + 1 })),
  pendingFirstMessage: null,
  chatFolders: {},
  pendingFolder: null,
  startStream: (streamId, chatId) =>
    set((state) => ({
      streams: {
        ...state.streams,
        [streamId]: {
          streamId,
          chatId,
          text: '',
          thinking: '',
          status: null,
          done: false,
          error: null
        }
      }
    })),
  appendDelta: (streamId, text) =>
    set((state) => {
      const existing = state.streams[streamId]
      if (!existing) return state
      // Real answer text is arriving — clear any transient status line.
      return {
        streams: {
          ...state.streams,
          [streamId]: { ...existing, text: existing.text + text, status: null }
        }
      }
    }),
  appendThinking: (streamId, text) =>
    set((state) => {
      const existing = state.streams[streamId]
      if (!existing) return state
      return {
        streams: {
          ...state.streams,
          [streamId]: { ...existing, thinking: existing.thinking + text }
        }
      }
    }),
  setStreamStatus: (streamId, status) =>
    set((state) => {
      const existing = state.streams[streamId]
      if (!existing) return state
      return { streams: { ...state.streams, [streamId]: { ...existing, status } } }
    }),
  failStream: (streamId, error) =>
    set((state) => {
      const existing = state.streams[streamId]
      if (!existing) return state
      return { streams: { ...state.streams, [streamId]: { ...existing, error } } }
    }),
  clearStream: (streamId) =>
    set((state) => {
      if (!state.streams[streamId]) return state
      const next = { ...state.streams }
      delete next[streamId]
      return { streams: next }
    }),
  setPendingFirstMessage: (chatId, content, images, webSearch) =>
    set({ pendingFirstMessage: { chatId, content, images, webSearch } }),
  consumePendingFirstMessage: (chatId) => {
    const pending = get().pendingFirstMessage
    if (!pending || pending.chatId !== chatId) return null
    set({ pendingFirstMessage: null })
    return {
      content: pending.content,
      images: pending.images ?? [],
      webSearch: pending.webSearch ?? false
    }
  },
  setChatFolder: (chatId, folder) =>
    set((state) => {
      if (folder) {
        return { chatFolders: { ...state.chatFolders, [chatId]: folder } }
      }
      if (!state.chatFolders[chatId]) return state
      const next = { ...state.chatFolders }
      delete next[chatId]
      return { chatFolders: next }
    }),
  setPendingFolder: (folder) => set({ pendingFolder: folder }),
  consumePendingFolder: () => {
    const pending = get().pendingFolder
    if (!pending) return null
    set({ pendingFolder: null })
    return pending
  }
}))
