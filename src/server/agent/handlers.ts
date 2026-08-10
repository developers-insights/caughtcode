/**
 * Handler del trabajo `run_browser_agent`: el agente prueba la app y deja la prueba.
 *
 * Es el corazón del producto. Todo lo demás describe problemas; esto los
 * *demuestra*: abre la app del usuario en un navegador, intenta hacer cosas
 * reales, graba todo, y deja tres cosas para el resto del sistema:
 *
 *   1. una fila por tarea en `agent_sessions` con la conclusión en castellano,
 *   2. los archivos (video, capturas) en Storage, que es lo que después se recorta,
 *   3. lo que observó de paso —pedidos de red, cookies, medición del celular— en
 *      el payload del trabajo de revisión.
 *
 * ## Por qué este trabajo encola la revisión
 *
 * Antes `index_code` encolaba la revisión y el agente **en paralelo**. Parecía
 * inofensivo y no lo era: los chequeos de cookies, de rastreadores, de flujos que
 * faltan y de pantalla en el celular leen lo que vio el agente. Corriendo a la
 * par, la revisión arrancaba primero, no encontraba nada de eso, y se salteaba
 * justo los chequeos que el producto promete. Ahora la cadena con app publicada
 * es `index_code` → `run_browser_agent` → `run_checks`, y la evidencia viaja en
 * el payload.
 *
 * ## Por qué la revisión se encola aunque el agente falle
 *
 * Como consecuencia de lo anterior, este trabajo quedó en el medio de la cadena:
 * si se muere, se lleva puesta la auditoría entera. Por eso la última etapa
 * —encolar `run_checks`— corre **siempre**, incluso cuando no se pudo abrir el
 * navegador. Después de eso, y solo después, el trabajo falla con un mensaje que
 * explica qué pasó. El usuario ve el problema del agente y recibe igual la
 * revisión del código.
 *
 * ## Idempotencia
 *
 * Dos niveles, porque el trabajo caro es caro de verdad:
 *
 *   - En la base: borrar-y-reinsertar `agent_sessions` por (`analysis_run_id`,
 *     `task_id`), la regla que fijó el frente de la cola.
 *   - En Storage: todo cuelga de una carpeta derivada del `analysis_run_id`, así
 *     que reintentar pisa lo de antes en vez de acumular. Y si la evidencia de
 *     esta corrida ya está guardada, **no se vuelve a abrir el navegador**: se
 *     relee. Un reintento por un error de escritura no puede costar otra corrida
 *     completa del agente.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import pLimit from 'p-limit'

import type { AgentSessionResult, AgentTaskId, CostEntry } from '@/lib/types/domain'
import { B, T } from '@/lib/db/tablas'
import { enqueue, registerHandler, runStages } from '@/server/jobs'
import type { JobContext, JobHandler, StageStore } from '@/server/jobs'
import { describeDbError, jobsDb, type JobsDb } from '@/server/jobs/db'
import { describeError, JobError } from '@/server/jobs/errors'
import type { RunChecksPayload } from '@/server/checks/handlers'

import { runAgentSession, type RunAgentSessionOptions } from './index'
import { CostMeter } from './cost'
import { allowedOriginsFor } from './guards'
import { crearComplete } from './llm'
import { ObservationCollector, type AgentObservations } from './observations'
import {
  ARCHIVO_EVIDENCIA,
  carpetaDeCorrida,
  supabaseStorage,
  type AgentStorage,
} from './storage'
import type { LlmComplete, TestCredentials } from './types'

/* ── Lo que llega en el trabajo ───────────────────────────────────────── */

export interface RunBrowserAgentPayload {
  /** Dirección pública de la app del usuario. Sin esto no hay nada que probar. */
  deployedUrl: string
  /** Carpeta del código. Viaja al trabajo de revisión, que sí la necesita. */
  repoPath?: string
  /** Conexión de solo lectura a la base del usuario, si la conectó. También viaja. */
  databaseUrl?: string | null
  /** Qué pruebas correr. Por defecto, las que apliquen al stack detectado. */
  tasks?: AgentTaskId[]
  /** El usuario confirmó en pantalla que se puede tocar datos de verdad. */
  allowDestructive?: boolean
  /** Cuentas creadas para la auditoría, con su confirmación. */
  testCredentials?: TestCredentials
  /** Tope de gasto de esta corrida, en dólares. */
  costCapUsd?: number
}

