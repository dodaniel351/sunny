// Agent tool ids + groups, shared by the main process (which enforces the
// allowlist + permission gating) and the renderer (the AgentForm checkboxes).
// Renderer-safe: NO native/electron imports — plain constants only.
//
// An agent's `allowed_tools` column stores a flat array of these tool ids. The
// AgentForm presents them as GROUPS (read / write / shell); the helpers below
// convert between the group view and the stored flat id list. Web search is NOT
// here — it's governed by the per-message/per-agent web toggle, not allowed_tools.

export const TOOL_IDS = {
  readFile: 'read_file',
  listDir: 'list_dir',
  glob: 'glob',
  writeFile: 'write_file',
  editFile: 'edit_file',
  runCommand: 'run_command',
  createFile: 'create_file',
  listTasks: 'list_tasks',
  createTask: 'create_task',
  updateTask: 'update_task',
  addTaskDependency: 'add_task_dependency',
  // Sentinel id enabling ALL connected MCP-server tools for an agent — the
  // actual tool names (`mcp__<server>__<tool>`) are dynamic, so the allowlist
  // stores this one opt-in id instead of per-tool entries.
  mcpTools: 'mcp_tools'
} as const

export type AgentToolId = (typeof TOOL_IDS)[keyof typeof TOOL_IDS]

export interface AgentToolGroup {
  id: 'fs_read' | 'fs_write' | 'shell' | 'documents' | 'board' | 'mcp'
  label: string
  description: string
  /** True for groups that can change the filesystem / run code (gated harder). */
  sideEffecting: boolean
  tools: AgentToolId[]
}

// The groups shown as checkboxes in the agent editor. Read is the safe default;
// write and shell are opt-in. Shell additionally needs a permission-mode gate.
export const AGENT_TOOL_GROUPS: AgentToolGroup[] = [
  {
    id: 'fs_read',
    label: 'Read & search files',
    description: 'Read files and list/search the workspace folder (read-only).',
    sideEffecting: false,
    tools: [TOOL_IDS.readFile, TOOL_IDS.listDir, TOOL_IDS.glob]
  },
  {
    id: 'fs_write',
    label: 'Write & edit files',
    description: 'Create and modify files inside the workspace folder.',
    sideEffecting: true,
    tools: [TOOL_IDS.writeFile, TOOL_IDS.editFile]
  },
  {
    id: 'shell',
    label: 'Run shell commands',
    description: 'Run commands in the workspace folder. Confirmed in Ask mode.',
    sideEffecting: true,
    tools: [TOOL_IDS.runCommand]
  },
  {
    id: 'documents',
    label: 'Create documents',
    description:
      'Generate downloadable files for the user — md, txt, csv, html, docx, xlsx, pdf. ' +
      'Saved to Sunny and attached to the reply; no workspace needed.',
    sideEffecting: false,
    tools: [TOOL_IDS.createFile]
  },
  {
    id: 'board',
    label: 'Board & tasks',
    description:
      'Create, inspect, and update Kanban tasks — lets a manager agent run its own work queue.',
    sideEffecting: true,
    tools: [
      TOOL_IDS.listTasks,
      TOOL_IDS.createTask,
      TOOL_IDS.updateTask,
      TOOL_IDS.addTaskDependency
    ]
  },
  {
    id: 'mcp',
    label: 'External tools (MCP)',
    description:
      'Tools from connected MCP servers (Settings → MCP servers) — email, GitHub, databases, ' +
      'and more. Side-effecting calls are gated like writes/commands.',
    sideEffecting: true,
    tools: [TOOL_IDS.mcpTools]
  }
]

/** Expand a set of group ids into the flat tool-id list stored on the agent. */
export function toolsFromGroups(groupIds: string[]): AgentToolId[] {
  const out: AgentToolId[] = []
  for (const group of AGENT_TOOL_GROUPS) {
    if (groupIds.includes(group.id)) out.push(...group.tools)
  }
  return out
}

/** Which groups are fully enabled given a stored flat tool-id list. */
export function groupsFromTools(toolIds: string[] | null | undefined): string[] {
  const set = new Set(toolIds ?? [])
  return AGENT_TOOL_GROUPS.filter((g) => g.tools.every((t) => set.has(t))).map((g) => g.id)
}
