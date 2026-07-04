# Sunny — User Guide

Sunny is a local-first desktop command center for agentic AI work. You connect the AI providers you already pay for (or run locally), define agents with real tools and guardrails, and hand them work — interactively in chat, on a Kanban board they work autonomously, or on a schedule. Everything runs and stays on your machine: your keys live in the OS keychain, your data in a local SQLite database.

> **Version**: 0.5.1 · **Platforms**: macOS · Windows · Linux · This guide covers every user-facing surface.

## Contents

1. [Getting started](#1-getting-started)
2. [Chat](#2-chat)
3. [Agents](#3-agents)
4. [The Board — autonomous work](#4-the-board--autonomous-work)
5. [Approvals & governance](#5-approvals--governance)
6. [Goals, projects & team](#6-goals-projects--team)
7. [Schedules](#7-schedules)
8. [Memory](#8-memory)
9. [Settings reference](#9-settings-reference)
10. [Activity & the audit trail](#10-activity--the-audit-trail)
11. [Troubleshooting & FAQ](#11-troubleshooting--faq)

---

## 1. Getting started

### Installing

Download the build for your platform from the [Releases page](https://github.com/dodaniel351/sunny/releases/latest):

- **macOS** — `Sunny-<version>-arm64.dmg` (Apple Silicon) or `Sunny-<version>-x64.dmg` (Intel). Open the dmg and drag **Sunny** to Applications. The app is signed & notarized by Apple, so it launches with no Gatekeeper warning.
- **Windows** — `Sunny-<version>-setup-x64.exe` (NSIS installer). It's unsigned, so SmartScreen will warn on first run — choose **More info → Run anyway**.
- **Linux (Debian/Ubuntu)** — `Sunny-<version>-amd64.deb`. Install with `sudo apt install ./Sunny-<version>-amd64.deb`.

The installer/app sets up Sunny on your machine and optionally launches it when done.

> **CRITICAL:** If you're reinstalling or upgrading Sunny, quit the app from the system tray **before** running the installer. Quit Sunny from the tray menu (right-click the tray icon → Quit Sunny). Closing the window only minimizes Sunny to the tray—it keeps running in the background. If you install over a running copy, the old version continues running and fixes won't take effect.

### First launch

When you open Sunny, the dashboard appears with:
- A greeting and quick-action chips for common tasks
- A composer at the bottom to start a chat or agent run
- A Live Activity rail on the right showing running agents and scheduled tasks

Sunny lives in the system tray. Closing the window minimizes it—agents, schedules, and background work continue running. The only true exit is the tray menu's "Quit Sunny" option.

### Connecting providers

Go to **Settings → Providers & Keys** to connect your AI providers.

**API-key providers:** Paste your key for OpenAI, Anthropic, Google Gemini, OpenRouter, Groq, or Perplexity. Sunny validates the key, stores it in your OS keychain (never plaintext), and enables those models immediately.

**xAI/Grok:** Sign in either with an API key or a subscription OAuth token (browser sign-in).

**OpenAI Codex (ChatGPT OAuth):** Requires the Codex CLI installed on your PATH. If your ChatGPT plan has Codex app-server restrictions, the headless OAuth may 401—if so, fall back to the OpenAI API-key provider instead.

**Ollama:** No key needed. Set the base URL if your local daemon isn't at the default `http://localhost:11434`. Sunny detects available models live from your running Ollama instance.

**opencode:** No key needed. Point to the base URL of your local opencode server (and enter the optional password if protected). opencode exposes its own authed providers—like a ChatGPT subscription—headlessly.

After connecting, you see toggle switches per provider and per model. Use these to enable or disable specific models in pickers without removing the provider key.

### Setting a default model

Go to **Settings → Default model** and pick a provider and model. New chats open on this model, and the choice persists across restarts. You can still switch models mid-conversation from the model chip in the composer—the new model applies to the next turn.

### Where your data lives

Go to **Settings → Data Location** to see the full path to your local SQLite database and the `sunny-main.log` app log, both stored under your OS app-data directory.

---

## 2. Chat

### Starting a chat

You can start a chat from the dashboard composer or the Chats page. Agent preset cards on the dashboard (Cowork, Research, Code, Ops, Write copy) start a chat **as** that agent—its persona and enabled tools apply automatically.

Click the model chip in the composer to open the full model selector, grouped by provider. Picking a model sets both the provider and model together. You can switch models during a conversation; the new model takes effect on your next message.

### Web search

The 🔍 toggle appears above the composer and controls web search **per message**. 

On providers with native web search built in (OpenAI, Anthropic, Gemini, Perplexity), toggling search on uses their native search feature.

On other providers (Ollama, Grok, OpenRouter, Groq), toggling search on activates Sunny's own keyless web tools. These use DuckDuckGo by default. You can change the search engine in **Settings → Web search**—Tavily and Brave are available as API providers (they require a key, stored in Sunny's local database, not the keychain). If an API provider fails, Sunny silently falls back to DuckDuckGo.

Transient status lines like "Searching…" appear while the search runs but aren't saved into your transcript.

### Attachments

Click the paperclip icon to attach files. Text and document files (up to 128 KB each, 512 KB total per message) are folded into your message and persist in the transcript. Images are sent as real image input to vision-capable models. Binary files are skipped.

### Chat in Folder

From a chat, use the folder picker ("Chat in Folder"). The model then sees the complete file tree of that folder plus the root README as context. If you're chatting with an agent that has file and shell tools enabled, the folder becomes its workspace—it can read and write files there, subject to its permission mode.

### Agent side effects and Ask mode

While a tool-capable agent is running, side-effecting actions (like writing files or running shell commands) may trigger a confirmation modal. Approve or deny each action based on what you see. This is Ask mode.

### Reading replies

Replies render as markdown with syntax-highlighted code blocks. Each code block has a copy button. Your own messages stay as literal text you typed.

To copy an entire reply as raw markdown, use the whole-message copy option. You can stop a reply mid-stream to keep the partial text. If a turn fails, a Retry button appears.

---

## 3. Agents

### The agent library

The **Agents** page shows your agent library. Five editable presets ship with Sunny: Cowork, Research, Code, Ops, and Write copy. You can create new agents, duplicate existing ones, edit their settings, or delete them.

An agent is a set of configurations: a name, role description, system prompt (the persona that shapes its behavior), an optional pinned provider and model (for unattended runs, it falls back to any usable provider if your pin is unavailable), a permission mode, enabled tool groups, and a web access flag.

### Permission modes

Permission modes control what an agent can do without asking you. They are the safety core and apply to all the agent's tools:

- **Plan**: Read-only mode. Side-effecting tools (file writes, shell commands, API calls) are refused outright; the agent describes what it *would* do instead. Use this to explore workflows safely.
- **Ask**: Every side-effecting action requires your confirmation. In interactive chat, a modal appears; in autonomous runs, the action becomes an approval request (see section 5). Read-only tools execute freely.
- **Autopilot**: Non-destructive actions run unattended without prompts. Destructive patterns (e.g., `rm`, `del`, or format commands) still require confirmation or approval, even in autonomous mode. Use this for trusted agents doing routine work.

### Tool groups

Tool groups are checkboxes on the agent editor. Enable the ones your agent needs:

- **Read & search files**: `read_file`, `list_dir`, `glob`. Workspace-rooted, read-only.
- **Write & edit files**: Create and modify files in your workspace (`write_file`, `edit_file`).
- **Run shell commands**: Execute commands in your workspace directory. Output is capped (~16 KB), and each command times out after 2 minutes.
- **Create documents**: Export results as markdown, plain text, CSV, HTML, Word (.docx), Excel (.xlsx), or PDF. Sunny saves these and attaches them to the reply as downloadable chips; no workspace needed.
- **Board & tasks**: The agent can list tasks, create new ones, update their status, and add dependencies. Lets a manager agent run its own work queue.
- **External tools (MCP)**: Access everything from your connected MCP servers (e.g., web search, integrations, custom tools).

All tools respect the agent's permission mode.

### Web access

Toggle **Web access** per agent. In autonomous runs, if enabled, the agent can search the web using its model's native search or Sunny's web tools—useful for research, fact-checking, or gathering current information.

### Default agent

On the **Board** header, you can set a default agent. When a task has no explicit assignee, the default agent works it. This lets you spin up new tasks quickly without picking an agent each time.

---

## 4. The Board — autonomous work

### The Kanban board

The **Board** is a Kanban view with five columns: **Backlog** (new tasks), **Planned** (ready to work), **In Progress** (running), **Blocked** (waiting or failed), and **Done** (completed). Create a task with the add button in a column—set a title, description, assignee agent, and project. Drag cards between columns as work progresses. Double-click a card to open the detail dialog, where you can link goals and add blocker dependencies. Circular dependencies are rejected inline with an error.

### Two ways work happens

- **Work now**: Click "Work now" on any card. The task runs immediately in the background, regardless of the auto-work toggle. Use this to prioritize urgent work.
- **Auto-work**: Toggle in the Board header (off by default). When on, Sunny scans the Backlog and Planned columns on an interval (default 10 minutes, configurable in settings) and automatically works up to 5 tasks per scan. A "Run now" button forces one scan even while auto-work is off. A banner warns you when tasks are waiting but auto-work is off.

### The agent loop

When a task runs, the agent works in up to 4 turns. After each turn, it tells Sunny one of three things:

- **DONE**: The work is complete. Sunny then runs a reviewer pass to verify the result actually accomplishes the task. If the review fails, a critique goes back to the agent for a rework turn.
- **CONTINUE**: The agent needs another turn to make progress. It loops.
- **BLOCKED**: The agent is stuck. You'll see the blocker reason on the card (e.g. missing input or credentials it doesn't have).

Each run is capped at 15 minutes total. If a provider stream stalls silently, Sunny cuts it off after 90 seconds and retries.

### Resilience

Sunny handles transient failures (timeouts, rate limits, network blips) by retrying automatically with backoff: first retry ~1 minute later, second retry ~5 minutes later. After 3 consecutive failures, the task parks in the Blocked column with the reason visible on the card. Permanent errors (bad API key, unknown model) park immediately without retrying. Cards show *why* they're blocked inline.

### Runs resume

When a task is retried (after a transient failure) or re-approved (after you approve a pending action), it doesn't start over. Instead, it resumes its working chat—the same conversation continues. Open the linked chat from the card to watch the agent's full trace and see what it did on retry.

### Delegation

Use the **Delegate** action on a card to have a manager agent decompose the goal into ordered subtasks (child cards). The manager then runs each child task sequentially, passing earlier results forward as input to the next. Child tasks are assigned to workers from the manager's team (reports) or an explicit worker agent. After all children finish, the manager synthesizes a final answer on the parent card.

### Reviewing results

Once a task moves to Done, use the **View result** button to open a modal with the final output and any generated files. If the result doesn't meet expectations, click **Request changes**, type a critique, and submit. The task re-queues and the resumed run addresses your feedback in the same conversation, so context is not lost.

---

## 5. Approvals & governance

### Why approvals exist

In autonomous runs, no one is watching the agent in real time. So an action the permission mode doesn't allow unattended—any side effect in **Ask** mode, or destructive actions in **Autopilot** mode—doesn't execute. Instead, it becomes a **pending approval**. The task parks in the Blocked column with an "Awaiting your approval" badge, and you get an OS notification.

### The Approvals inbox

Visit the **Approvals** page to see all pending items. Each lists the agent, the task, and the *exact action* (e.g., the precise shell command or file path). You can:

- **Approve**: The task re-queues automatically and re-runs (works even if auto-work is off). The approved action executes on the next turn.
- **Reject**: The task stays Blocked with your rejection note. That exact action will not be asked again.

### Single-use, action-scoped

Approvals are *not* blanket permissions. Approving one command approves only that exact command, once. If the agent runs the same action again in a future run, it re-asks. A different command was never covered by your approval.

### Agent lifecycle

The **Team** page lets you manage agent state:

- **Pause** an agent: It gets no new work. Tasks assigned to it wait in place; they do *not* fall back to the default agent. If you try "Work now" on a paused agent's task, you'll see it's paused with a Blocked reason.
- **Resume** a paused agent: It can accept work again.
- **Terminate** an agent: retire it permanently — like pause, it receives no new work. Deleting an agent outright is done from the Agents page.

---

## 6. Goals, projects & team

### Objectives (Goals page)

You organize work into a tree of objectives and nested goals. Each goal shows a progress bar rolled up from linked tasks—so you see at a glance how many tasks are done out of the total. Create objectives (top level) and nested goals under them. From any task's detail panel on the Board, link it to a goal; when an agent works that task, its goal ancestry (the "why") is injected as context so work stays aligned to intent.

### Projects

Use the project switcher in the sidebar to scope chats, tasks, and memory to a single project—or select "All Projects" to work across everything. Archiving a project hides it from the switcher. Deleting a project re-parents its chats, tasks, and memories to unattached (nothing is cascade-deleted, so no data loss). Memory recall inside a project always sees that project's memories plus global ones, but never another project's memories—keeping contexts clean.

### Team page

Your agents appear as an indented list, or toggle to an org-chart view. Each agent shows:

- A **heartbeat dot**: idle, working (pulsing with the current task name), or paused.
- **Reports-to** selector: set who each agent reports to, building the hierarchy.
- **Title** field: optional custom role or job title.
- Lifecycle controls: pause, resume, or terminate the agent.

Managers' reports become the worker pool for delegation—a manager can break work into subtasks and spread them across its reports.

---

## 7. Schedules

A schedule runs an agent on a prompt at a fixed cadence: every 15 minutes, 30 minutes, hourly, daily, or weekly. Each time the schedule fires, it creates a task card on the Board (visible and tracked) and a linked chat, then runs the agent immediately.

### Creating and editing schedules

When you create a schedule, set:

- **Name**: a short label (e.g., "Weather Report").
- **Goal / Prompt**: the task or question to run.
- **Agent** (optional): if you leave it blank, the default agent runs; otherwise pick an agent.
- **Project** (optional): scope the task to a project.
- **Enabled toggle**: turn the schedule on or off.
- **Provider + Model override** (optional): if set, this provider/model is used and is authoritative—the app shows a clear blocked reason if the override is broken; it never silently falls back to a different model.

Editing a schedule without changing its cadence does **not** reset the timer—the next run stays on its original schedule.

### Running and monitoring schedules

- **Run now** fires the schedule immediately, creating a task and running it right away.
- **View result** shows the task output after it finishes.
- If the app was closed past a schedule's due time, it fires once on the next launch (no backlog storm).

### Circuit breaker

If a schedule's task ends **Blocked** 3 firings in a row, the schedule is automatically disabled. An Activity entry + OS notification alert you so it can't spawn failing cards forever. A successful (Done) firing resets the streak. Re-enable the schedule after fixing the cause.

---

## 8. Memory

### Auto-memory and learning

With **Auto-memory** enabled on the Memory page, Sunny extracts durable facts, entities, and relations from your chat exchanges and from completed autonomous task runs. These become a local knowledge graph—Sunny learns as you work.

### Semantic recall

Before each turn, memories **relevant** to your message are injected as background context. Relevance is enforced: off-topic prompts (like asking for a recipe on a chat about your project) inject nothing, preventing memory from bleeding into unrelated conversations.

The **Recall strictness** slider (on the Memory page) tunes how strict the relevance floor is. Default is 0.35; local embedding models like nomic often work better at ~0.55. Raise the slider to inject fewer/no memories; lower it to cast a wider net.

### Embeddings and semantic search

Embeddings power the semantic recall. On the Memory page, pick an embedding provider and model:

- **OpenAI**: reliable, cloud-based.
- **OpenRouter**: access to a range of open-source embedders.
- **Ollama** (local): privacy-first, no external calls.

After switching, use **Re-embed all** to re-embed your existing memories with the new model. Without any embedder configured, memory still works via recency and the knowledge graph, but it won't be semantic—just chronological.

### Memory page

Browse and search your memories (filtered by active project), edit or delete them, and see entity/relation counts. Click the **Graph** toggle to view a force-directed knowledge graph: drag to pan, scroll to zoom, and click an entity to open its detail panel and see linked memories.

---

## 9. Settings reference

### Providers & Keys / OAuth

Connect and disconnect AI providers. Sunny validates each API key when you paste it and stores keys in your OS keychain. Per-provider and per-model toggles let you disable specific models without removing the key. OAuth providers show their connected status and account details.

### Default model

The provider and model that new chats open on. This setting persists across restarts and launch.

### Web search

Shows each connected provider's web search mode—either native (provider's own search) or Sunny's tools (keyless web access via DuckDuckGo, Tavily, or Brave). API-based search providers require a key (stored in Sunny's local database, not the keychain—this is noted in the UI). If any API fails, Sunny silently falls back to DuckDuckGo.

### Standing Instructions

A text block that every agent and chat reads before acting. Use this for global preferences or rules you want to enforce across all your conversations.

### Agent workspace

The folder where the autonomous worker's file and shell tools operate. Interactive chats use a per-chat folder instead. If you don't set an agent workspace, the autonomous worker's file and shell tools are unavailable. Set this once and it persists.

### MCP servers

Add external Model-Context-Protocol tool servers by command. For example: `npx -y @modelcontextprotocol/server-filesystem C:\some\folder`. The interface shows each server's connected status, how many tools it exposes, and any error messages. You can enable, disable, or remove each server independently. Agents must have the "External tools (MCP)" group enabled to use these tools.

### Notifications

OS toasts appear for approval-needed, task-blocked, task-finished, and schedule-disabled events. Click a toast to raise the Sunny window. Toggle notifications off to silence them.

### Budget & spend

Shows your month-to-date estimated cost in USD and total tokens across all model calls (chats and autonomous runs). Set a monthly budget cap in USD; when reached, autonomous runs park as Blocked until you raise the cap or the calendar month rolls over. Costs are estimated from list prices. Models without public pricing (Groq, OpenRouter, xAI, Perplexity) count as $0.

### Data Location

Displays the full paths to your local SQLite database and app data folder.

---

## 10. Activity & the audit trail

The **Activity** page is the durable log of everything that happens: task card moves, agent runs (started, finished, failed), approval requests and decisions, schedule firings and auto-disables, and a detailed tool-execution audit trail.

### Event types and filters

Filter the feed by:

- **All**: everything.
- **Tasks**: task.created, task.moved, task.claimed—every change to a board card.
- **Runs**: run.started, run.finished, run.failed—agent work with token counts and estimated cost (on providers that report usage).
- **Tools**: a durable audit trail of every tool call an agent executed—file reads/writes, shell commands, board operations, MCP server calls, web searches. Each entry shows which tool, a preview of arguments, result preview, duration, and whether it succeeded.
- **Approvals**: approval requests, approvals granted, rejections, schedule auto-disables.

### Viewing results and details

Clicking a completed run or task opens a **review modal**—a rendered report of the work with any generated files or images. If the result is a task, you can **Request changes**: type a critique, and the agent re-queues the task, continues the same chat (not a fresh one), and addresses your feedback.

### Agent status panel

The **Agent status panel** shows the live roster: which agents are working on what, which are idle, and which are paused. It updates in real time as agents work.

### Badges and activity visibility

- A **pending approvals** count badge appears on the Approvals item in the sidebar rail.
- An **unseen activity** badge appears when new events occur. Click **Mark all read** to clear the badge; this is persisted (survives restart), so you won't re-see old events.

### Live activity rail on the dashboard

The dashboard shows recent task transitions in real time on the right side (the "Live Activity" rail). Click one to jump to that task's chat.

---

## 11. Troubleshooting & FAQ

**I installed an update but nothing changed.**
You reinstalled Sunny while it was still running in the system tray. Quit Sunny from the tray icon first (right-click → Quit), then run the installer.

**My tasks just sit in Backlog.**
Auto-work is off by default (toggle it on in the Board header). You can also click **Work now** on a single card, or use **Run scan now** in the Board header for a one-off scan. A banner reminds you when tasks are waiting and auto-work is off.

**A task is Blocked—why?**
The block reason appears inline on the card: timeout, provider error, agent-reported reason, rejected approval, paused agent, or budget reached. Awaiting-approval cards have their own badge; decide in the Approvals tab.

**Everything is parked with "Monthly budget reached."**
You hit your spending cap in Settings → Budget & spend. Raise the cap or clear it, then re-queue the cards (drag to Planned or click Work now).

**Codex (ChatGPT OAuth) errors with 401.**
This is a known Codex CLI limitation on some subscription plans. Use the OpenAI API-key provider instead; the API backend works where the app-server websocket doesn't.

**Web searches return nothing.**
DuckDuckGo (the keyless default) sometimes rate-limits. Configure a better search provider in Settings → Web search: Tavily or Brave with an API key. Sunny auto-falls back to DuckDuckGo if your configured provider fails.

**My agent says its tools aren't available.**
Either the provider can't run tools (Codex and opencode don't support tool use), or the agent doesn't have a workspace configured. Switch the agent or chat to a tool-capable model (OpenAI, Anthropic, Google Gemini, Ollama, Groq, OpenRouter, or xAI), or set a workspace folder in Settings → Agent workspace.

**An MCP server won't connect.**
Check that the MCP command runs in a terminal by itself. On Windows, npx-style commands are launched via cmd automatically. The error shown on the server row in Settings → MCP servers tells you what went wrong (e.g., command not found, bad path).

**Where are my data and logs?**
Go to Settings → Data Location to see the main app-data folder. The main process log file is `sunny-main.log` in that same directory.

**Does anything leave my machine?**
Only model/API calls to providers you've configured (OpenAI, Anthropic, etc.) and web searches. There is no Sunny cloud service, no telemetry, and no calls home—your chats, tasks, and memory stay local unless you send them to an external provider.

---

*Sunny stores all data locally. Model calls go directly from your machine to the providers you configured — there is no Sunny cloud.*
