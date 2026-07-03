import type { Migration } from '../migrate'
import { migration001 } from './001_init'
import { migration002 } from './002_memory_graph'
import { migration003 } from './003_chat_agent'
import { migration004 } from './004_agent_web_access'
import { migration005 } from './005_message_attachments'
import { migration006 } from './006_org_layer'
import { migration007 } from './007_schedule_failures'

// The ordered list of all migrations. Append new ones here with the next
// version number; runMigrations sorts and applies only the pending ones.
export const migrations: Migration[] = [
  migration001,
  migration002,
  migration003,
  migration004,
  migration005,
  migration006,
  migration007
]

export { DEFAULT_EMBEDDING_DIM } from './001_init'
