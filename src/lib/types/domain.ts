/**
 * Contrato de dominio de caughtcode.
 * Todos los subsistemas importan desde acá. No duplicar estos tipos.
 */

/* ── Pilares y hallazgos ─────────────────────────────────────────────── */

export type Pillar = 'security' | 'completeness' | 'store_hygiene'

export const PILLAR_LABEL: Record<Pillar, string> = {
  security: 'Seguridad',
  completeness: 'Funciona completo',
  store_hygiene: 'Listo para publicar',
}

/**
 * Qué pasó con un chequeo en una corrida: encontró algo, corrió limpio, se
 * salteó por falta de un insumo, o no se pudo completar.
 */
export type CoverageStatus = 'con_hallazgos' | 'sin_hallazgos' | 'salteado' | 'fallado'

export interface CoverageEntry {
  checkId: string
  pillar: Pillar
  status: CoverageStatus
  /** Solo si `status` es 'salteado': por qué, en lenguaje llano. */
  reasonPlain?: string
}

/** Todo lo que se revisó en una corrida, se haya encontrado algo o no. */
export interface RunCoverage {
  totalChequeos: number
  entries: CoverageEntry[]
}

export type Severity = 'critical' | 'high' | 'medium' | 'low'

export const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
}

/** Nunca se emite un hallazgo sin evidencia (DECISIONS.md D14). */
export type Confidence = 'confirmed' | 'likely' | 'to_review'

export type FindingStatus = 'open' | 'fixed' | 'dismissed'

export type Evidence =
  | { kind: 'code'; file: string; line: number; endLine?: number; snippet?: string }
  | { kind: 'recording'; agentSessionId: string; startMs: number; endMs: number; caption: string }
  | { kind: 'database'; object: string; detail: string }
  | { kind: 'http'; url: string; status: number; detail: string }
  | { kind: 'browser'; url: string; detail: string; screenshotPath?: string }

export interface Finding {
  id: string
  analysisRunId: string
  pillar: Pillar
  checkId: string
  severity: Severity
  confidence: Confidence
  status: FindingStatus
  /** Título en lenguaje llano. Cero jerga. */
  titlePlain: string
  /** Qué pasa y por qué importa, en lenguaje llano. */
  explanationPlain: string
  /** Qué podría pasar si no se arregla. Concreto, sin dramatizar. */
  impactPlain: string
  /** Prompt listo para pegar en Claude Code / Cursor / Lovable. */
  fixPrompt: string
  evidence: Evidence[]
  /** Ranking dentro de la corrida. 1..3 = destacados (D15). */
  rank: number
  videoId?: string | null
  createdAt: string
}

/** Un chequeo produce candidatos; el motor los convierte en Finding. */
export interface FindingDraft {
  checkId: string
  pillar: Pillar
  severity: Severity
  confidence: Confidence
  titlePlain: string
  explanationPlain: string
  impactPlain: string
  fixPrompt: string
  evidence: Evidence[]
  /** Tarea sugerida para que el agente de navegación lo demuestre en vivo. */
  demoTaskId?: string
}

export interface CheckDefinition {
  id: string
  pillar: Pillar
  /** Nombre corto interno. No se muestra al usuario. */
  name: string
  /** Requiere código, base de datos, app desplegada, la visita del agente, o varias. */
  requires: Array<'code' | 'database' | 'deployed_app' | 'browser_run'>
  run: (ctx: CheckContext) => Promise<FindingDraft[]>
}

export interface CheckContext {
  projectId: string
  analysisRunId: string
  /** Raíz del código descargado en disco. */
  repoPath: string
  index: CodeIndex
  stack: StackInfo
  deployedUrl?: string | null
  /** Conexión de solo lectura a la base del usuario, si la conectó. */
  databaseUrl?: string | null
  readFile: (relativePath: string) => Promise<string | null>
  log: (message: string) => void
}

/* ── Índice de código ────────────────────────────────────────────────── */

export type StackFramework =
  | 'nextjs'
  | 'react'
  | 'vite'
  | 'remix'
  | 'astro'
  | 'flutter'
  | 'python'
  | 'node'
  | 'unknown'

export interface StackInfo {
  framework: StackFramework
  language: 'typescript' | 'javascript' | 'dart' | 'python' | 'mixed' | 'unknown'
  packageManager: 'pnpm' | 'npm' | 'yarn' | 'bun' | 'pub' | 'pip' | 'unknown'
  backends: Array<'supabase' | 'firebase' | 'prisma' | 'drizzle' | 'postgres' | 'mongodb' | 'none'>
  hasTypescript: boolean
  hasTailwind: boolean
  routerKind: 'app' | 'pages' | 'go_router' | 'react-router' | 'unknown'
  evidence: string[]
}

export interface RouteInfo {
  /** Ruta pública, ej. "/proyectos/[id]". */
  path: string
  file: string
  kind: 'page' | 'layout' | 'api' | 'action' | 'screen'
  isDynamic: boolean
  /** true si el archivo (o su layout) declara "use client". */
  isClient: boolean
  /** Heurística: la ruta parece requerir sesión. */
  looksProtected: boolean
}

export interface SymbolNode {
  id: string
  name: string
  kind: 'function' | 'class' | 'component' | 'const' | 'type' | 'route'
  file: string
  line: number
  exported: boolean
}

export interface SymbolEdge {
  from: string
  to: string
  kind: 'imports' | 'calls' | 'renders'
}

export interface RankedFile {
  file: string
  score: number
  reason: string
}

