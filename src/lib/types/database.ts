/**
 * Tipos de la base de datos de caughtcode.
 *
 * Escritos a mano y mantenidos junto a `supabase/migrations/**`. Si cambia una
 * migración, cambia este archivo en el mismo commit.
 *
 * ⚠️ TODO lleva sufijo `_caughtcode`. caughtcode no tiene proyecto propio de
 * Supabase: vive dentro de uno compartido con otro producto en producción, y el
 * esquema `public` es de los dos. No escribas los nombres a mano en el resto del
 * código — importá las constantes de `src/lib/db/tablas.ts`.
 *
 * ⚠️ NO correr `pnpm db:types`: ese script sobrescribe este archivo con la
 * salida de `supabase gen types`, que pierde el tipado fuerte de las columnas
 * jsonb (quedarían todas como `Json`). Ver `supabase/README.md`.
 *
 * Las columnas jsonb apuntan a los tipos de `domain.ts` siempre que el contrato
 * lo define sin ambigüedad. Las que todavía no tienen forma acordada quedan
 * como `Json` a propósito: mejor sin tipo que con un tipo inventado.
 */

import type {
  AgentStep,
  CommentHit,
  CostBreakdown,
  DbSchemaSnapshot,
  Evidence,
  RankedFile,
  RouteInfo,
  RunCoverage,
  StackInfo,
  VideoScript,
} from './domain'

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

/**
 * Forma de inserción: `Requeridas` son las columnas sin default que no admiten
 * null. Todo lo demás es opcional porque la base lo completa o acepta null.
 */
type Insertable<Row, Requeridas extends keyof Row = never> = Pick<Row, Requeridas> &
  Partial<Omit<Row, Requeridas>>

/** Forma de actualización: cualquier subconjunto de columnas. */
type Updatable<Row> = Partial<Row>

/* ── Filas ─────────────────────────────────────────────────────────────────
 * Reflejo exacto de las tablas. Se pueden importar sueltas cuando no hace
 * falta el cliente tipado.
 *
 * Van como `type` y no como `interface` a propósito: @supabase/supabase-js
 * exige que cada fila sea asignable a `Record<string, unknown>`, y solo los
 * alias de tipo tienen index signature implícita. Con `interface`, el cliente
 * cae en silencio a `never` y se pierde todo el tipado.
 */

export type OrganizationRow = {
  id: string
  name: string
  owner_user_id: string
  /** Sin CHECK en la base: el vocabulario lo define el frente de monetización. */
  plan: string
  created_at: string
}

export type OrgMemberRow = {
  org_id: string
  user_id: string
  role: 'owner' | 'admin' | 'member'
  created_at: string
}

export type ProjectRow = {
  id: string
  org_id: string
  name: string
  /** Para agencias: de qué cliente es esta app. */
  client_name: string | null
  source_type: 'github' | 'github_public' | 'zip'
  repo_url: string | null
  repo_ref: string | null
  deployed_url: string | null
  stack_detected: StackInfo | null
  /** Prefijo dentro del bucket `repos`. */
  storage_path: string | null
  retention_days: number
  created_at: string
  /** Baja lógica de la papelera. El borrado real es `delete_project_cascade`. */
  deleted_at: string | null
}

export type ProjectConnectionRow = {
  id: string
  project_id: string
  provider: 'github' | 'supabase'
  /** Referencia al secreto cifrado. Nunca el token en claro. */
  credentials_ref: string
  scopes: string[]
  created_at: string
}

export type AnalysisRunRow = {
  id: string
  project_id: string
  status: 'queued' | 'running' | 'partial' | 'succeeded' | 'failed' | 'cancelled'
  stage: string | null
  progress: number
  started_at: string | null
  finished_at: string | null
  cost_breakdown: CostBreakdown | null
  error: string | null
  coverage: RunCoverage | null
  created_at: string
}

export type CodeIndexRow = {
  id: string
  analysis_run_id: string
  /** Grafo de símbolos y referencias. Forma todavía no fijada en el contrato. */
  symbol_graph: Json
  routes: RouteInfo[]
  ranked_files: RankedFile[]
  db_schema: DbSchemaSnapshot
  stats: Json
  created_at: string
}

