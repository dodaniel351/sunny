import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { join } from 'path'
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'

// Phase 1 smoke test: the app launches, the renderer mounts, and the IPC
// bridge round-trips. Phase 2 extends this to "add a key, send a message,
// get a streamed reply" (spec §11).

let app: ElectronApplication

test.beforeAll(async () => {
  app = await electron.launch({
    args: [join(__dirname, '../../out/main/index.js')],
    // SUNNY_ENABLE_FAKE_PROVIDER registers the network-free fake adapter so the
    // chat pipeline can be exercised end-to-end without a real API key.
    env: { ...process.env, NODE_ENV: 'test', CI: '1', SUNNY_ENABLE_FAKE_PROVIDER: '1' }
  })
})

test.afterAll(async () => {
  await app?.close()
})

test('app launches and renderer mounts', async () => {
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await expect(window.locator('#root')).toBeVisible()
  // The Phase 1 placeholder (or the dashboard shell that replaces it) renders
  // the Sunny brand somewhere in the tree.
  await expect(window.getByText(/Sunny/i).first()).toBeVisible()
})

test('IPC bridge round-trips (app:ping)', async () => {
  const window = await app.firstWindow()
  const result = await window.evaluate(async () => {
    // @ts-expect-error — window.sunny is injected by the preload bridge
    return window.sunny.ping()
  })
  expect(result.ok).toBe(true)
  expect(typeof result.version).toBe('string')
  expect(result.version.length).toBeGreaterThan(0)
})

test('database migrated and sqlite-vec is live', async () => {
  const window = await app.firstWindow()
  const health = await window.evaluate(async () => {
    // @ts-expect-error — injected by the preload bridge
    return window.sunny.db.health()
  })
  // Migrations applied (v1 schema), core tables present, vector extension loaded.
  expect(health.currentVersion).toBeGreaterThanOrEqual(1)
  expect(health.tables).toContain('tasks')
  expect(health.tables).toContain('memories')
  expect(health.tables).toContain('providers')
  expect(health.vecAvailable).toBe(true)
})

test('secret store round-trips through the OS keychain', async () => {
  const window = await app.firstWindow()
  const result = await window.evaluate(async () => {
    // @ts-expect-error — injected by the preload bridge
    return window.sunny.secrets.selfTest()
  })
  expect(result.ok).toBe(true)
  expect(result.roundTrip).toBe(true)
  expect(['keytar', 'safeStorage']).toContain(result.backend)
})

test('chat streams, persists, and reopens from history (fake provider)', async () => {
  const window = await app.firstWindow()
  const result = await window.evaluate(async () => {
    // @ts-expect-error — window.sunny is injected by the preload bridge
    const sunny = window.sunny
    await sunny.providers.saveKey({ kind: 'fake', apiKey: 'test-key' })
    const chat = await sunny.chats.create({ provider: 'fake', model: 'fake-1' })

    const deltas: string[] = []
    const finalMessage = await new Promise<{ role: string; content: string }>((resolve, reject) => {
      const off = sunny.chat.onStream((ev: { type: string; text?: string; message?: unknown }) => {
        if (ev.type === 'delta') deltas.push(ev.text)
        else if (ev.type === 'done') {
          off()
          resolve(ev.message)
        } else if (ev.type === 'error') {
          off()
          reject(new Error('stream error'))
        }
      })
      sunny.chat
        .send({ chatId: chat.id, content: 'Hello fake', model: 'fake-1' })
        .catch((e: Error) => reject(e))
    })

    const reopened = await sunny.chats.get({ chatId: chat.id })
    const list = await sunny.chats.list()
    const summary = list.find((c: { id: string }) => c.id === chat.id)
    return {
      deltaText: deltas.join(''),
      finalRole: finalMessage.role,
      finalContent: finalMessage.content,
      roles: reopened.messages.map((m: { role: string }) => m.role),
      messageCount: reopened.messages.length,
      title: reopened.chat.title,
      summaryCount: summary ? summary.messageCount : -1
    }
  })

  // Streamed deltas arrived and equal the persisted assistant content.
  expect(result.deltaText.length).toBeGreaterThan(0)
  expect(result.finalRole).toBe('assistant')
  expect(result.finalContent).toBe(result.deltaText)
  // Transcript persisted: user + assistant, reopenable, titled from first message.
  expect(result.roles).toEqual(['user', 'assistant'])
  expect(result.messageCount).toBe(2)
  expect(result.title).toBe('Hello fake')
  expect(result.summaryCount).toBe(2)
})