/* ── Inyección de dependencias ────────────────────────────────────────── */

export interface DependenciasRunBrowserAgent {
  db?: () => Promise<JobsDb>
  store?: StageStore
  storage?: AgentStorage
  /** El motor. Se reemplaza en los tests para no abrir un navegador de verdad. */
  run?: (options: RunAgentSessionOptions) => Promise<AgentSessionResult[]>
  /** Puente al modelo. En los tests va uno falso y determinístico. */
  complete?: LlmComplete
  encolar?: typeof enqueue
  /** Carpeta temporal de la corrida. */
  workspace?: () => Promise<string>
}

/* ── Etapas: el texto lo lee el usuario ───────────────────────────────── */

const ETAPAS = {
  probar: 'Probando tu app como si fuera un usuario',
  avisar: 'Preparando la revisión con lo que encontramos',
} as const

/** Tope de archivos que se suben por corrida. Un freno, no un objetivo. */
const MAX_ARTEFACTOS = 200

interface MotivoFalla {
  mensajePlain: string
  codigo: string
}

interface ResumenPrueba {
  sesiones: number
  completadas: number
  bloqueadas: number
  pasos: number
  costoUsd: number
  /** Ruta del resumen de evidencia en Storage. `null` si no se llegó a guardar. */
  evidenciaEn: string | null
  motivo: MotivoFalla | null
}

/** Lo que se guarda en Storage para no depender de la memoria del proceso. */
interface EvidenciaGuardada {
  version: 1
  deployedUrl: string
  sessions: AgentSessionResult[]
  observaciones: AgentObservations
}

/* ── Handler ──────────────────────────────────────────────────────────── */

export function crearHandlerRunBrowserAgent(
  deps: DependenciasRunBrowserAgent = {},
): JobHandler<RunBrowserAgentPayload> {
  return async (payload, ctx) => {
    const analysisRunId = exigirCorrida(ctx)
    const projectId = exigirProyecto(ctx)

    const resultados = await runStages(
      ctx,
      [
        {
          name: 'probar_la_app',
          label: ETAPAS.probar,
          progress: 80,
          run: async (helper) => probarLaApp(payload, ctx, deps, helper.heartbeat),
        },
        {
          name: 'avisar_a_los_chequeos',
          label: ETAPAS.avisar,
          progress: 100,
          run: async (helper) => {
            const resumen = helper.get<ResumenPrueba>('probar_la_app')
            return encolarRevision(payload, ctx, deps, resumen ?? null, {
              analysisRunId,
              projectId,
            })
          },
        },
      ],
      deps.store ? { store: deps.store } : {},
    )

    // Recién acá se falla: la revisión del código ya quedó encolada, así que el
    // usuario no pierde la auditoría por un problema al abrir su app.
    const resumen = resultados['probar_la_app'] as ResumenPrueba | undefined
    if (resumen?.motivo) {
      throw new JobError(resumen.motivo.mensajePlain, {
        retryable: false,
        code: resumen.motivo.codigo,
      })
    }
  }
}

function exigirCorrida(ctx: JobContext): string {
  if (!ctx.analysisRunId) {
    throw new JobError('El trabajo de prueba en tu app llegó sin corrida asociada.', {
      retryable: false,
      code: 'sin_corrida',
    })
  }
  return ctx.analysisRunId
}

function exigirProyecto(ctx: JobContext): string {
  if (!ctx.projectId) {
    throw new JobError('El trabajo de prueba en tu app llegó sin proyecto asociado.', {
      retryable: false,
      code: 'sin_proyecto',
    })
  }
  return ctx.projectId
}