export type FindingRow = {
  id: string
  analysis_run_id: string
  project_id: string
  pillar: 'security' | 'completeness' | 'store_hygiene'
  check_id: string
  severity: 'critical' | 'high' | 'medium' | 'low'
  confidence: 'confirmed' | 'likely' | 'to_review'
  status: 'open' | 'fixed' | 'dismissed'
  title_plain: string
  explanation_plain: string
  impact_plain: string
  fix_prompt: string
  /** La base rechaza el arreglo vacío: ningún hallazgo sin evidencia. */
  evidence: Evidence[]
  /** 1..3 son los destacados; la base impide que haya más de tres por corrida. */
  rank: number
  video_id: string | null
  created_at: string
  resolved_at: string | null
}

export type AgentSessionRow = {
  id: string
  analysis_run_id: string
  task_id:
    | 'signup'
    | 'login'
    | 'password_reset'
    | 'logout'
    | 'delete_account'
    | 'edit_profile'
    | 'cross_tenant_read'
    | 'primary_flow'
    | 'cookie_banner'
    | 'privacy_terms'
  outcome: 'completed' | 'blocked' | 'not_found' | 'error' | 'skipped'
  conclusion_plain: string
  /** Objeto del bucket `recordings`. */
  recording_url: string | null
  steps: AgentStep[]
  duration_ms: number
  cost_usd: number
  created_at: string
}

export type VideoRow = {
  id: string
  finding_id: string | null
  /** Ancla de tenencia. Al menos uno de finding_id / project_id tiene que estar. */
  project_id: string | null
  module_id: string | null
  kind: 'finding' | 'tutorial'
  status: 'queued' | 'rendering' | 'ready' | 'failed'
  duration_s: number | null
  url: string | null
  transcript: string | null
  script: VideoScript | null
  cost_usd: number
  error: string | null
  created_at: string
}

export type CommentScanRow = {
  id: string
  project_id: string
  analysis_run_id: string | null
  scanned_files: number
  /** Comentarios que llegan al navegador del visitante. */
  exposed_count: number
  risky_count: number
  removable_count: number
  hits: CommentHit[]
  created_at: string
}

export type CommentCleanupRow = {
  id: string
  project_id: string
  scan_id: string
  mode: 'safe' | 'aggressive'
  files_changed: number
  comments_removed: number
  patch_path: string | null
  status: 'pending' | 'ready' | 'applied' | 'failed'
  created_at: string
}

export type ChatThreadRow = {
  id: string
  project_id: string
  user_id: string
  title: string
  created_at: string
}

export type ChatMessageRow = {
  id: string
  thread_id: string
  /** El cliente solo puede insertar `user`. El resto lo escribe el servidor. */
  role: 'user' | 'assistant' | 'system'
  content: string
  citations: Json | null
  created_at: string
}

export type UsageEventRow = {
  id: string
  org_id: string
  project_id: string | null
  /** Corrida que generó el consumo. Permite el costo exacto por auditoría. */
  analysis_run_id: string | null
  kind: 'llm' | 'tts' | 'browser_agent' | 'render' | 'storage'
  units: number
  /** Unidad legible: "minutos de video", "caracteres narrados". */
  unit_label: string
  cost_usd: number
  /** `CostEntry.detail`. Ej: "narración del hallazgo 2". */
  detail: string | null
  created_at: string
}

export type SubscriptionRow = {
  id: string
  org_id: string
  stripe_customer_id: string
  stripe_subscription_id: string | null
  plan: string
  status:
    | 'incomplete'
    | 'incomplete_expired'
    | 'trialing'
    | 'active'
    | 'past_due'
    | 'canceled'
    | 'unpaid'
    | 'paused'
  current_period_end: string | null
  created_at: string
  updated_at: string
}

export type JobRow = {
  id: string
  org_id: string
  project_id: string | null
  analysis_run_id: string | null
  kind:
    | 'ingest_repo'
    | 'index_code'
    | 'run_checks'
    | 'run_browser_agent'
    | 'generate_video'
    | 'scan_comments'
    | 'build_tutorials'
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  payload: Json
  attempts: number
  max_attempts: number
  last_error: string | null
  stage: string | null
  progress: number
  lease_until: string | null
  run_after: string
  created_at: string
  updated_at: string
}

