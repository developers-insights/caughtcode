/**
 * Handler del trabajo `run_checks`: donde los chequeos se vuelven filas.
 *
 * Tres etapas, y las tres son reanudables. Si el worker se muere en la tercera,
 * al reintentar no se vuelve a leer el índice ni a revisar el proyecto.
 *
 *   1. leer el índice de código de la corrida
 *   2. revisar el proyecto y guardar lo que se encontró
 *   3. dejar registrado qué NO se pudo revisar
 *
 * ## Idempotencia
 *
 * La regla que fijó el frente de la cola: **borrar-y-reinsertar por
 * (`analysis_run_id`, `check_id`)**. Un handler puede correr dos veces —el
 * worker se murió después de escribir y antes de marcar el trabajo como
 * terminado— y la segunda corrida no puede duplicar hallazgos.
 *
 * Con un matiz que importa: se borra por **todos los chequeos que corrieron**,
 * no solo por los que encontraron algo. Si el usuario arregló el problema, el
 * chequeo ahora no devuelve nada, y borrar solo "lo que encontró" dejaría el
 * hallazgo viejo colgado para siempre. El usuario vería un problema resuelto
 * como si siguiera abierto.
 *
 * ## Nada sin evidencia
 *
 * El motor ya descarta los candidatos sin evidencia, pero acá se vuelve a
 * verificar antes del `insert`. Es la última puerta antes de la base, y el
 * costo de revisar dos veces es cero comparado con el de publicar un hallazgo
 * que no se puede probar (D14).
 */

import type {
  AgentSessionResult,
  CodeIndex,
  CostEntry,
  CoverageEntry,
  DbSchemaSnapshot,
  Evidence,
  RunCoverage,
  StackInfo,
} from '@/lib/types/domain'
import { describeError, enqueue, registerHandler, runStages } from '@/server/jobs'
import type { JobContext, JobHandler, StageStore } from '@/server/jobs'
import { describeDbError, jobsDb, type JobsDb } from '@/server/jobs/db'
import { JobError } from '@/server/jobs/errors'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { T } from '@/lib/db/tablas'
import type { AgentEvidence } from './agent-input'
import type { Check, CheckRunContext, CompleteFn } from './lib/context'
import { sondaFetch } from './lib/http'
import type { HttpProbe } from './lib/http'
import { conectarPg } from './lib/pg-readonly'
import type { SqlConnect } from './lib/pg-readonly'
import { CHEQUEOS } from './registry'
import { correrChequeos } from './runner'
import type { HallazgoRankeado, ResultadoCorrida } from './runner'

/* ── Lo que llega en el trabajo ───────────────────────────────────────── */

export interface RunChecksPayload {
  /** Carpeta donde `ingest_repo` dejó el código. */
  repoPath: string
  /** Dirección de la app publicada, si el usuario la dio. */
  deployedUrl?: string | null
  /** Conexión de **solo lectura** a la base del usuario, si la conectó. */
  databaseUrl?: string | null
  /**
   * Lo que observó el agente de navegación. Las sesiones se leen de la base;
   * esto trae lo que no entra en esa tabla (pedidos de red, cookies, medidas
   * de pantalla, accesibilidad).
   */
  agentEvidence?: Omit<AgentEvidence, 'sessions'>
}

/* ── Inyección de dependencias ────────────────────────────────────────── */

export interface DependenciasRunChecks {
  db?: () => Promise<JobsDb>
  store?: StageStore
  http?: HttpProbe
  connect?: SqlConnect
  complete?: CompleteFn
  checks?: Check[]
  /** Cómo se encolan los videos. Se inyecta en los tests. */
  encolar?: typeof enqueue
}

/* ── Etapas: el texto lo lee el usuario ───────────────────────────────── */

const ETAPAS = {
  indice: 'Viendo cómo está armado tu proyecto',
  revisar: 'Revisando tu proyecto',
  cerrar: 'Ordenando lo que encontramos',
  videos: 'Preparando los videos de lo más importante',
} as const