test('tasks, agents, memory, and settings work end-to-end', async () => {
  const window = await app.firstWindow()
  const result = await window.evaluate(async () => {
    // @ts-expect-error — window.sunny is injected by the preload bridge
    const sunny = window.sunny

    // Agents: the built-in presets are seeded on startup.
    const agents = await sunny.agents.list()

    // Tasks: create → move across columns → records an event → delete.
    const task = await sunny.tasks.create({ title: 'E2E task', status: 'Backlog' })
    const moved = await sunny.tasks.move({ id: task.id, status: 'Done' })
    const taskList = await sunny.tasks.list()
    const events = await sunny.tasks.events({ taskId: task.id })
    // Live Activity feed: recent transitions across all tasks, joined to titles.
    const activity = await sunny.tasks.activity({ limit: 10 })
    await sunny.tasks.delete({ id: task.id })
    const afterDelete = await sunny.tasks.list()

    // Memory: create → search by content → delete.
    const mem = await sunny.memories.create({ content: 'Remember xyz123', scope: 'global', kind: 'fact' })
    const found = await sunny.memories.list({ query: 'xyz123' })
    await sunny.memories.delete({ id: mem.id })

    // Settings: set → get (use an allowlisted key); data paths report the DB location.
    await sunny.settings.set({ key: 'standing_instructions', value: 'hello' })
    const got = await sunny.settings.get({ key: 'standing_instructions' })
    const paths = await sunny.settings.dataPaths()

    return {
      presetCount: agents.filter((a: { is_preset: number }) => a.is_preset === 1).length,
      hasCowork: agents.some((a: { name: string }) => a.name === 'Cowork'),
      movedStatus: moved.status,
      taskInList: taskList.some((t: { id: string }) => t.id === task.id),
      eventCount: events.length,
      activityHasTask: activity.some(
        (a: { task_id: string; task_title: string; to_status: string }) =>
          a.task_id === task.id && typeof a.task_title === 'string' && Boolean(a.to_status)
      ),
      taskGone: !afterDelete.some((t: { id: string }) => t.id === task.id),
      memFound: found.some((m: { id: string }) => m.id === mem.id),
      settingValue: got.value,
      hasDbPath: typeof paths.dbPath === 'string' && paths.dbPath.length > 0,
      secretsBackend: paths.secretsBackend
    }
  })

  expect(result.presetCount).toBeGreaterThanOrEqual(5)
  expect(result.hasCowork).toBe(true)
  expect(result.movedStatus).toBe('Done')
  expect(result.taskInList).toBe(true)
  expect(result.eventCount).toBeGreaterThanOrEqual(1)
  expect(result.activityHasTask).toBe(true)
  expect(result.taskGone).toBe(true)
  expect(result.memFound).toBe(true)
  expect(result.settingValue).toBe('hello')
  expect(result.hasDbPath).toBe(true)
})

test('memory graph surface works (status, graph, auto-toggle)', async () => {
  const window = await app.firstWindow()
  const result = await window.evaluate(async () => {
    // @ts-expect-error — window.sunny is injected by the preload bridge
    const sunny = window.sunny
    // status() + graph() query the migration-002 tables; succeeding proves they exist.
    const status1 = await sunny.memories.status()
    const graph = await sunny.memories.graph({})
    await sunny.memories.setAuto({ enabled: false })
    const off = await sunny.memories.status()
    await sunny.memories.setAuto({ enabled: true })
    const on = await sunny.memories.status()
    return {
      hasCounts:
        typeof status1.entityCount === 'number' &&
        typeof status1.relationCount === 'number' &&
        typeof status1.observationCount === 'number',
      graphShape: Array.isArray(graph.entities) && Array.isArray(graph.relations),
      toggledOff: off.autoMemory,
      toggledOn: on.autoMemory
    }
  })
  expect(result.hasCounts).toBe(true)
  expect(result.graphShape).toBe(true)
  expect(result.toggledOff).toBe(false)
  expect(result.toggledOn).toBe(true)
})

