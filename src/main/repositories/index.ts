// Public barrel for the persistence/repository layer (spec §10). The main
// process constructs these against the live SunnyDatabase handle. DB type is
// imported type-only so this module never loads the native better-sqlite3
// binding — the handle is passed in at runtime.

import type { SunnyDatabase } from '@main/db'
import { ChatsRepo } from './chats'
import { MessagesRepo } from './messages'
import { ProvidersRepo } from './providers'
import { TasksRepo } from './tasks'
import { AgentsRepo } from './agents'
import { MemoriesRepo } from './memories'
import { SettingsRepo } from './settings'
import { MemoryGraphRepo } from './memory-graph'
import { ProjectsRepo } from './projects'
import { SchedulesRepo } from './schedules'
import { RunsRepo } from './runs'
import { ActivityRepo, type ActivitySink, type ActivityInput } from './activity'
import { GoalsRepo } from './goals'
import { TaskDependenciesRepo } from './task-dependencies'
import { ApprovalsRepo } from './approvals'

export { ChatsRepo } from './chats'
export type { ChatCreateInput } from './chats'
export { ProjectsRepo } from './projects'
export type { ProjectCreateInput, ProjectUpdateInput } from './projects'
export { SchedulesRepo } from './schedules'
export type { ScheduleCreateInput, ScheduleUpdateInput } from './schedules'
export { MessagesRepo } from './messages'
export type { MessageCreateInput } from './messages'
export { ProvidersRepo } from './providers'
export type { ProviderUpsertInput } from './providers'
export { TasksRepo } from './tasks'
export { AgentsRepo, DEFAULT_AGENT_PRESETS } from './agents'
export type { AgentPreset, AgentOrgNode } from './agents'
export { MemoriesRepo } from './memories'
export { SettingsRepo } from './settings'
export { MemoryGraphRepo, normalizeEntityName } from './memory-graph'
export { RunsRepo } from './runs'
export type { RunCreateInput, RunFinishInput } from './runs'
export { ActivityRepo } from './activity'
export type { ActivityInput, ActivitySink, ActivityListOptions } from './activity'
export { GoalsRepo } from './goals'
export type { GoalCreateInput, GoalUpdateInput, GoalNode } from './goals'
export { TaskDependenciesRepo } from './task-dependencies'
export type { TaskDependencyView } from './task-dependencies'
export { ApprovalsRepo } from './approvals'
export type { ApprovalRequestInput, ApprovalView, ApprovalListOptions } from './approvals'

export interface Repositories {
  chats: ChatsRepo
  messages: MessagesRepo
  providers: ProvidersRepo
  tasks: TasksRepo
  agents: AgentsRepo
  memories: MemoriesRepo
  settings: SettingsRepo
  memoryGraph: MemoryGraphRepo
  projects: ProjectsRepo
  schedules: SchedulesRepo
  runs: RunsRepo
  activity: ActivityRepo
  goals: GoalsRepo
  taskDependencies: TaskDependenciesRepo
  approvals: ApprovalsRepo
}

// Construct the repository set bound to one database connection.
//
// The activity log is wired as a write-side sink: mutating repos (tasks today)
// receive an `onActivity` callback they invoke after a successful write, INSIDE
// the same transaction, so the audit entry commits atomically with the change.
// Failures in the sink are swallowed — a missed audit line must never roll back
// the real mutation.
//
// `onChange` (optional) is a post-write notifier the main process uses to
// broadcast a live board refresh: it fires for the SAME events, after the audit
// row is recorded. Delivery is async (webContents.send just enqueues), and the
// mutation's transaction is synchronous, so any renderer refetch it triggers
// reads already-committed rows. Its errors are swallowed too.
export function createRepositories(
  db: SunnyDatabase,
  onChange?: (event: ActivityInput) => void
): Repositories {
  const activity = new ActivityRepo(db)
  const onActivity: ActivitySink = (event) => {
    try {
      activity.record(event)
    } catch (err) {
      console.error('[sunny] activity sink failed', event.kind, err)
    }
    try {
      onChange?.(event)
    } catch (err) {
      console.error('[sunny] change notifier failed', event.kind, err)
    }
  }
  return {
    chats: new ChatsRepo(db),
    messages: new MessagesRepo(db),
    providers: new ProvidersRepo(db),
    tasks: new TasksRepo(db, onActivity),
    agents: new AgentsRepo(db),
    memories: new MemoriesRepo(db),
    settings: new SettingsRepo(db),
    memoryGraph: new MemoryGraphRepo(db),
    projects: new ProjectsRepo(db),
    schedules: new SchedulesRepo(db),
    runs: new RunsRepo(db),
    activity,
    goals: new GoalsRepo(db),
    taskDependencies: new TaskDependenciesRepo(db),
    approvals: new ApprovalsRepo(db)
  }
}