/* ── Handler ──────────────────────────────────────────────────────────── */

export function crearHandlerRunChecks(
  deps: DependenciasRunChecks = {},
): JobHandler<RunChecksPayload> {
  return async (payload, ctx) => {
    const abrirDb = deps.db ?? jobsDb
    const analysisRunId = exigirCorrida(ctx)

    await runStages(
      ctx,
      [
        {
          name: 'leer_indice',
          label: ETAPAS.indice,
          progress: 10,
          run: async () => {
            const db = await abrirDb()
            const index = await leerCodeIndex(db, analysisRunId)
            return { archivos: index.fileCount, rutas: index.routes.length }
          },
        },
        {
          name: 'revisar_y_guardar',
          label: ETAPAS.revisar,
          progress: 90,
          run: async (helper) => {
            const db = await abrirDb()
            const resultado = await revisar(db, payload, ctx, deps, helper.heartbeat)
            const guardados = await guardarHallazgos(db, ctx, analysisRunId, resultado, deps)
            return resumenDe(resultado, guardados, deps.checks ?? CHEQUEOS)
          },
        },
        {
          name: 'registrar_cobertura',
          label: ETAPAS.cerrar,
          // Antes cerraba en 100. Ahora hay una etapa más después, y el avance
          // no puede ir para atrás en la pantalla del usuario.
          progress: 95,
          run: async (helper) => {
            const resumen = helper.get<ResumenGuardado>('revisar_y_guardar')
            if (!resumen) return { anotado: false }
            for (const linea of resumen.avisos) ctx.log(linea)

            const db = await abrirDb()
            const { error } = await db
              .from(T.analysisRuns)
              .update({ coverage: resumen.cobertura })
              .eq('id', analysisRunId)
            // No es crítico: el usuario ya tiene sus hallazgos. Si esto falla,
            // la pantalla de "qué revisamos" queda vacía, pero nada se pierde.
            if (error) ctx.log(`No se pudo guardar el detalle de cobertura: ${describeDbError(error)}`)

            return { anotado: true }
          },
        },
        {
          name: 'encolar_videos',
          label: ETAPAS.videos,
          progress: 100,
          run: async () => encolarVideos(await abrirDb(), payload, ctx, deps),
        },
      ],
      deps.store ? { store: deps.store } : {},
    )
  }
}

function exigirCorrida(ctx: JobContext): string {
  if (!ctx.analysisRunId) {
    throw new JobError('El trabajo de revisión llegó sin corrida asociada.', {
      retryable: false,
      code: 'sin_corrida',
    })
  }
  return ctx.analysisRunId
}

/* ── Etapa 2a: correr los chequeos ────────────────────────────────────── */

async function revisar(
  db: JobsDb,
  payload: RunChecksPayload,
  ctx: JobContext,
  deps: DependenciasRunChecks,
  heartbeat: (progress?: number) => Promise<void>,
): Promise<ResultadoCorrida> {
  const analysisRunId = exigirCorrida(ctx)

  const index = await leerCodeIndex(db, analysisRunId)
  const stack = await leerStack(db, ctx.projectId)
  const sessions = await leerSesionesDelAgente(db, analysisRunId)

  await heartbeat(25)

  const deployedUrl = payload.deployedUrl ?? null
  const agent: AgentEvidence | undefined =
    sessions.length > 0 || payload.agentEvidence
      ? { sessions, ...(payload.agentEvidence ?? {}) }
      : undefined

  const contexto: CheckRunContext = {
    projectId: ctx.projectId ?? '',
    analysisRunId,
    repoPath: payload.repoPath,
    index,
    stack,
    deployedUrl,
    databaseUrl: payload.databaseUrl ?? null,
    readFile: async (relativa) => {
      // Nunca se sale de la carpeta del proyecto, venga de donde venga la ruta.
      const destino = path.resolve(payload.repoPath, relativa)
      if (!destino.startsWith(path.resolve(payload.repoPath))) return null
      try {
        return await readFile(destino, 'utf8')
      } catch {
        return null
      }
    },
    log: ctx.log,
    agent,
    http: deployedUrl ? (deps.http ?? sondaFetch) : undefined,
    connect: payload.databaseUrl ? (deps.connect ?? conectarPg) : undefined,
    complete: deps.complete,
  }

  const resultado = await correrChequeos(contexto, {
    checks: deps.checks ?? CHEQUEOS,
  })

  await heartbeat(70)

  // Costo real de la revisión, para que el precio no sea una adivinanza.
  for (const costo of resultado.costos) await ctx.reportCost(costo)
  if (resultado.costos.length === 0) {
    await ctx.reportCost(costoDeRevision(resultado))
  }

  for (const fallado of resultado.fallados) {
    ctx.log(`El chequeo ${fallado.checkId} falló y no se pudo completar: ${fallado.error}`)
  }
  for (const descartado of resultado.descartados) {
    // Un candidato sin evidencia es un bug nuestro, no un hallazgo del usuario.
    ctx.log(`Se descartó un hallazgo de ${descartado.checkId}: ${descartado.detalle}`)
  }

  return resultado
}