/* ── Etapa 1: probar la app ───────────────────────────────────────────── */

async function probarLaApp(
  payload: RunBrowserAgentPayload,
  ctx: JobContext,
  deps: DependenciasRunBrowserAgent,
  heartbeat: (progress?: number) => Promise<void>,
): Promise<ResumenPrueba> {
  const analysisRunId = exigirCorrida(ctx)
  const projectId = exigirProyecto(ctx)
  const storage = deps.storage ?? supabaseStorage
  const carpeta = carpetaDeCorrida(ctx.orgId, projectId, analysisRunId)
  const rutaEvidencia = `${carpeta}/${ARCHIVO_EVIDENCIA}`

  // ── ¿Ya está hecho? ──────────────────────────────────────────────────
  const guardada = await leerEvidencia(storage, rutaEvidencia, ctx)
  if (guardada) {
    ctx.log(
      'La prueba de esta corrida ya estaba guardada: se reusa en vez de volver a ' +
        'abrir el navegador.',
    )
    await guardarSesiones(deps, ctx, analysisRunId, guardada.sessions)
    // Solo se guarda evidencia de una prueba que llegó a algún lado: si acá dice
    // que la app no respondió, es porque ya se agotaron los reintentos.
    const motivoViejo = laAppNoRespondio(guardada.sessions)
      ? { mensajePlain: mensajeAppCaida(guardada.deployedUrl, false), codigo: 'app_no_responde' }
      : null
    return resumenDe(guardada.sessions, rutaEvidencia, motivoViejo)
  }

  // ── Correr el agente ─────────────────────────────────────────────────
  const sinDireccion = revisarDireccion(payload.deployedUrl)
  if (sinDireccion) return resumenDe([], null, sinDireccion)

  const workspaceDir = await (deps.workspace ?? crearWorkspace)()
  const meter = new CostMeter({ hardCapUsd: payload.costCapUsd ?? 0.5 })
  const collector = new ObservationCollector(allowedOriginsFor(payload.deployedUrl))
  const correr = deps.run ?? runAgentSession

  let sessions: AgentSessionResult[]
  try {
    sessions = await correr({
      deployedUrl: payload.deployedUrl,
      workspaceDir,
      complete: deps.complete ?? crearComplete(),
      collector,
      costMeter: meter,
      signal: ctx.signal,
      ...(payload.tasks ? { tasks: payload.tasks } : {}),
      ...(payload.allowDestructive === undefined
        ? {}
        : { allowDestructive: payload.allowDestructive }),
      ...(payload.testCredentials ? { testCredentials: payload.testCredentials } : {}),
      onProgress: (evento) => {
        if (evento.kind !== 'task_start') return
        const avance = 10 + Math.round((evento.index / Math.max(1, evento.totalTasks)) * 60)
        void heartbeat(avance).catch((error: unknown) => {
          // Un latido perdido no invalida la prueba: si se pierden todos, vence el
          // lease y el trabajo vuelve a la cola solo.
          ctx.log(`No se pudo publicar el avance de la prueba: ${describeError(error)}`)
        })
      },
    })
  } catch (error) {
    await limpiarWorkspace(workspaceDir, ctx)
    const motivo = interpretarFalla(error, payload.deployedUrl)
    ctx.log(`La prueba en tu app no se pudo completar: ${describeError(error)}`)
    return resumenDe([], null, motivo)
  }

  await heartbeat(75)

  const observaciones = collector.build()

  // ── ¿La app respondió? ───────────────────────────────────────────────
  //
  // Esto va **antes** de guardar la evidencia, y el orden no es casual: si se
  // guardara, el reintento la releería y daría la prueba por hecha sin volver a
  // tocar la app. Una app que estaba publicándose nunca se volvería a probar.
  if (laAppNoRespondio(sessions) && ctx.attempt < ctx.maxAttempts) {
    await limpiarWorkspace(workspaceDir, ctx)
    await guardarSesiones(deps, ctx, analysisRunId, sessions)
    await reportarCosto(ctx, meter, sessions)
    // Se tira desde adentro de la etapa a propósito: así el reintento vuelve a
    // abrir el navegador en vez de saltear la etapa por estar marcada como hecha.
    throw new JobError(mensajeAppCaida(payload.deployedUrl, true), {
      retryable: true,
      code: 'app_no_responde',
    })
  }

  // ── Guardar la prueba ────────────────────────────────────────────────
  const subidos = await subirArtefactos(storage, carpeta, workspaceDir, sessions, observaciones, ctx)
  await limpiarWorkspace(workspaceDir, ctx)

  const evidencia: EvidenciaGuardada = {
    version: 1,
    deployedUrl: payload.deployedUrl,
    sessions: subidos.sessions,
    observaciones: subidos.observaciones,
  }

  const evidenciaEn = await escribirEvidencia(storage, rutaEvidencia, evidencia, ctx)
  await guardarSesiones(deps, ctx, analysisRunId, subidos.sessions)
  await reportarCosto(ctx, meter, subidos.sessions)

  const motivo = laAppNoRespondio(subidos.sessions)
    ? { mensajePlain: mensajeAppCaida(payload.deployedUrl, false), codigo: 'app_no_responde' }
    : null

  return resumenDe(subidos.sessions, evidenciaEn, motivo)
}

