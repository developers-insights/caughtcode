/**
 * Qué función corre cada tarea.
 *
 * Lo usan: `src/server/agent/index.ts`.
 */

import 'server-only'

import type { AgentTaskId } from '@/lib/types/domain'
import type { TaskContext, TaskOutcomeDraft } from './shared'
import { runCookieBanner } from './consent'
import { runCrossTenantRead } from './cross-tenant'
import { runEditProfile, runLogin, runPrimaryFlow, runSignup } from './explore'
import { runPrivacyTerms } from './legal-pages'
import { runDeleteAccount, runLogout, runPasswordReset } from './missing-flow'

export type TaskRunner = (context: TaskContext) => Promise<TaskOutcomeDraft>

export const TASK_RUNNERS: Record<AgentTaskId, TaskRunner> = {
  signup: runSignup,
  login: runLogin,
  password_reset: runPasswordReset,
  logout: runLogout,
  delete_account: runDeleteAccount,
  edit_profile: runEditProfile,
  cross_tenant_read: runCrossTenantRead,
  primary_flow: runPrimaryFlow,
  cookie_banner: runCookieBanner,
  privacy_terms: runPrivacyTerms,
}

export type { TaskContext, TaskOutcomeDraft } from './shared'
