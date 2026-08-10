/**
 * Nombres de los objetos de caughtcode en la base.
 *
 * caughtcode NO tiene un proyecto de Supabase propio: comparte el esquema
 * `public` con otro producto que ya está en producción. Por eso todo lo nuestro
 * lleva el sufijo `_caughtcode`.
 *
 * **Regla:** en el resto del código no se escriben estos nombres a mano. Nada de
 * `.from('findings_caughtcode')`. Va siempre `.from(T.findings)`. Así, si el
 * sufijo cambia o una tabla se renombra, se toca un solo archivo y el
 * typechecker marca todo lo que haya quedado colgado.
 *
 * `satisfies` ata cada constante al esquema real: si un nombre no existe en
 * `Database`, esto no compila.
 */

import type { Database } from '@/lib/types/database'

type Tabla = keyof Database['public']['Tables']
type Funcion = keyof Database['public']['Functions']

/** Sufijo obligatorio de todo objeto nuestro en la base compartida. */
export const SUFIJO = '_caughtcode' as const

/** Tablas. */
export const T = {
  organizations: 'organizations_caughtcode',
  orgMembers: 'org_members_caughtcode',
  projects: 'projects_caughtcode',
  projectConnections: 'project_connections_caughtcode',
  analysisRuns: 'analysis_runs_caughtcode',
  codeIndex: 'code_index_caughtcode',
  findings: 'findings_caughtcode',
  agentSessions: 'agent_sessions_caughtcode',
  videos: 'videos_caughtcode',
  commentScans: 'comment_scans_caughtcode',
  commentCleanups: 'comment_cleanups_caughtcode',
  chatThreads: 'chat_threads_caughtcode',
  chatMessages: 'chat_messages_caughtcode',
  usageEvents: 'usage_events_caughtcode',
  subscriptions: 'subscriptions_caughtcode',
  jobs: 'jobs_caughtcode',
} as const satisfies Record<string, Tabla>

/** Funciones que se llaman por RPC. */
export const F = {
  /** Crea el espacio de trabajo personal si falta. Idempotente. */
  ensureOrg: 'ensure_org_caughtcode',
  isOrgMember: 'is_org_member_caughtcode',
  isOrgAdmin: 'is_org_admin_caughtcode',
  orgOfProject: 'org_of_project_caughtcode',
  orgOfRun: 'org_of_run_caughtcode',
  orgOfFinding: 'org_of_finding_caughtcode',
  orgOfThread: 'org_of_thread_caughtcode',
  /** Solo service_role. */
  claimJob: 'claim_job_caughtcode',
  /** Solo service_role. */
  requeueExpiredJobs: 'requeue_expired_jobs_caughtcode',
  deleteProjectCascade: 'delete_project_cascade_caughtcode',
  deleteAccount: 'delete_account_caughtcode',
  /** Única vía para que el cliente marque un hallazgo como resuelto. */
  setFindingStatus: 'set_finding_status_caughtcode',
} as const satisfies Record<string, Funcion>

/**
 * Buckets de Storage. Las rutas van siempre
 * `<bucket>/<org_id>/<project_id>/...` — ver `supabase/README.md`.
 */
export const B = {
  repos: 'repos_caughtcode',
  recordings: 'recordings_caughtcode',
  videos: 'videos_caughtcode',
} as const

/** Tablas con Realtime habilitado (progreso en vivo de la auditoría). */
export const REALTIME = [T.analysisRuns, T.findings] as const

export type NombreTabla = (typeof T)[keyof typeof T]
export type NombreFuncion = (typeof F)[keyof typeof F]
export type NombreBucket = (typeof B)[keyof typeof B]