function costoDeRevision(resultado: ResultadoCorrida): CostEntry {
  return {
    category: 'llm',
    units: resultado.chequeosCorridos,
    unitLabel: 'revisiones hechas',
    costUsd: 0,
    detail: 'Revisión del código y de la base. No usó modelo de lenguaje.',
  }
}

/* ── Etapa 2b: guardar ────────────────────────────────────────────────── */

interface ResumenGuardado {
  guardados: number
  descartados: number
  salteados: number
  avisos: string[]
  cobertura: RunCoverage
}

async function guardarHallazgos(
  db: JobsDb,
  ctx: JobContext,
  analysisRunId: string,
  resultado: ResultadoCorrida,
  deps: DependenciasRunChecks,
): Promise<number> {
  const checks = deps.checks ?? CHEQUEOS
  const corridos = new Set<string>()
  for (const check of checks) {
    if (!resultado.salteados.some((s) => s.checkId === check.id)) corridos.add(check.id)
  }
  // Un chequeo que emitió algo corrió, por más que la lista diga otra cosa.
  for (const hallazgo of resultado.findings) {
    for (const checkId of hallazgo.detectadoPor) corridos.add(checkId)
  }

  // ── Borrar lo viejo de esos chequeos ────────────────────────────────
  if (corridos.size > 0) {
    const { error } = await db
      .from(T.findings)
      .delete()
      .eq('analysis_run_id', analysisRunId)
      .in('check_id', [...corridos])

    if (error) {
      throw new JobError(
        `No se pudieron limpiar los hallazgos previos: ${describeDbError(error)}`,
        { retryable: true, code: 'limpieza_fallida' },
      )
    }
  }

  // ── Última puerta antes de la base ──────────────────────────────────
  const conEvidencia = resultado.findings.filter((hallazgo) => {
    if (hallazgo.evidence && hallazgo.evidence.length > 0) return true
    ctx.log(
      `No se guardó "${hallazgo.titlePlain}" (${hallazgo.checkId}): llegó sin evidencia. ` +
        'Es un error del chequeo, no un hallazgo.',
    )
    return false
  })

  if (conEvidencia.length === 0) return 0

  const filas = conEvidencia.map((hallazgo) => aFila(hallazgo, analysisRunId, ctx.projectId))

  const { error } = await db.from(T.findings).insert(filas)
  if (error) {
    throw new JobError(`No se pudieron guardar los hallazgos: ${describeDbError(error)}`, {
      retryable: true,
      code: 'guardado_fallido',
    })
  }

  return filas.length
}

function aFila(
  hallazgo: HallazgoRankeado,
  analysisRunId: string,
  projectId: string | null,
): Record<string, unknown> {
  return {
    analysis_run_id: analysisRunId,
    project_id: projectId,
    pillar: hallazgo.pillar,
    check_id: hallazgo.checkId,
    severity: hallazgo.severity,
    confidence: hallazgo.confidence,
    status: 'open',
    title_plain: hallazgo.titlePlain,
    explanation_plain: hallazgo.explanationPlain,
    impact_plain: hallazgo.impactPlain,
    fix_prompt: hallazgo.fixPrompt,
    evidence: hallazgo.evidence,
    rank: hallazgo.rank,
  }
}