test('provider/model toggles, agent-scoped chat, and task assignment persist', async () => {
  const window = await app.firstWindow()
  const result = await window.evaluate(async () => {
    // @ts-expect-error — window.sunny is injected by the preload bridge
    const sunny = window.sunny

    // Provider on/off toggle (keeps credentials) — use the e2e fake provider.
    await sunny.providers.setEnabled({ kind: 'fake', enabled: false })
    const listOff = await sunny.providers.list()
    const fakeOff = listOff.find((p: { kind: string }) => p.kind === 'fake')
    await sunny.providers.setEnabled({ kind: 'fake', enabled: true })
    // Per-model toggle.
    await sunny.providers.setModelEnabled({ kind: 'fake', model: 'fake-1', enabled: false })
    const listModel = await sunny.providers.list()
    const fakeOn = listModel.find((p: { kind: string }) => p.kind === 'fake')
    await sunny.providers.setModelEnabled({ kind: 'fake', model: 'fake-1', enabled: true })

    // Agent-scoped chat: agentId persists on the chat row.
    const agents = await sunny.agents.list()
    const agentId = agents[0]?.id ?? null
    const chat = await sunny.chats.create({ provider: 'fake', model: 'fake-1', agentId })
    const reopened = await sunny.chats.get({ chatId: chat.id })

    // Assign an agent to a task.
    const task = await sunny.tasks.create({ title: 'Assignment test' })
    const updated = await sunny.tasks.update({ id: task.id, assignee: 'Cowork' })
    await sunny.tasks.delete({ id: task.id })

    return {
      fakeDisabled: fakeOff?.enabled,
      fakeReEnabled: fakeOn?.enabled,
      modelDisabled: fakeOn?.disabledModels.includes('fake-1'),
      chatAgentId: reopened.chat.agent_id,
      expectedAgentId: agentId,
      assignee: updated.assignee
    }
  })

  expect(result.fakeDisabled).toBe(false)
  expect(result.fakeReEnabled).toBe(true)
  expect(result.modelDisabled).toBe(true)
  expect(result.chatAgentId).toBe(result.expectedAgentId)
  expect(result.assignee).toBe('Cowork')
})

test('auto-worker works a backlog task with the default agent (fake provider)', async () => {
  const window = await app.firstWindow()
  const result = await window.evaluate(async () => {
    // @ts-expect-error — window.sunny is injected by the preload bridge
    const sunny = window.sunny
    await sunny.providers.saveKey({ kind: 'fake', apiKey: 'test-key' })
    const agent = await sunny.agents.create({ name: 'E2E Worker', provider: 'fake', model: 'fake-1' })
    await sunny.settings.set({ key: 'default_agent', value: agent.id })
    const task = await sunny.tasks.create({ title: 'E2E worker task', status: 'Backlog' })

    await sunny.worker.setEnabled({ enabled: true })
    await sunny.worker.runNow()

    let status = ''
    let chatId: string | null = null
    for (let i = 0; i < 50; i++) {
      const tasks = await sunny.tasks.list()
      const t = tasks.find((x: { id: string }) => x.id === task.id)
      status = t?.status ?? 'gone'
      chatId = t?.chat_id ?? null
      if (status === 'Done' || status === 'Blocked') break
      await new Promise((r) => setTimeout(r, 100))
    }

    // Cleanup.
    await sunny.worker.setEnabled({ enabled: false })
    await sunny.tasks.delete({ id: task.id })
    await sunny.agents.delete({ id: agent.id })
    await sunny.settings.set({ key: 'default_agent', value: '' })
    return { status, hasChat: Boolean(chatId) }
  })

  // The worker picked up the backlog task, ran the (fake) agent, and finished it.
  expect(result.status).toBe('Done')
  expect(result.hasChat).toBe(true)
})