function resumenDe(
  sessions: AgentSessionResult[],
  evidenciaEn: string | null,
  motivo: MotivoFalla | null,
): ResumenPrueba {
  return {
    sesiones: sessions.length,
    completadas: sessions.filter((s) => s.outcome === 'completed').length,
    bloqueadas: sessions.filter((s) => s.outcome === 'blocked').length,
    pasos: sessions.reduce((total, s) => total + s.steps.length, 0),
    costoUsd: Number(sessions.reduce((total, s) => total + s.costUsd, 0).toFixed(6)),
    evidenciaEn,
    motivo,
  }
}

/* ── Etapa 2: encolar la revisión ─────────────────────────────────────── */

async function encolarRevision(
  payload: RunBrowserAgentPayload,
  ctx: JobContext,
  deps: DependenciasRunBrowserAgent,
  resumen: ResumenPrueba | null,
  ids: { analysisRunId: string; projectId: string },
): Promise<{ encolado: boolean; conEvidencia: boolean }> {
  const storage = deps.storage ?? supabaseStorage
  const encolar = deps.encolar ?? enqueue

  let observaciones: AgentObservations | undefined
  if (resumen?.evidenciaEn) {
    const guardada = await leerEvidencia(storage, resumen.evidenciaEn, ctx)
    if (guardada && tieneAlgo(guardada.observaciones)) observaciones = guardada.observaciones
  }

  const siguiente: RunChecksPayload = {
    repoPath: payload.repoPath ?? '',
    deployedUrl: payload.deployedUrl ?? null,
    databaseUrl: payload.databaseUrl ?? null,
    ...(observaciones ? { agentEvidence: observaciones } : {}),
  }

  await encolar({
    orgId: ctx.orgId,
    projectId: ids.projectId,
    analysisRunId: ids.analysisRunId,
    kind: 'run_checks',
    payload: siguiente,
  })

  if (!observaciones) {
    ctx.log(
      'La revisión arranca sin lo que observa el navegador: los chequeos que ' +
        'dependen de eso van a quedar marcados como no revisados.',
    )
  }

  return { encolado: true, conEvidencia: Boolean(observaciones) }
}

function tieneAlgo(observaciones: AgentObservations): boolean {
  return Object.values(observaciones).some((valor) => Array.isArray(valor) && valor.length > 0)
}

/* ── Guardado en la base ──────────────────────────────────────────────── */