function resumenDe(
  resultado: ResultadoCorrida,
  guardados: number,
  checks: Check[],
): ResumenGuardado {
  const avisos = resultado.salteados.map(
    (salteado) => `No se revisó ${salteado.checkId}. ${salteado.porqueePlain}`,
  )
  return {
    guardados,
    descartados: resultado.descartados.length,
    salteados: resultado.salteados.length,
    avisos: avisos.slice(0, 10),
    cobertura: calcularCobertura(resultado, checks),
  }
}

/**
 * Qué pasó con cada chequeo del catálogo en esta corrida. Es lo único que
 * alimenta la pantalla de "todo lo que revisamos": sin esto, un usuario sin
 * hallazgos no tiene forma de saber qué se miró de verdad.
 */
function calcularCobertura(resultado: ResultadoCorrida, checks: Check[]): RunCoverage {
  const conHallazgos = new Set<string>()
  for (const hallazgo of resultado.findings) {
    for (const checkId of hallazgo.detectadoPor) conHallazgos.add(checkId)
  }
  const fallados = new Map(resultado.fallados.map((f) => [f.checkId, f]))
  const salteados = new Map(resultado.salteados.map((s) => [s.checkId, s]))

  const entries: CoverageEntry[] = checks.map((check) => {
    if (conHallazgos.has(check.id)) {
      return { checkId: check.id, pillar: check.pillar, status: 'con_hallazgos' }
    }
    if (fallados.has(check.id)) {
      return { checkId: check.id, pillar: check.pillar, status: 'fallado' }
    }
    const salteado = salteados.get(check.id)
    if (salteado) {
      return {
        checkId: check.id,
        pillar: check.pillar,
        status: 'salteado',
        reasonPlain: salteado.porqueePlain,
      }
    }
    return { checkId: check.id, pillar: check.pillar, status: 'sin_hallazgos' }
  })

  return { totalChequeos: checks.length, entries }
}

/* ── Lecturas ─────────────────────────────────────────────────────────── */

const INDICE_VACIO: CodeIndex = {
  fileCount: 0,
  totalBytes: 0,
  languages: {},
  routes: [],
  symbols: [],
  edges: [],
  rankedFiles: [],
  dbSchema: { source: 'none', tables: [], buckets: [], functions: [] },
  truncated: false,
  notes: [],
}

/**
 * Reconstruye el `CodeIndex` desde las columnas de la tabla.
 *
 * Tolerante a propósito: la forma exacta de `stats` y `symbol_graph` la fija el
 * frente de análisis. Si falta una pieza se usa el vacío y los chequeos que la
 * necesitan no encuentran nada — que es mejor que reventar la corrida entera.
 */
async function leerCodeIndex(db: JobsDb, analysisRunId: string): Promise<CodeIndex> {
  const { data, error } = await db
    .from(T.codeIndex)
    .select('symbol_graph, routes, ranked_files, db_schema, stats')
    .eq('analysis_run_id', analysisRunId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    throw new JobError(
      `No se pudo leer cómo está armado el proyecto: ${describeDbError(error)}`,
      { retryable: true, code: 'indice_ilegible' },
    )
  }
  if (!data) {
    throw new JobError(
      'Todavía no está listo el mapa del proyecto: hay que indexar el código antes de revisarlo.',
      { retryable: false, code: 'indice_faltante' },
    )
  }

  const fila = data as Record<string, unknown>
  const stats = (fila.stats ?? {}) as Record<string, unknown>
  const grafo = (fila.symbol_graph ?? {}) as Record<string, unknown>

  return {
    fileCount: numero(stats.fileCount ?? stats.file_count, 0),
    totalBytes: numero(stats.totalBytes ?? stats.total_bytes, 0),
    languages: (stats.languages as Record<string, number>) ?? {},
    routes: arreglo(fila.routes) as CodeIndex['routes'],
    symbols: arreglo(grafo.symbols ?? grafo.nodes) as CodeIndex['symbols'],
    edges: arreglo(grafo.edges) as CodeIndex['edges'],
    rankedFiles: arreglo(fila.ranked_files) as CodeIndex['rankedFiles'],
    dbSchema: (fila.db_schema as DbSchemaSnapshot) ?? INDICE_VACIO.dbSchema,
    truncated: Boolean(stats.truncated),
    notes: arreglo(stats.notes) as string[],
  }
}