/** Lo que devuelven `delete_project_cascade` y `delete_account`. */
export type DeleteResult = {
  project_id?: string
  user_id?: string
  org_id?: string
  orgs_deleted?: string[]
  /** Archivos que quedaron huérfanos en Storage. Hay que borrarlos aparte. */
  storage_objects: string[]
}

/* ── Esquema ───────────────────────────────────────────────────────────── */

export type Database = {
  public: {
    Tables: {
      organizations_caughtcode: {
        Row: OrganizationRow
        Insert: Insertable<OrganizationRow, 'name' | 'owner_user_id'>
        Update: Updatable<OrganizationRow>
        Relationships: []
      }
      org_members_caughtcode: {
        Row: OrgMemberRow
        Insert: Insertable<OrgMemberRow, 'org_id' | 'user_id'>
        Update: Updatable<OrgMemberRow>
        Relationships: [
          {
            foreignKeyName: 'org_members_caughtcode_org_id_fkey'
            columns: ['org_id']
            isOneToOne: false
            referencedRelation: 'organizations_caughtcode'
            referencedColumns: ['id']
          },
        ]
      }
      projects_caughtcode: {
        Row: ProjectRow
        Insert: Insertable<ProjectRow, 'org_id' | 'name' | 'source_type'>
        Update: Updatable<ProjectRow>
        Relationships: [
          {
            foreignKeyName: 'projects_caughtcode_org_id_fkey'
            columns: ['org_id']
            isOneToOne: false
            referencedRelation: 'organizations_caughtcode'
            referencedColumns: ['id']
          },
        ]
      }
      project_connections_caughtcode: {
        Row: ProjectConnectionRow
        Insert: Insertable<ProjectConnectionRow, 'project_id' | 'provider' | 'credentials_ref'>
        Update: Updatable<ProjectConnectionRow>
        Relationships: [
          {
            foreignKeyName: 'project_connections_caughtcode_project_id_fkey'
            columns: ['project_id']
            isOneToOne: false
            referencedRelation: 'projects_caughtcode'
            referencedColumns: ['id']
          },
        ]
      }
      analysis_runs_caughtcode: {
        Row: AnalysisRunRow
        Insert: Insertable<AnalysisRunRow, 'project_id'>
        Update: Updatable<AnalysisRunRow>
        Relationships: [
          {
            foreignKeyName: 'analysis_runs_caughtcode_project_id_fkey'
            columns: ['project_id']
            isOneToOne: false
            referencedRelation: 'projects_caughtcode'
            referencedColumns: ['id']
          },
        ]
      }
      code_index_caughtcode: {
        Row: CodeIndexRow
        Insert: Insertable<CodeIndexRow, 'analysis_run_id'>
        Update: Updatable<CodeIndexRow>
        Relationships: [
          {
            foreignKeyName: 'code_index_caughtcode_analysis_run_id_fkey'
            columns: ['analysis_run_id']
            isOneToOne: true
            referencedRelation: 'analysis_runs_caughtcode'
            referencedColumns: ['id']
          },
        ]
      }
      findings_caughtcode: {
        Row: FindingRow
        Insert: Insertable<
          FindingRow,
          | 'analysis_run_id'
          | 'project_id'
          | 'pillar'
          | 'check_id'
          | 'severity'
          | 'confidence'
          | 'title_plain'
          | 'explanation_plain'
          | 'impact_plain'
          | 'fix_prompt'
          | 'evidence'
        >
        Update: Updatable<FindingRow>
        Relationships: [
          {
            foreignKeyName: 'findings_caughtcode_analysis_run_id_fkey'
            columns: ['analysis_run_id']
            isOneToOne: false
            referencedRelation: 'analysis_runs_caughtcode'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'findings_caughtcode_project_id_fkey'
            columns: ['project_id']
            isOneToOne: false
            referencedRelation: 'projects_caughtcode'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'findings_video_id_fkey_caughtcode'
            columns: ['video_id']
            isOneToOne: false
            referencedRelation: 'videos_caughtcode'
            referencedColumns: ['id']
          },
        ]
      }
      agent_sessions_caughtcode: {
        Row: AgentSessionRow
        Insert: Insertable<
          AgentSessionRow,
          'analysis_run_id' | 'task_id' | 'outcome' | 'conclusion_plain'
        >
        Update: Updatable<AgentSessionRow>
        Relationships: [
          {
            foreignKeyName: 'agent_sessions_caughtcode_analysis_run_id_fkey'
            columns: ['analysis_run_id']
            isOneToOne: false
            referencedRelation: 'analysis_runs_caughtcode'
            referencedColumns: ['id']
          },
        ]
      }
      videos_caughtcode: {
        Row: VideoRow
        Insert: Insertable<VideoRow, 'kind'>
        Update: Updatable<VideoRow>
        Relationships: [
          {
            foreignKeyName: 'videos_caughtcode_finding_id_fkey'
            columns: ['finding_id']
            isOneToOne: false
            referencedRelation: 'findings_caughtcode'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'videos_caughtcode_project_id_fkey'
            columns: ['project_id']
            isOneToOne: false
            referencedRelation: 'projects_caughtcode'
            referencedColumns: ['id']
          },
        ]
      }
      comment_scans_caughtcode: {
        Row: CommentScanRow
        Insert: Insertable<CommentScanRow, 'project_id'>
        Update: Updatable<CommentScanRow>
        Relationships: [
          {
            foreignKeyName: 'comment_scans_caughtcode_project_id_fkey'
            columns: ['project_id']
            isOneToOne: false
            referencedRelation: 'projects_caughtcode'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'comment_scans_caughtcode_analysis_run_id_fkey'
            columns: ['analysis_run_id']
            isOneToOne: false
            referencedRelation: 'analysis_runs_caughtcode'
            referencedColumns: ['id']
          },
        ]
      }
      comment_cleanups_caughtcode: {
        Row: CommentCleanupRow
        Insert: Insertable<CommentCleanupRow, 'project_id' | 'scan_id' | 'mode'>
        Update: Updatable<CommentCleanupRow>
        Relationships: [
          {
            foreignKeyName: 'comment_cleanups_caughtcode_project_id_fkey'
            columns: ['project_id']
            isOneToOne: false
            referencedRelation: 'projects_caughtcode'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'comment_cleanups_caughtcode_scan_id_fkey'
            columns: ['scan_id']
            isOneToOne: false
            referencedRelation: 'comment_scans_caughtcode'
            referencedColumns: ['id']
          },
        ]
      }
      chat_threads_caughtcode: {
        Row: ChatThreadRow
        Insert: Insertable<ChatThreadRow, 'project_id' | 'user_id'>
        Update: Updatable<ChatThreadRow>
        Relationships: [
          {
            foreignKeyName: 'chat_threads_caughtcode_project_id_fkey'
            columns: ['project_id']
            isOneToOne: false
            referencedRelation: 'projects_caughtcode'
            referencedColumns: ['id']
          },
        ]
      }
      chat_messages_caughtcode: {
        Row: ChatMessageRow
        Insert: Insertable<ChatMessageRow, 'thread_id' | 'role' | 'content'>
        Update: Updatable<ChatMessageRow>
        Relationships: [
          {
            foreignKeyName: 'chat_messages_caughtcode_thread_id_fkey'
            columns: ['thread_id']
            isOneToOne: false
            referencedRelation: 'chat_threads_caughtcode'
            referencedColumns: ['id']
          },
        ]
      }
      usage_events_caughtcode: {
        Row: UsageEventRow
        Insert: Insertable<UsageEventRow, 'org_id' | 'kind' | 'unit_label'>
        Update: Updatable<UsageEventRow>
        Relationships: [
          {
            foreignKeyName: 'usage_events_caughtcode_org_id_fkey'
            columns: ['org_id']
            isOneToOne: false
            referencedRelation: 'organizations_caughtcode'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'usage_events_caughtcode_project_id_fkey'
            columns: ['project_id']
            isOneToOne: false
            referencedRelation: 'projects_caughtcode'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'usage_events_analysis_run_id_fkey_caughtcode'
            columns: ['analysis_run_id']
            isOneToOne: false
            referencedRelation: 'analysis_runs_caughtcode'
            referencedColumns: ['id']
          },
        ]
      }
      subscriptions_caughtcode: {
        Row: SubscriptionRow
        Insert: Insertable<SubscriptionRow, 'org_id' | 'stripe_customer_id'>
        Update: Updatable<SubscriptionRow>
        Relationships: [
          {
            foreignKeyName: 'subscriptions_caughtcode_org_id_fkey'
            columns: ['org_id']
            isOneToOne: true
            referencedRelation: 'organizations_caughtcode'
            referencedColumns: ['id']
          },
        ]
      }
      jobs_caughtcode: {
        Row: JobRow
        Insert: Insertable<JobRow, 'org_id' | 'kind'>
        Update: Updatable<JobRow>
        Relationships: [
          {
            foreignKeyName: 'jobs_caughtcode_org_id_fkey'
            columns: ['org_id']
            isOneToOne: false
            referencedRelation: 'organizations_caughtcode'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'jobs_caughtcode_project_id_fkey'
            columns: ['project_id']
            isOneToOne: false
            referencedRelation: 'projects_caughtcode'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'jobs_caughtcode_analysis_run_id_fkey'
            columns: ['analysis_run_id']
            isOneToOne: false
            referencedRelation: 'analysis_runs_caughtcode'
            referencedColumns: ['id']
          },
        ]
      }
    }
    Views: { [_ in never]: never }
    Functions: {
      /**
       * Crea el espacio de trabajo personal si no existe y devuelve su id.
       * Idempotente. La llama el frente de auth en el primer ingreso: no hay
       * trigger sobre `auth.users` porque la base es compartida.
       */
      ensure_org_caughtcode: { Args: { p_user_id?: string | null }; Returns: string }
      /** true si quien pide es miembro de esa organización. */
      is_org_member_caughtcode: { Args: { org: string }; Returns: boolean }
      /** true si además es owner o admin. */
      is_org_admin_caughtcode: { Args: { org: string }; Returns: boolean }
      org_of_project_caughtcode: { Args: { p_project_id: string }; Returns: string | null }
      org_of_run_caughtcode: { Args: { p_analysis_run_id: string }; Returns: string | null }
      org_of_finding_caughtcode: { Args: { p_finding_id: string }; Returns: string | null }
      org_of_thread_caughtcode: { Args: { p_thread_id: string }; Returns: string | null }
      /** Solo service_role. Devuelve null si no hay nada en cola. */
      claim_job_caughtcode: {
        Args: { p_kinds?: string[] | null; p_lease_seconds?: number }
        Returns: JobRow | null
      }
      /** Solo service_role. Devuelve cuántos trabajos volvió a encolar o marcó failed. */
      requeue_expired_jobs_caughtcode: { Args: Record<string, never>; Returns: number }
      /** Borra el proyecto entero. Los archivos de Storage los borra el llamador. */
      delete_project_cascade_caughtcode: { Args: { p_project_id: string }; Returns: DeleteResult }
      /** Borra las organizaciones propias. No toca auth.users. */
      delete_account_caughtcode: { Args: { p_user_id: string }; Returns: DeleteResult }
      /** Única vía para que el cliente marque un hallazgo como resuelto. */
      set_finding_status_caughtcode: {
        Args: { p_finding_id: string; p_status: FindingRow['status'] }
        Returns: FindingRow
      }
    }
    Enums: { [_ in never]: never }
    CompositeTypes: { [_ in never]: never }
  }
}

/* ── Atajos ────────────────────────────────────────────────────────────── */

export type PublicSchema = Database['public']

export type Tables<T extends keyof PublicSchema['Tables']> = PublicSchema['Tables'][T]['Row']
export type TablesInsert<T extends keyof PublicSchema['Tables']> = PublicSchema['Tables'][T]['Insert']
export type TablesUpdate<T extends keyof PublicSchema['Tables']> = PublicSchema['Tables'][T]['Update']
export type Functions<T extends keyof PublicSchema['Functions']> = PublicSchema['Functions'][T]