async function guardarSesiones(
  deps: DependenciasRunBrowserAgent,
  ctx: JobContext,
  analysisRunId: string,
  sessions: AgentSessionResult[],
): Promise<void> {
  if (sessions.length === 0) return

  const db = await (deps.db ?? jobsDb)()
  const taskIds = [...new Set(sessions.map((s) => s.taskId))]

  const { error: borrarError } = await db
    .from(T.agentSessions)
    .delete()
    .eq('analysis_run_id', analysisRunId)
    .in('task_id', taskIds)

  if (borrarError) {
    throw new JobError(
      `No se pudieron limpiar las pruebas anteriores: ${describeDbError(borrarError)}`,
      { retryable: true, code: 'limpieza_fallida' },
    )
  }

  const { error } = await db.from(T.agentSessions).insert(sessions.map(aFila(analysisRunId)))
  if (error) {
    throw new JobError(`No se pudo guardar lo que probamos en tu app: ${describeDbError(error)}`, {
      retryable: true,
      code: 'guardado_fallido',
    })
  }

  ctx.log(`Se guardaron ${sessions.length} pruebas de esta corrida.`)
}

function aFila(analysisRunId: string) {
  return (sesion: AgentSessionResult): Record<string, unknown> => ({
    analysis_run_id: analysisRunId,
    task_id: sesion.taskId,
    outcome: sesion.outcome,
    conclusion_plain: sesion.conclusionPlain,
    recording_url: sesion.recordingPath ?? null,
    steps: sesion.steps,
    duration_ms: Math.round(sesion.durationMs),
    cost_usd: sesion.costUsd,
  })
}

/* ── Costo ────────────────────────────────────────────────────────────── */

/**
 * El costo se informa en unidades que se entienden sin explicación: pruebas
 * hechas, pasos dados, minutos de navegador y tokens. Nunca "créditos" (D16).
 */
async function reportarCosto(
  ctx: JobContext,
  meter: CostMeter,
  sessions: AgentSessionResult[],
): Promise<void> {
  for (const entrada of meter.breakdown().entries) await ctx.reportCost(entrada)

  const pasos = sessions.reduce((total, s) => total + s.steps.length, 0)
  const resumen: CostEntry = {
    category: 'browser_agent',
    units: sessions.length,
    unitLabel: 'pruebas en tu app',
    // Los dólares ya están en los renglones de arriba: este renglón dice qué se
    // hizo, no vuelve a cobrarlo.
    costUsd: 0,
    detail: `${sessions.length} pruebas y ${pasos} pasos en tu app. ${meter.describePlain()}`,
  }
  await ctx.reportCost(resumen)
}

/* ── Archivos ─────────────────────────────────────────────────────────── */

interface Subidos {
  sessions: AgentSessionResult[]
  observaciones: AgentObservations
}

/**
 * Sube el video y las capturas, y reescribe las rutas locales por las de Storage.
 *
 * Reescribir es la parte que importa: si se sube el archivo pero la fila sigue
 * apuntando a `/tmp/loquesea`, mañana el frente de video busca ahí y no encuentra
 * nada. Una evidencia que no se puede abrir no es evidencia.
 */
async function subirArtefactos(
  storage: AgentStorage,
  carpeta: string,
  workspaceDir: string,
  sessions: AgentSessionResult[],
  observaciones: AgentObservations,
  ctx: JobContext,
): Promise<Subidos> {
  const locales = new Set<string>()
  const anotar = (ruta?: string): void => {
    if (ruta) locales.add(ruta)
  }

  for (const sesion of sessions) {
    anotar(sesion.recordingPath)
    for (const paso of sesion.steps) anotar(paso.screenshotPath)
  }
  for (const pagina of observaciones.pages ?? []) anotar(pagina.screenshotPath)
  for (const medicion of observaciones.overflow ?? []) anotar(medicion.screenshotPath)

  const rutas = [...locales].slice(0, MAX_ARTEFACTOS)
  if (locales.size > MAX_ARTEFACTOS) {
    ctx.log(
      `La prueba dejó ${locales.size} archivos y se guardaron los primeros ${MAX_ARTEFACTOS}.`,
    )
  }

  const mapa = new Map<string, string>()
  const limite = pLimit(4)
  let fallados = 0

  await Promise.all(
    rutas.map((local) =>
      limite(async () => {
        const destino = `${carpeta}/${relativoA(workspaceDir, local)}`
        try {
          const contenido = await readFile(local)
          await storage.subir(B.recordings, destino, contenido, tipoDe(local))
          mapa.set(local, destino)
        } catch (error) {
          fallados += 1
          ctx.log(`No se pudo guardar un archivo de la prueba: ${describeError(error)}`)
        }
      }),
    ),
  )

  if (fallados > 0) {
    ctx.log(`Quedaron ${fallados} archivos de la prueba sin guardar. El resto está completo.`)
  }

  return {
    sessions: sessions.map((sesion) => reescribirSesion(sesion, mapa)),
    observaciones: reescribirObservaciones(observaciones, mapa),
  }
}