const STACK_DESCONOCIDO: StackInfo = {
  framework: 'unknown',
  language: 'unknown',
  packageManager: 'unknown',
  backends: [],
  hasTypescript: false,
  hasTailwind: false,
  routerKind: 'unknown',
  evidence: [],
}

async function leerStack(db: JobsDb, projectId: string | null): Promise<StackInfo> {
  if (!projectId) return STACK_DESCONOCIDO

  const { data, error } = await db
    .from(T.projects)
    .select('stack_detected')
    .eq('id', projectId)
    .maybeSingle()

  if (error || !data) return STACK_DESCONOCIDO
  const detectado = (data as Record<string, unknown>).stack_detected
  if (!detectado || typeof detectado !== 'object') return STACK_DESCONOCIDO
  return { ...STACK_DESCONOCIDO, ...(detectado as Partial<StackInfo>) }
}

/**
 * Las sesiones del agente. Si no hay ninguna, los chequeos que dependen de la
 * app publicada se saltean solos y el motor lo deja registrado.
 */
async function leerSesionesDelAgente(
  db: JobsDb,
  analysisRunId: string,
): Promise<AgentSessionResult[]> {
  const { data, error } = await db
    .from(T.agentSessions)
    .select('task_id, outcome, conclusion_plain, steps, duration_ms, cost_usd')
    .eq('analysis_run_id', analysisRunId)

  if (error || !Array.isArray(data)) return []

  return (data as Array<Record<string, unknown>>).map((fila) => ({
    taskId: String(fila.task_id) as AgentSessionResult['taskId'],
    outcome: String(fila.outcome) as AgentSessionResult['outcome'],
    conclusionPlain: String(fila.conclusion_plain ?? ''),
    steps: arreglo(fila.steps) as AgentSessionResult['steps'],
    durationMs: numero(fila.duration_ms, 0),
    costUsd: numero(fila.cost_usd, 0),
  }))
}

function numero(valor: unknown, porDefecto: number): number {
  const n = typeof valor === 'string' ? Number.parseFloat(valor) : valor
  return typeof n === 'number' && Number.isFinite(n) ? n : porDefecto
}

function arreglo(valor: unknown): unknown[] {
  return Array.isArray(valor) ? valor : []
}

/* ── Encolar los videos ───────────────────────────────────────────────── */

/**
 * Cuáles de los hallazgos se llevan un video, y por qué solo esos.
 *
 * **Como mucho tres.** No es una restricción técnica ni de costo: el 67% de las
 * alertas de seguridad se ignora por saturación, y un reporte con cincuenta
 * filas muere en una planilla. Tres cosas para hacer ya es lo que una persona
 * sola puede atender esta tarde. Si le damos diez videos, no mira ninguno.
 *
 * **Solo lo que se puede demostrar.** Un video es una prueba, no una
 * afirmación con locución encima. Si el hallazgo no apunta a un `archivo:línea`
 * ni a algo que el agente haya grabado, no hay nada que mostrar: mostrarlo
 * igual sería exactamente el hallazgo blando que contamina la credibilidad de
 * los duros.
 *
 * **Y no se paga dos veces.** Si ya hay un video listo para ese hallazgo, no se
 * vuelve a producir. Un reintento de la revisión no puede costar plata de nuevo.
 */
export const MAX_VIDEOS_POR_CORRIDA = 3