test('web search toggle plumbs through and per-agent web access persists', async () => {
  const window = await app.firstWindow()
  const result = await window.evaluate(async () => {
    // @ts-expect-error — window.sunny is injected by the preload bridge
    const sunny = window.sunny
    await sunny.providers.saveKey({ kind: 'fake', apiKey: 'test-key' })

    // providers:list exposes the new web-capability fields. The fake provider has
    // no NATIVE web but does implement the tool loop (streamWithTools), so it
    // reports webMode 'tool' (web via Sunny's own tools), i.e. web-capable.
    const providers = await sunny.providers.list()
    const fake = providers.find((p: { kind: string }) => p.kind === 'fake')

    // A web-enabled send on a non-web provider must still stream normally — the
    // webSearch flag plumbs through the pipeline without breaking anything.
    const chat = await sunny.chats.create({ provider: 'fake', model: 'fake-1' })
    let streamed = ''
    await new Promise<void>((resolve, reject) => {
      const off = sunny.chat.onStream((ev: { type: string; text?: string }) => {
        if (ev.type === 'delta') streamed += ev.text
        else if (ev.type === 'done') {
          off()
          resolve()
        } else if (ev.type === 'error') {
          off()
          reject(new Error('stream error'))
        }
      })
      sunny.chat
        .send({ chatId: chat.id, content: 'search please', model: 'fake-1', webSearch: true })
        .catch((e: Error) => reject(e))
    })

    // Per-agent web access persists through create + update (migration 004).
    const created = await sunny.agents.create({
      name: 'WebAgent',
      provider: 'fake',
      model: 'fake-1',
      webAccess: true
    })
    const listed = (await sunny.agents.list()).find((a: { id: string }) => a.id === created.id)
    const afterUpdate = await sunny.agents.update({ id: created.id, webAccess: false })
    await sunny.agents.delete({ id: created.id })

    return {
      webModeKeyPresent: fake ? 'webMode' in fake : false,
      fakeWebCapable: fake?.webCapable,
      fakeWebMode: fake?.webMode ?? null,
      streamedLen: streamed.length,
      createdWebAccess: created.web_access,
      listedWebAccess: listed?.web_access,
      afterUpdateWebAccess: afterUpdate.web_access
    }
  })

  expect(result.webModeKeyPresent).toBe(true)
  expect(result.fakeWebCapable).toBe(true)
  expect(result.fakeWebMode).toBe('tool')
  expect(result.streamedLen).toBeGreaterThan(0)
  expect(result.createdWebAccess).toBe(1)
  expect(result.listedWebAccess).toBe(1)
  expect(result.afterUpdateWebAccess).toBe(0)
})