function reescribirSesion(
  sesion: AgentSessionResult,
  mapa: Map<string, string>,
): AgentSessionResult {
  const reescrita: AgentSessionResult = {
    ...sesion,
    steps: sesion.steps.map((paso) => {
      const destino = paso.screenshotPath ? mapa.get(paso.screenshotPath) : undefined
      if (!paso.screenshotPath) return paso
      // Sin destino, la captura no llegó a Storage: se saca la ruta en vez de
      // dejar apuntando a un archivo que ya no existe.
      const { screenshotPath: _local, ...resto } = paso
      return destino ? { ...resto, screenshotPath: destino } : resto
    }),
  }

  const grabacion = sesion.recordingPath ? mapa.get(sesion.recordingPath) : undefined
  if (grabacion) reescrita.recordingPath = grabacion
  else delete reescrita.recordingPath
  return reescrita
}

function reescribirObservaciones(
  observaciones: AgentObservations,
  mapa: Map<string, string>,
): AgentObservations {
  const cambiar = <T extends { screenshotPath?: string }>(item: T): T => {
    if (!item.screenshotPath) return item
    const destino = mapa.get(item.screenshotPath)
    if (destino) return { ...item, screenshotPath: destino }
    const { screenshotPath: _local, ...resto } = item
    return resto as T
  }

  const salida: AgentObservations = { ...observaciones }
  if (observaciones.pages) salida.pages = observaciones.pages.map(cambiar)
  if (observaciones.overflow) salida.overflow = observaciones.overflow.map(cambiar)
  return salida
}

/** Ruta dentro de la carpeta de la corrida. Estable entre reintentos. */
function relativoA(workspaceDir: string, archivo: string): string {
  const relativo = path.relative(workspaceDir, archivo)
  if (!relativo || relativo.startsWith('..') || path.isAbsolute(relativo)) {
    return path.basename(archivo)
  }
  return relativo.split(path.sep).join('/')
}

function tipoDe(archivo: string): string {
  const extension = path.extname(archivo).toLowerCase()
  if (extension === '.webm') return 'video/webm'
  if (extension === '.mp4') return 'video/mp4'
  if (extension === '.png') return 'image/png'
  if (extension === '.json') return 'application/json'
  return 'application/octet-stream'
}

/* ── Evidencia en Storage ─────────────────────────────────────────────── */

async function escribirEvidencia(
  storage: AgentStorage,
  ruta: string,
  evidencia: EvidenciaGuardada,
  ctx: JobContext,
): Promise<string | null> {
  try {
    await storage.subir(B.recordings, ruta, JSON.stringify(evidencia), 'application/json')
    return ruta
  } catch (error) {
    // No es fatal: las sesiones van a la base igual y la revisión se encola igual.
    // Lo que se pierde son las observaciones sueltas, y queda dicho.
    ctx.log(`No se pudo guardar el resumen de lo observado: ${describeError(error)}`)
    return null
  }
}