interface ResumenVideos {
  encolados: number
  salteados: number
}

export async function encolarVideos(
  db: JobsDb,
  payload: RunChecksPayload,
  ctx: JobContext,
  deps: DependenciasRunChecks = {},
): Promise<ResumenVideos> {
  const analysisRunId = ctx.analysisRunId
  if (!analysisRunId || !ctx.projectId) return { encolados: 0, salteados: 0 }

  const { data, error } = await db
    .from(T.findings)
    .select('id, rank, evidence, video_id')
    .eq('analysis_run_id', analysisRunId)
    .in('rank', rangoDestacados())

  if (error) {
    // Que no salgan los videos no invalida la revisión: los hallazgos ya están
    // guardados y el usuario los ve. Se avisa y se sigue.
    ctx.log(`No se pudo elegir qué demostrar en video: ${describeDbError(error)}`)
    return { encolados: 0, salteados: 0 }
  }

  const filas = (Array.isArray(data) ? data : []) as Array<Record<string, unknown>>

  const candidatos = filas
    .filter((fila) => sePuedeDemostrar(fila.evidence))
    .sort((a, b) => Number(a.rank ?? 99) - Number(b.rank ?? 99))
    .slice(0, MAX_VIDEOS_POR_CORRIDA)

  const salteados = filas.length - candidatos.length
  if (salteados > 0) {
    ctx.log(
      `${salteados} hallazgo(s) destacado(s) no se van a demostrar en video: no tienen ni una línea de código ni una grabación que mostrar.`,
    )
  }

  const yaListos = await conVideoListo(db, candidatos.map((f) => String(f.id)))
  const encolar = deps.encolar ?? enqueue

  let encolados = 0
  for (const fila of candidatos) {
    const findingId = String(fila.id)
    if (yaListos.has(findingId)) {
      ctx.log(`El video de ese hallazgo ya estaba hecho, no se vuelve a producir.`)
      continue
    }

    try {
      await encolar({
        orgId: ctx.orgId,
        projectId: ctx.projectId,
        analysisRunId,
        kind: 'generate_video',
        payload: {
          findingId,
          // La carpeta del repo es el único lugar de trabajo que este handler
          // conoce con seguridad y que existe. El motor crea `video/<id>/` adentro.
          workspaceDir: payload.repoPath,
          kind: 'finding',
        },
      })
      encolados += 1
    } catch (error) {
      ctx.log(`No se pudo pedir el video de un hallazgo: ${describeError(error)}`)
    }
  }

  return { encolados, salteados }
}

function rangoDestacados(): number[] {
  return Array.from({ length: MAX_VIDEOS_POR_CORRIDA }, (_, i) => i + 1)
}

/**
 * ¿Hay algo concreto que poner en pantalla?
 *
 * Los dos tipos de prueba que este producto se compromete a mostrar: el lugar
 * exacto del código, o el momento en que el agente lo hizo pasar de verdad.
 */
function sePuedeDemostrar(evidence: unknown): boolean {
  if (!Array.isArray(evidence)) return false
  return evidence.some(
    (e) =>
      e && typeof e === 'object' && ((e as Evidence).kind === 'code' || (e as Evidence).kind === 'recording'),
  )
}

/** Hallazgos que ya tienen un video producido y no hay que volver a pagar. */
async function conVideoListo(db: JobsDb, findingIds: string[]): Promise<Set<string>> {
  if (findingIds.length === 0) return new Set()

  const { data, error } = await db
    .from(T.videos)
    .select('finding_id, status')
    .in('finding_id', findingIds)
    .eq('status', 'ready')

  if (error || !Array.isArray(data)) return new Set()

  return new Set(
    (data as Array<Record<string, unknown>>)
      .map((fila) => (typeof fila.finding_id === 'string' ? fila.finding_id : null))
      .filter((id): id is string => id !== null),
  )
}

/* ── Enganche ─────────────────────────────────────────────────────────── */

registerHandler('run_checks', crearHandlerRunChecks())