test('agent tools run in the workspace: read (autopilot), confirmed write (ask), plan blocks', async () => {
  const window = await app.firstWindow()

  // A real workspace folder the main process can touch; agent fs tools are rooted here.
  const ws = mkdtempSync(join(tmpdir(), 'sunny-agent-ws-'))
  writeFileSync(join(ws, 'note.txt'), 'hello from note')

  try {
    const result = await window.evaluate(async (workspace: string) => {
      // @ts-expect-error — window.sunny is injected by the preload bridge
      const sunny = window.sunny
      await sunny.providers.saveKey({ kind: 'fake', apiKey: 'test-key' })

      // FakeProvider runs the tool named in a `@@TOOL@@ {json}` directive via the
      // REAL registry (permission gate + workspace rooting + fs tools).
      const directive = (name: string, args: object): string =>
        `do it @@TOOL@@ ${JSON.stringify({ name, arguments: args })}`

      const sendAndWait = (
        chatId: string,
        content: string
      ): Promise<string> =>
        new Promise((resolve, reject) => {
          const off = sunny.chat.onStream(
            (ev: { type: string; text?: string; message?: { content: string } }) => {
              if (ev.type === 'done') {
                off()
                resolve(ev.message?.content ?? '')
              } else if (ev.type === 'error') {
                off()
                reject(new Error('stream error'))
              }
            }
          )
          sunny.chat
            .send({ chatId, content, model: 'fake-1', folderPath: workspace })
            .catch((e: Error) => reject(e))
        })

      // Scenario A — read_file under Autopilot (read-only, no confirm).
      const reader = await sunny.agents.create({
        name: 'Reader',
        provider: 'fake',
        model: 'fake-1',
        permissionMode: 'autopilot',
        allowedTools: ['read_file', 'list_dir', 'glob']
      })
      const chatA = await sunny.chats.create({ provider: 'fake', model: 'fake-1', agentId: reader.id })
      const readContent = await sendAndWait(chatA.id, directive('read_file', { path: 'note.txt' }))

      // Scenario B — write_file under Ask: a confirm request must arrive; approve it.
      const writer = await sunny.agents.create({
        name: 'Writer',
        provider: 'fake',
        model: 'fake-1',
        permissionMode: 'ask',
        allowedTools: ['read_file', 'write_file', 'edit_file']
      })
      let confirmFired = false
      const offConfirm = sunny.chat.onConfirm((req: { requestId: string }) => {
        confirmFired = true
        void sunny.chat.respondConfirm({ requestId: req.requestId, allow: true })
      })
      const chatB = await sunny.chats.create({ provider: 'fake', model: 'fake-1', agentId: writer.id })
      await sendAndWait(
        chatB.id,
        directive('write_file', { path: 'out.txt', content: 'written-by-agent' })
      )
      // Read it back through the same agent to prove the write landed.
      const readBack = await sendAndWait(chatB.id, directive('read_file', { path: 'out.txt' }))
      offConfirm()

      // Scenario C — write under Plan mode must be refused (read-only).
      const planner = await sunny.agents.create({
        name: 'Planner',
        provider: 'fake',
        model: 'fake-1',
        permissionMode: 'plan',
        allowedTools: ['write_file']
      })
      const chatC = await sunny.chats.create({ provider: 'fake', model: 'fake-1', agentId: planner.id })
      const planContent = await sendAndWait(
        chatC.id,
        directive('write_file', { path: 'planned.txt', content: 'should not be written' })
      )

      // Cleanup agents.
      await sunny.agents.delete({ id: reader.id })
      await sunny.agents.delete({ id: writer.id })
      await sunny.agents.delete({ id: planner.id })

      return { readContent, confirmFired, readBack, planContent }
    }, ws)

    // Read tool ran in the workspace and returned the file's contents.
    expect(result.readContent).toContain('hello from note')
    // Ask-mode write was confirmed and actually wrote the file.
    expect(result.confirmFired).toBe(true)
    expect(existsSync(join(ws, 'out.txt'))).toBe(true)
    expect(readFileSync(join(ws, 'out.txt'), 'utf8')).toBe('written-by-agent')
    expect(result.readBack).toContain('written-by-agent')
    // Plan mode refused the write and did NOT create the file.
    expect(result.planContent).toMatch(/Plan mode/i)
    expect(existsSync(join(ws, 'planned.txt'))).toBe(false)
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('projects scope tasks/chats, archive hides, delete re-parents (not deletes)', async () => {
  const window = await app.firstWindow()
  const result = await window.evaluate(async () => {
    // @ts-expect-error — window.sunny is injected by the preload bridge
    const sunny = window.sunny

    const p = await sunny.projects.create({ name: 'E2E Project', description: 'scope test' })
    const other = await sunny.projects.create({ name: 'E2E Other' })

    // Scope a task + a chat to the project.
    const task = await sunny.tasks.create({ title: 'Scoped task', projectId: p.id })
    const chat = await sunny.chats.create({ provider: 'fake', model: 'fake-1', projectId: p.id })

    const projectListed = (await sunny.projects.list()).some((x: { id: string }) => x.id === p.id)
    const tasksInProject = await sunny.tasks.list({ projectId: p.id })
    const tasksInOther = await sunny.tasks.list({ projectId: other.id })
    const chatsInProject = await sunny.chats.list({ projectId: p.id })

    // Archive hides it from the default (active) list but not includeArchived.
    await sunny.projects.update({ id: p.id, archived: true })
    const activeHasP = (await sunny.projects.list()).some((x: { id: string }) => x.id === p.id)
    const allHasP = (await sunny.projects.list({ includeArchived: true })).some(
      (x: { id: string }) => x.id === p.id
    )

    // Delete the project: children re-parent to NULL (ON DELETE SET NULL), not deleted.
    await sunny.projects.delete({ id: p.id })
    const projectGone = !(await sunny.projects.list({ includeArchived: true })).some(
      (x: { id: string }) => x.id === p.id
    )
    const allTasks = await sunny.tasks.list({})
    const reparentedTask = allTasks.find((t: { id: string }) => t.id === task.id)
    const unattachedChats = await sunny.chats.list({ projectId: null })

    // Cleanup.
    await sunny.tasks.delete({ id: task.id })
    await sunny.chats.delete({ chatId: chat.id })
    await sunny.projects.delete({ id: other.id })

    return {
      projectListed,
      taskScopedVisible: tasksInProject.some((t: { id: string }) => t.id === task.id),
      taskNotInOther: !tasksInOther.some((t: { id: string }) => t.id === task.id),
      chatScopedVisible: chatsInProject.some((c: { id: string }) => c.id === chat.id),
      activeHasP,
      allHasP,
      projectGone,
      taskSurvived: Boolean(reparentedTask),
      taskReparentedNull: reparentedTask ? reparentedTask.project_id === null : false,
      chatReparented: unattachedChats.some((c: { id: string }) => c.id === chat.id)
    }
  })

  expect(result.projectListed).toBe(true)
  expect(result.taskScopedVisible).toBe(true)
  expect(result.taskNotInOther).toBe(true)
  expect(result.chatScopedVisible).toBe(true)
  expect(result.activeHasP).toBe(false) // archived → hidden from active list
  expect(result.allHasP).toBe(true) // but present with includeArchived
  expect(result.projectGone).toBe(true)
  expect(result.taskSurvived).toBe(true) // re-parented, NOT cascade-deleted
  expect(result.taskReparentedNull).toBe(true)
  expect(result.chatReparented).toBe(true)
})

test('scheduler runNow fires a schedule: creates + works a task, records last run', async () => {
  const window = await app.firstWindow()
  const result = await window.evaluate(async () => {
    // @ts-expect-error — window.sunny is injected by the preload bridge
    const sunny = window.sunny
    await sunny.providers.saveKey({ kind: 'fake', apiKey: 'test-key' })

    const agent = await sunny.agents.create({ name: 'Sched Agent', provider: 'fake', model: 'fake-1' })
    const schedule = await sunny.schedules.create({
      name: 'E2E Schedule',
      prompt: 'summarize the day',
      cadence: 'daily',
      agentId: agent.id
    })

    const listed = await sunny.schedules.list()
    const created = listed.find((s: { id: string }) => s.id === schedule.id)

    // Fire it now — this creates a task and works it through the worker.
    await sunny.schedules.runNow({ id: schedule.id })

    // Find the task the schedule created (titled after the schedule) and wait for Done.
    let status = ''
    let hasChat = false
    let taskId: string | null = null
    for (let i = 0; i < 50; i++) {
      const tasks = await sunny.tasks.list({})
      const t = tasks.find((x: { title: string }) => x.title === 'E2E Schedule')
      if (t) {
        taskId = t.id
        status = t.status
        hasChat = Boolean(t.chat_id)
        if (status === 'Done' || status === 'Blocked') break
      }
      await new Promise((r) => setTimeout(r, 100))
    }

    const afterRun = (await sunny.schedules.list()).find((s: { id: string }) => s.id === schedule.id)

    // Cleanup.
    if (taskId) await sunny.tasks.delete({ id: taskId })
    await sunny.schedules.delete({ id: schedule.id })
    await sunny.agents.delete({ id: agent.id })

    return {
      scheduleCreated: Boolean(created),
      nextRunSet: Boolean(created && created.next_run_at),
      enabledByDefault: created ? created.enabled === 1 : false,
      taskStatus: status,
      taskHasChat: hasChat,
      lastRunSet: Boolean(afterRun && afterRun.last_run_at)
    }
  })

  expect(result.scheduleCreated).toBe(true)
  expect(result.nextRunSet).toBe(true) // create computed a next_run_at from the cadence
  expect(result.enabledByDefault).toBe(true)
  expect(result.taskStatus).toBe('Done') // the worker ran the scheduled task (fake provider)
  expect(result.taskHasChat).toBe(true)
  expect(result.lastRunSet).toBe(true) // runNow recorded the fire time
})

test('memory browser scopes to a project; global memory is excluded from a project view', async () => {
  const window = await app.firstWindow()
  const result = await window.evaluate(async () => {
    // @ts-expect-error — window.sunny is injected by the preload bridge
    const sunny = window.sunny

    const p = await sunny.projects.create({ name: 'Mem Project' })
    const scoped = await sunny.memories.create({
      content: 'project-scoped-fact-001',
      scope: 'project',
      kind: 'fact',
      projectId: p.id
    })
    const global = await sunny.memories.create({
      content: 'global-fact-002',
      scope: 'global',
      kind: 'fact'
    })

    const inProject = await sunny.memories.list({ projectId: p.id })
    const all = await sunny.memories.list({})

    // Cleanup.
    await sunny.memories.delete({ id: scoped.id })
    await sunny.memories.delete({ id: global.id })
    await sunny.projects.delete({ id: p.id })

    return {
      scopedTaggedWithProject: scoped.project_id === p.id,
      scopedInProjectView: inProject.some((m: { id: string }) => m.id === scoped.id),
      globalExcludedFromProjectView: !inProject.some((m: { id: string }) => m.id === global.id),
      bothVisibleInAll:
        all.some((m: { id: string }) => m.id === scoped.id) &&
        all.some((m: { id: string }) => m.id === global.id)
    }
  })

  expect(result.scopedTaggedWithProject).toBe(true)
  expect(result.scopedInProjectView).toBe(true)
  expect(result.globalExcludedFromProjectView).toBe(true)
  expect(result.bothVisibleInAll).toBe(true)
})

test('multi-agent delegate: manager decomposes into subtasks, worker runs them, parent synthesized', async () => {
  const window = await app.firstWindow()
  const result = await window.evaluate(async () => {
    // @ts-expect-error — window.sunny is injected by the preload bridge
    const sunny = window.sunny
    await sunny.providers.saveKey({ kind: 'fake', apiKey: 'test-key' })

    const manager = await sunny.agents.create({ name: 'Manager A', provider: 'fake', model: 'fake-1' })

    // The fake returns the @@JSON@@ object when "asked" to decompose, so the
    // manager gets two real subtasks. (A real model would produce this itself.)
    const directive =
      '@@JSON@@ {"subtasks":[{"title":"Subtask Alpha","description":"do alpha"},' +
      '{"title":"Subtask Beta","description":"do beta"}]}'
    const parent = await sunny.tasks.create({
      title: 'Delegated goal',
      description: directive,
      status: 'Backlog'
    })

    await sunny.tasks.delegate({ taskId: parent.id, managerAgentId: manager.id, workerAgentId: manager.id })

    // Poll until the parent is Done (delegate is fire-and-forget).
    let parentStatus = ''
    let children: Array<{ id: string; status: string; parent_task_id: string | null }> = []
    let parentHasChat = false
    for (let i = 0; i < 80; i++) {
      const tasks = await sunny.tasks.list({})
      const p = tasks.find((t: { id: string }) => t.id === parent.id)
      children = tasks.filter(
        (t: { parent_task_id: string | null }) => t.parent_task_id === parent.id
      )
      parentStatus = p?.status ?? 'gone'
      parentHasChat = Boolean(p?.chat_id)
      if (parentStatus === 'Done' || parentStatus === 'Blocked') break
      await new Promise((r) => setTimeout(r, 100))
    }

    const childrenDone = children.length > 0 && children.every((c) => c.status === 'Done')
    const childTitles = children.map((c) => c.id)

    // Cleanup (children first is fine; delete parent + agent).
    for (const id of childTitles) await sunny.tasks.delete({ id })
    await sunny.tasks.delete({ id: parent.id })
    await sunny.agents.delete({ id: manager.id })

    return {
      childCount: children.length,
      childrenDone,
      parentStatus,
      parentHasChat
    }
  })

  expect(result.childCount).toBe(2) // manager decomposed into the two subtasks
  expect(result.childrenDone).toBe(true) // the worker ran each child to Done
  expect(result.parentStatus).toBe('Done') // manager synthesized the results
  expect(result.parentHasChat).toBe(true) // synthesis chat linked to the parent
})

test('approvals decide flow: gated action parks the task, approving re-runs and consumes the single-use gate', async () => {
  const window = await app.firstWindow()

  // A real workspace the WORKER's fs tools are rooted in (via the
  // `agent_workspace` setting — the worker path, unlike chat's per-chat folder).
  const ws = mkdtempSync(join(tmpdir(), 'sunny-approval-ws-'))

  try {
    const result = await window.evaluate(async (workspace: string) => {
      // @ts-expect-error — window.sunny is injected by the preload bridge
      const sunny = window.sunny
      await sunny.providers.saveKey({ kind: 'fake', apiKey: 'test-key' })
      await sunny.settings.set({ key: 'agent_workspace', value: workspace })

      // Ask-mode agent: with no human present, its side-effecting tool call
      // becomes a pending APPROVAL and the run is denied this round.
      const agent = await sunny.agents.create({
        name: 'Approval E2E',
        provider: 'fake',
        model: 'fake-1',
        permissionMode: 'ask',
        allowedTools: ['read_file', 'write_file']
      })
      const task = await sunny.tasks.create({
        title: 'Approval e2e task',
        description:
          'do it @@TOOL@@ {"name":"write_file","arguments":{"path":"approved.txt","content":"approved-by-user"}}',
        status: 'Planned',
        assignee: 'Approval E2E'
      })

      const poll = async (
        want: (t: { status: string; awaiting_approval?: number; blocked_reason?: string | null }) => boolean
      ): Promise<{ status: string; awaiting_approval?: number; blocked_reason?: string | null }> => {
        let last: { status: string } = { status: 'missing' }
        for (let i = 0; i < 80; i++) {
          const tasks = await sunny.tasks.list()
          const t = tasks.find((x: { id: string }) => x.id === task.id)
          if (t) {
            last = t
            if (want(t)) return t
          }
          await new Promise((r) => setTimeout(r, 100))
        }
        return last as { status: string; awaiting_approval?: number; blocked_reason?: string | null }
      }

      // 1. Work it (heartbeat-independent). The gated write is denied, an
      //    approval goes pending, and the task parks Blocked + annotated.
      await sunny.tasks.workNow({ id: task.id })
      const parked = await poll((t) => t.status === 'Blocked')
      const pending = (await sunny.approvals.list({ status: 'pending' })).filter(
        (a: { task_id: string | null }) => a.task_id === task.id
      )

      // 2. Approve → the task re-queues and re-runs; the gate now allows and is
      //    CONSUMED (single-use); the write lands and the task finishes.
      let decided = false
      if (pending.length === 1) {
        await sunny.approvals.decide({ id: pending[0].id, decision: 'approved' })
        decided = true
      }
      const finished = decided ? await poll((t) => t.status === 'Done') : parked

      // 3. Single-use: the approval row is now consumed ('expired' = ask again).
      const consumed = (await sunny.approvals.list({ status: 'expired' })).filter(
        (a: { task_id: string | null }) => a.task_id === task.id
      )

      // Cleanup.
      await sunny.tasks.delete({ id: task.id })
      await sunny.agents.delete({ id: agent.id })
      await sunny.settings.set({ key: 'agent_workspace', value: '' })

      return {
        parkedStatus: parked.status,
        parkedAwaiting: Boolean(parked.awaiting_approval),
        parkedReason: parked.blocked_reason ?? null,
        pendingCount: pending.length,
        pendingDetail: pending[0]?.detail ?? '',
        finishedStatus: finished.status,
        consumedCount: consumed.length
      }
    }, ws)

    // The gated action parked the task with the awaiting-approval annotation.
    expect(result.parkedStatus).toBe('Blocked')
    expect(result.parkedAwaiting).toBe(true)
    expect(result.parkedReason).toMatch(/approval/i)
    // Exactly one pending approval, naming the concrete action.
    expect(result.pendingCount).toBe(1)
    expect(result.pendingDetail).toContain('approved.txt')
    // Approving re-ran the task to Done and the write actually landed.
    expect(result.finishedStatus).toBe('Done')
    expect(existsSync(join(ws, 'approved.txt'))).toBe(true)
    expect(readFileSync(join(ws, 'approved.txt'), 'utf8')).toBe('approved-by-user')
    // The approval was consumed on use (single-use, not a standing allow).
    expect(result.consumedCount).toBe(1)
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('board tools: an agent creates a task on the board, and the tool call lands in the audit trail', async () => {
  const window = await app.firstWindow()
  const result = await window.evaluate(async () => {
    // @ts-expect-error — window.sunny is injected by the preload bridge
    const sunny = window.sunny
    await sunny.providers.saveKey({ kind: 'fake', apiKey: 'test-key' })

    // Autopilot agent with the board group: create_task is side-effecting but
    // non-destructive, so it runs unattended (the governance path unit tests
    // cover plan/ask).
    const agent = await sunny.agents.create({
      name: 'Board E2E',
      provider: 'fake',
      model: 'fake-1',
      permissionMode: 'autopilot',
      allowedTools: ['list_tasks', 'create_task', 'update_task', 'add_task_dependency']
    })
    const chat = await sunny.chats.create({ provider: 'fake', model: 'fake-1', agentId: agent.id })

    const sendAndWait = (content: string): Promise<string> =>
      new Promise((resolve, reject) => {
        const off = sunny.chat.onStream(
          (ev: { type: string; message?: { content: string } }) => {
            if (ev.type === 'done') {
              off()
              resolve(ev.message?.content ?? '')
            } else if (ev.type === 'error') {
              off()
              reject(new Error('stream error'))
            }
          }
        )
        sunny.chat.send({ chatId: chat.id, content, model: 'fake-1' }).catch((e: Error) => reject(e))
      })

    const reply = await sendAndWait(
      'do it @@TOOL@@ {"name":"create_task","arguments":{"title":"Created by agent e2e","description":"from board tools","status":"Planned"}}'
    )

    const tasks = await sunny.tasks.list()
    const created = tasks.find((t: { title: string }) => t.title === 'Created by agent e2e')

    // The durable audit trail recorded the tool execution.
    const audit = (await sunny.activity.list({ kinds: ['tool.executed'], limit: 20 })).filter(
      (e: { actor: string | null }) => e.actor === 'Board E2E'
    )

    // Cleanup.
    if (created) await sunny.tasks.delete({ id: created.id })
    await sunny.chats.delete({ chatId: chat.id })
    await sunny.agents.delete({ id: agent.id })

    return {
      reply,
      createdStatus: created?.status ?? 'missing',
      createdAssignee: created?.assignee ?? null,
      auditCount: audit.length,
      auditSummary: audit[0] ? (JSON.parse(audit[0].payload ?? '{}') as { tool?: string }).tool : ''
    }
  })

  // The agent's tool call created a real card on the board...
  expect(result.reply).toContain('Created task')
  expect(result.createdStatus).toBe('Planned')
  // ...and the execution is durably auditable (who ran what).
  expect(result.auditCount).toBeGreaterThanOrEqual(1)
  expect(result.auditSummary).toBe('create_task')
})