async function leerEvidencia(
  storage: AgentStorage,
  ruta: string,
  ctx: JobContext,
): Promise<EvidenciaGuardada | null> {
  let texto: string | null
  try {
    texto = await storage.bajarTexto(B.recordings, ruta)
  } catch (error) {
    ctx.log(`No se pudo leer lo guardado de esta corrida: ${describeError(error)}`)
    return null
  }
  if (!texto) return null

  try {
    const parsed = JSON.parse(texto) as EvidenciaGuardada
    if (parsed?.version !== 1 || !Array.isArray(parsed.sessions)) return null
    return { ...parsed, observaciones: parsed.observaciones ?? {} }
  } catch (error) {
    ctx.log(`Lo guardado de esta corrida no se pudo leer y se vuelve a probar: ${describeError(error)}`)
    return null
  }
}

/* ── Fallas, en castellano ────────────────────────────────────────────── */

/** `true` si el agente no llegó a abrir la app en ninguna prueba. */
function laAppNoRespondio(sessions: AgentSessionResult[]): boolean {
  if (sessions.length === 0) return false
  return sessions.every((sesion) => sesion.outcome === 'blocked' && !sesion.recordingPath)
}

function mensajeAppCaida(deployedUrl: string, vaAReintentar: boolean): string {
  const cierre = vaAReintentar
    ? 'Vamos a intentarlo de nuevo en unos minutos.'
    : 'Revisá que la dirección sea la correcta y que la app esté publicada, y volvé a pedir la auditoría.'
  return (
    `No pudimos abrir ${deployedUrl} para probar tu app: no respondió. ` +
    `Mientras tanto revisamos tu código igual. ${cierre}`
  )
}

function revisarDireccion(deployedUrl: string | undefined): MotivoFalla | null {
  if (!deployedUrl || allowedOriginsFor(deployedUrl).length === 0) {
    return {
      mensajePlain:
        'No tenemos una dirección válida de tu app publicada, así que no pudimos probarla. ' +
        'Cargala en el proyecto y volvé a pedir la auditoría. Igual revisamos tu código.',
      codigo: 'sin_direccion',
    }
  }
  return null
}

/**
 * Traduce el error técnico a algo accionable. El usuario nunca ve un stacktrace:
 * ve qué pasó y qué puede hacer.
 */
function interpretarFalla(error: unknown, deployedUrl: string): MotivoFalla {
  if (error instanceof JobError && error.code !== 'job_error') {
    return { mensajePlain: error.message, codigo: error.code }
  }

  const texto = error instanceof Error ? `${error.name}: ${error.message}` : String(error)

  if (/executable doesn'?t exist|playwright install|browsertype\.launch|no such file.*chrom/i.test(texto)) {
    return {
      mensajePlain:
        'No pudimos abrir un navegador para probar tu app: falta instalarlo en el servidor. ' +
        'Es un problema nuestro, no tuyo — ya lo estamos viendo. Tu código se revisó igual.',
      codigo: 'navegador_no_disponible',
    }
  }

  if (/ENOTFOUND|ECONNREFUSED|ERR_NAME_NOT_RESOLVED|net::ERR/i.test(texto)) {
    return {
      mensajePlain: mensajeAppCaida(deployedUrl, false),
      codigo: 'app_no_responde',
    }
  }

  return {
    mensajePlain:
      'Algo falló mientras probábamos tu app y no pudimos terminar esa parte. ' +
      'Tu código se revisó igual. Volvé a pedir la auditoría y, si sigue pasando, escribinos.',
    codigo: 'prueba_fallida',
  }
}

/* ── Carpeta de trabajo ───────────────────────────────────────────────── */

async function crearWorkspace(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'caughtcode-agente-'))
}

async function limpiarWorkspace(workspaceDir: string, ctx: JobContext): Promise<void> {
  try {
    await rm(workspaceDir, { recursive: true, force: true })
  } catch (error) {
    // Dejar temporales no rompe nada; ocultarlo sí, porque un disco lleno después
    // se manifiesta como una falla sin causa aparente.
    ctx.log(`Quedó sin borrar la carpeta temporal de la prueba: ${describeError(error)}`)
  }
}

/* ── Enganche ─────────────────────────────────────────────────────────── */

registerHandler('run_browser_agent', crearHandlerRunBrowserAgent())
