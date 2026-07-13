import {
  BellRing,
  FolderCog,
  FolderGit2,
  Globe,
  KeyRound,
  Plug,
  ScrollText,
  Sparkles,
  Wallet,
  type LucideIcon
} from 'lucide-react'
import { type ReactNode } from 'react'
import { AgentWorkspaceSection } from '@renderer/components/settings/AgentWorkspaceSection'
import { BudgetSection } from '@renderer/components/settings/BudgetSection'
import { McpServersSection } from '@renderer/components/settings/McpServersSection'
import { NotificationsSection } from '@renderer/components/settings/NotificationsSection'
import { DataLocationSection } from '@renderer/components/settings/DataLocationSection'
import { DefaultModelSection } from '@renderer/components/settings/DefaultModelSection'
import { ProvidersSection } from '@renderer/components/settings/ProvidersSection'
import { StandingInstructionsSection } from '@renderer/components/settings/StandingInstructionsSection'
import { WebResearchSection } from '@renderer/components/settings/WebResearchSection'
import { Panel } from '@renderer/components/ui/Panel'
import { PageHeader } from '@renderer/components/ui/PageHeader'

interface SettingsSectionProps {
  icon: LucideIcon
  title: string
  description: string
  children: ReactNode
}

/** A titled settings card with an icon and explanatory copy. */
function SettingsSection({
  icon: Icon,
  title,
  description,
  children
}: SettingsSectionProps): JSX.Element {
  return (
    <Panel className="p-6">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-ink-700 bg-ink-800">
          <Icon className="h-5 w-5 text-amber-300" aria-hidden="true" />
        </span>
        <div>
          <h2 className="text-base font-semibold text-fg-heading">{title}</h2>
          <p className="mt-1 text-sm text-fg-muted">{description}</p>
        </div>
      </div>
      <div className="mt-5">{children}</div>
    </Panel>
  )
}

/** Settings — Providers/Keys/OAuth, Standing Instructions (spec §9), Data Location (spec §2). */
export function Settings(): JSX.Element {
  return (
    <div className="mx-auto w-full max-w-3xl px-8 py-10">
      <PageHeader
        title="Settings"
        description="Local-first by design — keys live in your OS keychain, data stays on this machine."
      />

      <div className="mt-8 flex flex-col gap-5">
        <div id="settings-providers">
          <SettingsSection
            icon={KeyRound}
            title="Providers & Keys / OAuth"
            description="Connect Anthropic, OpenAI, Google, OpenRouter, Groq, plus Codex and Grok via OAuth."
          >
            <ProvidersSection />
          </SettingsSection>
        </div>

        <SettingsSection
          icon={Sparkles}
          title="Default model"
          description="The provider and model every new chat starts on. Pick any active provider's model."
        >
          <DefaultModelSection />
        </SettingsSection>

        <SettingsSection
          icon={Globe}
          title="Web search"
          description="Controlled per-message by the 🔍 toggle in chat and per-agent by each agent's Web access toggle."
        >
          <WebResearchSection />
        </SettingsSection>

        <SettingsSection
          icon={ScrollText}
          title="Standing Instructions"
          description="A constitution-style file of global preferences every agent reads before acting."
        >
          <StandingInstructionsSection />
        </SettingsSection>

        <SettingsSection
          icon={FolderGit2}
          title="Agent workspace"
          description="The folder the autonomous board worker runs agents' file and shell tools inside."
        >
          <AgentWorkspaceSection />
        </SettingsSection>

        <SettingsSection
          icon={Plug}
          title="MCP servers"
          description="External tool servers (Model Context Protocol) — gives agents email, GitHub, databases, and more."
        >
          <McpServersSection />
        </SettingsSection>

        <SettingsSection
          icon={Wallet}
          title="Budget & spend"
          description="Month-to-date estimated cost and a hard monthly cap for autonomous work."
        >
          <BudgetSection />
        </SettingsSection>

        <SettingsSection
          icon={BellRing}
          title="Notifications"
          description="System notifications for approvals, blocked/finished tasks, and disabled schedules."
        >
          <NotificationsSection />
        </SettingsSection>

        <SettingsSection
          icon={FolderCog}
          title="Data Location"
          description="Where Sunny stores its local SQLite database, chats, tasks, and memory."
        >
          <DataLocationSection />
        </SettingsSection>
      </div>
    </div>
  )
}