export interface DbSchemaSnapshot {
  source: 'live' | 'declared' | 'none'
  tables: Array<{
    schema: string
    name: string
    rlsEnabled: boolean
    rlsForced: boolean
    columns: Array<{ name: string; type: string; nullable: boolean }>
    policies: Array<{ name: string; command: string; roles: string[]; using?: string; check?: string }>
  }>
  buckets: Array<{ name: string; public: boolean }>
  functions: Array<{ schema: string; name: string; securityDefiner: boolean; searchPath?: string }>
}

export interface CodeIndex {
  fileCount: number
  totalBytes: number
  languages: Record<string, number>
  routes: RouteInfo[]
  symbols: SymbolNode[]
  edges: SymbolEdge[]
  rankedFiles: RankedFile[]
  dbSchema: DbSchemaSnapshot
  truncated: boolean
  notes: string[]
}

/* ── Agente de navegación ────────────────────────────────────────────── */

export type AgentTaskId =
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

export interface AgentTask {
  id: AgentTaskId
  /** Objetivo en lenguaje natural para el modelo que conduce el navegador. */
  goal: string
  /** Si es true, requiere autorización explícita del usuario antes de correr. */
  destructive: boolean
  maxSteps: number
}

export interface AgentStep {
  index: number
  atMs: number
  action: string
  target?: string
  url: string
  note: string
  screenshotPath?: string
}

export type AgentOutcome = 'completed' | 'blocked' | 'not_found' | 'error' | 'skipped'

export interface AgentSessionResult {
  taskId: AgentTaskId
  outcome: AgentOutcome
  /** Conclusión en una línea, en lenguaje llano. */
  conclusionPlain: string
  steps: AgentStep[]
  recordingPath?: string
  durationMs: number
  costUsd: number
}

/* ── Video ───────────────────────────────────────────────────────────── */

export type VideoKind = 'finding' | 'tutorial'

export type VideoSceneVisual =
  | { type: 'recording'; recordingPath: string; startMs: number; endMs: number; zoom?: Rect }
  | { type: 'code'; file: string; line: number; endLine?: number; snippet: string; highlight?: number[] }
  | { type: 'statement'; headline: string; sub?: string; tone: 'alarm' | 'neutral' | 'ok' }
  | { type: 'diagram'; kind: 'tenant-leak' | 'missing-flow' | 'exposed-key'; caption: string }

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface VideoScene {
  id: string
  /** Texto que narra la voz. Español rioplatense, frases cortas. */
  narration: string
  /** Subtítulo en pantalla, más corto que la narración. */
  caption?: string
  visual: VideoSceneVisual
  durationMs: number
}

export interface VideoScript {
  kind: VideoKind
  title: string
  scenes: VideoScene[]
  totalDurationMs: number
}

export interface RenderedVideo {
  url: string
  durationSeconds: number
  transcript: string
  costUsd: number
  renderer: string
}

/* ── Trabajos en cola ────────────────────────────────────────────────── */

export type JobKind =
  | 'ingest_repo'
  | 'index_code'
  | 'run_checks'
  | 'run_browser_agent'
  | 'generate_video'
  | 'scan_comments'
  | 'build_tutorials'

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface JobRecord<TPayload = unknown> {
  id: string
  orgId: string
  projectId: string | null
  analysisRunId: string | null
  kind: JobKind
  status: JobStatus
  payload: TPayload
  attempts: number
  maxAttempts: number
  lastError: string | null
  /** Etapa actual, para mostrar progreso real y para reanudar. */
  stage: string | null
  progress: number
  leaseUntil: string | null
  createdAt: string
  updatedAt: string
}

/* ── Costos ──────────────────────────────────────────────────────────── */

export type CostCategory = 'llm' | 'tts' | 'browser_agent' | 'render' | 'storage'

export interface CostEntry {
  category: CostCategory
  units: number
  unitLabel: string
  costUsd: number
  detail?: string
}

export interface CostBreakdown {
  entries: CostEntry[]
  totalUsd: number
}

/* ── Corridas de análisis ────────────────────────────────────────────── */

export type RunStatus = 'queued' | 'running' | 'partial' | 'succeeded' | 'failed' | 'cancelled'

export interface AnalysisRun {
  id: string
  projectId: string
  status: RunStatus
  stage: string | null
  progress: number
  startedAt: string | null
  finishedAt: string | null
  costBreakdown: CostBreakdown | null
  error: string | null
}

/* ── Limpieza de comentarios ─────────────────────────────────────────── */

export type CommentReach = 'ships_to_browser' | 'server_only' | 'build_only'

export type CommentRisk = 'secret' | 'internal_note' | 'todo' | 'disabled_code' | 'none'

export interface CommentHit {
  file: string
  line: number
  endLine: number
  /** Texto del comentario, recortado. */
  text: string
  syntax: 'line' | 'block' | 'jsx' | 'html' | 'css'
  reach: CommentReach
  risk: CommentRisk
  /** Comentario funcional que no se debe borrar (directivas, licencias). */
  functional: boolean
  reason?: string
}

export interface CommentScanResult {
  scannedFiles: number
  hits: CommentHit[]
  /** Comentarios que llegan al navegador del visitante. */
  exposedCount: number
  riskyCount: number
  removableCount: number
}

export interface CommentCleanPlan {
  mode: 'safe' | 'aggressive'
  files: Array<{
    file: string
    removed: number
    kept: number
    before: string
    after: string
  }>
  totalRemoved: number
  totalKept: number
}
