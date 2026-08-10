/**
 * Handler del trabajo `generate_video`: donde un hallazgo se convierte en la
 * prueba de que el problema existe.
 *
 * Esto es el producto. Sin este archivo, caughtcode entrega una lista de texto
 * como cualquier otro escáner; con él, entrega la grabación de lo que pasó,
 * narrada, en el idioma del que la mira.
 *
 * ## Las etapas que ve el usuario son las del motor, no las de la cola
 *
 * El motor (`generateVideo`) tiene cuatro etapas propias —guion → voz → render →
 * mezcla— y cada una deja su marca en disco, así que un reintento no vuelve a
 * pagar lo que ya salió bien. Este handler las **acompaña**: por cada etapa que
 * cruza el motor, escribe `videos.status` (según `ETAPA_A_ESTADO`, nunca un
 * valor inventado: la columna tiene un check) y late con el texto de esa etapa.
 *
 * La cola, por arriba, tiene tres etapas y menos granularidad a propósito:
 *
 *   1. `preparar`  — leer el hallazgo y dejar la fila de `videos` lista
 *   2. `producir`  — motor + subida a Storage + fila actualizada
 *   3. `cerrar`    — colgar el video del hallazgo y registrar el costo
 *
 * Producir y publicar van **juntos** en una sola etapa porque el archivo a subir
 * vive en el disco del worker. Separarlos daría una etapa `publicar` que, si el
 * worker muere y el trabajo se retoma en otra máquina, se saltearía la
 * producción y no encontraría nada que subir: quedaría fallando para siempre.
 * `cerrar`, en cambio, solo necesita el resumen que devolvió `producir`, así que
 * sobrevive a un cambio de máquina.
 *
 * ## Idempotencia
 *
 * La regla que fijó el frente de la cola para este tipo: **actualizar la fila de
 * `videos` por id; si crea, borrar primero las de (`finding_id`, `kind`)**. Un
 * hallazgo tiene un video, no una pila de intentos. La ruta en Storage se deriva
 * de los ids, así que reintentar sobrescribe el archivo en vez de dejar basura.
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { B, T } from '@/lib/db/tablas'
import type {
  AgentSessionResult,
  CodeIndex,
  CostEntry,
  DbSchemaSnapshot,
  Evidence,
  Finding,
  VideoKind,
} from '@/lib/types/domain'
import { registerHandler, runStages } from '@/server/jobs'
import type { JobContext, JobHandler, StageStore } from '@/server/jobs'
import { describeDbError, jobsDb, type JobsDb } from '@/server/jobs/db'
import { JobError } from '@/server/jobs/errors'

import { ETAPA_A_ESTADO, generateVideo } from './index'
import type {
  EtapaVideo,
  GenerarVideoOpciones,
  ResultadoVideo,
  VideoStatus,
} from './index'

/* ── Lo que llega en el trabajo ───────────────────────────────────────── */

export interface GenerateVideoPayload {
  /** Hallazgo que hay que demostrar. Se lee de la base, no viaja en el payload. */
  findingId: string
  /** Carpeta de trabajo del worker. Adentro se crea `video/<idHallazgo>/`. */
  workspaceDir: string
  /** `finding` salvo que sea un tutorial. */
  kind?: VideoKind
  /**
   * Grabaciones del agente ya bajadas a disco, por `task_id`. Si no vienen, se
   * buscan solas: primero en disco, después en Storage.
   */
  recordings?: Record<string, string>
}

/* ── Inyección de dependencias ────────────────────────────────────────── */

export type SubirVideo = (args: {
  ruta: string
  archivo: Buffer
}) => Promise<{ url: string }>

export type DescargarGrabacion = (ruta: string) => Promise<Buffer | null>

export interface DependenciasGenerateVideo {
  db?: () => Promise<JobsDb>
  store?: StageStore
  /** El motor. Se inyecta en los tests para no levantar Chromium ni ffmpeg. */
  generar?: (opciones: GenerarVideoOpciones) => Promise<ResultadoVideo>
  subir?: SubirVideo
  descargar?: DescargarGrabacion
  complete?: GenerarVideoOpciones['complete']
  completeJson?: GenerarVideoOpciones['completeJson']
  tts?: GenerarVideoOpciones['tts']
  renderer?: GenerarVideoOpciones['renderer']
}

/* ── Textos: los lee alguien que no sabe qué es un códec ──────────────── */

/**
 * Qué se muestra mientras corre cada etapa del motor.
 *
 * El `Record<EtapaVideo, string>` obliga al compilador a avisar si el motor
 * agrega una etapa y acá queda sin texto. Prohibido "muxing" y "encoding".
 */
export const TEXTO_DE_ETAPA: Record<EtapaVideo, string> = {
  guion: 'Escribiendo lo que va a decir el video',
  voz: 'Grabando la voz',
  render: 'Armando el video',
  mezcla: 'Uniendo el video con la voz',
}

const ETAPAS_COLA = {
  preparar: 'Preparando el video',
  producir: 'Armando el video',
  cerrar: 'Dejando el video listo',
} as const

/** Cuánto vale una dirección de video antes de vencerse. */
export const VIGENCIA_URL_S = 60 * 60 * 24 * 30

/* ── Handler ──────────────────────────────────────────────────────────── */

export function crearHandlerGenerateVideo(
  deps: DependenciasGenerateVideo = {},
): JobHandler<GenerateVideoPayload> {
  return async (payload, ctx) => {
    const abrirDb = deps.db ?? jobsDb
    const findingId = exigirHallazgo(payload)
    const kind: VideoKind = payload.kind ?? 'finding'

    await runStages(
      ctx,
      [
        {
          name: 'preparar',
          label: ETAPAS_COLA.preparar,
          progress: 8,
          run: async () => {
            const db = await abrirDb()
            const finding = await leerHallazgo(db, findingId)
            const projectId = finding.projectId ?? ctx.projectId
            if (!projectId) {
              throw new JobError(
                'El hallazgo no está asociado a ningún proyecto, así que el video no tendría dueño.',
                { retryable: false, code: 'video_sin_proyecto' },
              )
            }
            const videoId = await asegurarFila(db, { findingId, projectId, kind })
            return { videoId, projectId }
          },
        },
        {
          name: 'producir',
          label: ETAPAS_COLA.producir,
          progress: 92,
          run: async (helper) => {
            const previo = helper.get<{ videoId: string; projectId: string }>('preparar')
            if (!previo) {
              throw new JobError('Se perdió la preparación del video.', {
                retryable: true,
                code: 'preparacion_perdida',
              })
            }
            const db = await abrirDb()
            return producir(db, {
              ctx,
              deps,
              payload,
              findingId,
              kind,
              videoId: previo.videoId,
              projectId: previo.projectId,
            })
          },
        },
        {
          name: 'cerrar',
          label: ETAPAS_COLA.cerrar,
          progress: 100,
          run: async (helper) => {
            const hecho = helper.get<ResumenProduccion>('producir')
            if (!hecho) return { cerrado: false }

            const db = await abrirDb()
            await colgarDelHallazgo(db, findingId, hecho.videoId)

            for (const costo of hecho.costos) await ctx.reportCost(costo)
            for (const aviso of hecho.avisos) ctx.log(aviso)
            if (hecho.sinVoz) {
              ctx.log(
                hecho.motivoSinVoz ??
                  'El video salió sin narración y no quedó registrado por qué.',
              )
            }
            return { cerrado: true }
          },
        },
      ],
      deps.store ? { store: deps.store } : {},
    )
  }
}

function exigirHallazgo(payload: GenerateVideoPayload): string {
  if (!payload?.findingId) {
    throw new JobError('El trabajo de video llegó sin decir de qué hallazgo es.', {
      retryable: false,
      code: 'sin_hallazgo',
    })
  }
  return payload.findingId
}

/* ── Etapa 1: dejar la fila lista ─────────────────────────────────────── */

/**
 * Devuelve el id de la fila de `videos` de este hallazgo, creándola si falta.
 *
 * Reusar la fila existente (en vez de borrar y crear siempre) importa: el
 * hallazgo la referencia por `video_id`, y recrearla en cada intento dejaría al
 * usuario mirando un reproductor que apunta a un video que ya no existe.
 */
async function asegurarFila(
  db: JobsDb,
  args: { findingId: string; projectId: string; kind: VideoKind },
): Promise<string> {
  const { data: existente, error: errorLectura } = await db
    .from(T.videos)
    .select('id')
    .eq('finding_id', args.findingId)
    .eq('kind', args.kind)
    .limit(1)
    .maybeSingle()

  if (errorLectura) {
    throw new JobError(
      `No se pudo revisar si el video ya existía: ${describeDbError(errorLectura)}`,
      { retryable: true, code: 'video_ilegible' },
    )
  }

  if (existente && typeof (existente as Record<string, unknown>).id === 'string') {
    const videoId = String((existente as Record<string, unknown>).id)
    await actualizarFila(db, videoId, { status: 'rendering', error: null })
    return videoId
  }

  // Crear: primero se limpia cualquier resto de este hallazgo y este tipo, así
  // dos intentos no dejan dos filas compitiendo por el mismo hallazgo.
  const { error: errorBorrado } = await db
    .from(T.videos)
    .delete()
    .eq('finding_id', args.findingId)
    .eq('kind', args.kind)

  if (errorBorrado) {
    throw new JobError(
      `No se pudo limpiar el video anterior: ${describeDbError(errorBorrado)}`,
      { retryable: true, code: 'limpieza_fallida' },
    )
  }

  const { data, error } = await db
    .from(T.videos)
    .insert({
      finding_id: args.findingId,
      project_id: args.projectId,
      kind: args.kind,
      status: 'queued' satisfies VideoStatus,
      cost_usd: 0,
    })
    .select('id')
    .single()

  if (error || !data) {
    throw new JobError(`No se pudo anotar el video: ${describeDbError(error)}`, {
      retryable: true,
      code: 'video_no_creado',
    })
  }
  return String((data as Record<string, unknown>).id)
}

async function actualizarFila(
  db: JobsDb,
  videoId: string,
  cambios: Record<string, unknown>,
): Promise<void> {
  const { error } = await db.from(T.videos).update(cambios).eq('id', videoId)
  if (error) {
    throw new JobError(`No se pudo actualizar el estado del video: ${describeDbError(error)}`, {
      retryable: true,
      code: 'video_no_actualizado',
    })
  }
}

/* ── Etapa 2: producir y publicar ─────────────────────────────────────── */

interface ResumenProduccion {
  videoId: string
  url: string
  durationSeconds: number
  costUsd: number
  costos: CostEntry[]
  avisos: string[]
  sinVoz: boolean
  motivoSinVoz?: string
}

interface ArgsProducir {
  ctx: JobContext
  deps: DependenciasGenerateVideo
  payload: GenerateVideoPayload
  findingId: string
  kind: VideoKind
  videoId: string
  projectId: string
}

async function producir(db: JobsDb, args: ArgsProducir): Promise<ResumenProduccion> {
  const { ctx, deps, payload } = args

  const finding = await leerHallazgo(db, args.findingId)
  const sessions = await leerSesiones(db, {
    db,
    analysisRunId: finding.analysisRunId,
    orgId: ctx.orgId,
    projectId: args.projectId,
    workspaceDir: payload.workspaceDir,
    recordings: payload.recordings,
    descargar: deps.descargar,
    log: ctx.log,
  })
  const index = await leerIndice(db, finding.analysisRunId)

  // Cada vez que el motor cambia de etapa: el estado que corresponde en la base
  // y el texto que corresponde en pantalla. Nunca los dos por separado.
  let ultimoEstado: VideoStatus | null = null
  const alAvanzar = async (etapa: EtapaVideo, porcentaje: number) => {
    const estado = ETAPA_A_ESTADO[etapa]
    if (estado !== ultimoEstado) {
      ultimoEstado = estado
      await actualizarFila(db, args.videoId, { status: estado })
    }
    await ctx.heartbeat(TEXTO_DE_ETAPA[etapa], escalar(porcentaje))
  }

  let resultado: ResultadoVideo
  try {
    const motor = deps.generar ?? generateVideo
    resultado = await motor({
      finding: aFindingDominio(finding),
      projectId: args.projectId,
      sessions,
      index,
      workspaceDir: payload.workspaceDir,
      ...(deps.complete ? { complete: deps.complete } : {}),
      ...(deps.completeJson ? { completeJson: deps.completeJson } : {}),
      ...(deps.tts ? { tts: deps.tts } : {}),
      ...(deps.renderer ? { renderer: deps.renderer } : {}),
      onProgress: (progreso) => {
        // El motor avisa de forma sincrónica; la escritura va por su cuenta y
        // si falla no puede tumbar un render que ya está pago y a medio hacer.
        void alAvanzar(progreso.etapa, progreso.porcentaje).catch((error: unknown) => {
          ctx.log(`No se pudo publicar el avance del video: ${describirError(error)}`)
        })
      },
    })
  } catch (error) {
    await marcarFallado(db, args.videoId, error, ctx.log)
    throw error
  }

  // Subir antes de tocar la fila: si la subida falla, la fila queda en
  // `rendering` y el reintento la completa. Al revés quedaría un video "listo"
  // apuntando a un archivo que no está.
  const ruta = rutaDeVideoEnStorage(ctx.orgId, args.projectId, args.videoId)
  let url: string
  try {
    const subir = args.deps.subir ?? subirAStorage
    const archivo = await readFile(resultado.videoPath)
    const subido = await subir({ ruta, archivo })
    url = subido.url
  } catch (error) {
    await marcarFallado(db, args.videoId, error, ctx.log)
    throw new JobError(`No se pudo guardar el video: ${describirError(error)}`, {
      retryable: true,
      code: 'video_no_subido',
      cause: error,
    })
  }

  const avisos = resultado.avisos.filter((a) => a.trim().length > 0)

  await actualizarFila(db, args.videoId, {
    status: 'ready' satisfies VideoStatus,
    url,
    duration_s: resultado.durationSeconds,
    transcript: resultado.transcript,
    script: resultado.script,
    cost_usd: resultado.costUsd,
    // `error` no quiere decir "el video falló" —para eso está `status`— sino
    // "esto no salió como debía". Un clip sin voz es exactamente ese caso: se
    // entrega igual, pero nunca sin dejar dicho por qué.
    error: avisos.length > 0 ? avisos.join('\n') : null,
  })

  return {
    videoId: args.videoId,
    url,
    durationSeconds: resultado.durationSeconds,
    costUsd: resultado.costUsd,
    costos: costosConcretos(resultado),
    avisos,
    sinVoz: resultado.sinVoz,
    ...(resultado.motivoSinVoz ? { motivoSinVoz: resultado.motivoSinVoz } : {}),
  }
}

/** El motor reporta 0–100 de su propio trabajo; la cola tiene además dos puntas. */
function escalar(porcentaje: number): number {
  return 8 + Math.round(Math.max(0, Math.min(100, porcentaje)) * 0.84)
}

async function marcarFallado(
  db: JobsDb,
  videoId: string,
  error: unknown,
  log: (mensaje: string) => void,
): Promise<void> {
  try {
    await actualizarFila(db, videoId, {
      status: 'failed' satisfies VideoStatus,
      error: describirError(error).slice(0, 2000),
    })
  } catch (fallo) {
    // Que no se pueda anotar la falla no puede tapar la falla original.
    log(`Tampoco se pudo anotar que el video falló: ${describirError(fallo)}`)
  }
}

/**
 * Lo que costó el clip, en unidades que se pueden explicar.
 *
 * Se reenvían las entradas del motor tal cual —caracteres narrados, minutos de
 * máquina, guiones— porque son **medidas**, no estimadas. Se agrega una sola
 * línea propia: los segundos de video producidos, con costo cero para no
 * contar dos veces lo mismo. Es la unidad que el usuario entiende ("un video de
 * 74 segundos") y la que hace falta para poner precio.
 */
function costosConcretos(resultado: ResultadoVideo): CostEntry[] {
  const delMotor = resultado.costBreakdown.entries
  const segundos = Math.round(resultado.durationSeconds * 100) / 100

  return [
    ...delMotor,
    {
      category: 'render',
      units: segundos,
      unitLabel: 'segundos de video',
      costUsd: 0,
      detail: `Un video de ${Math.round(segundos)} segundos. Ya contado en las líneas de arriba.`,
    },
  ]
}

/* ── Etapa 3: colgar el video del hallazgo ────────────────────────────── */

async function colgarDelHallazgo(
  db: JobsDb,
  findingId: string,
  videoId: string,
): Promise<void> {
  const { error } = await db.from(T.findings).update({ video_id: videoId }).eq('id', findingId)
  if (error) {
    throw new JobError(
      `El video quedó listo pero no se pudo asociar al hallazgo: ${describeDbError(error)}`,
      { retryable: true, code: 'video_sin_colgar' },
    )
  }
}

/* ── Storage ──────────────────────────────────────────────────────────── */

/**
 * Dónde vive el archivo. Se deriva de los ids, no de un contador ni de un
 * timestamp: reintentar el mismo video sobrescribe el mismo objeto en vez de
 * dejar copias sueltas pagando almacenamiento.
 *
 * Convención fijada en `supabase/migrations/0009_storage_buckets.sql`.
 */
export function rutaDeVideoEnStorage(
  orgId: string,
  projectId: string,
  videoId: string,
): string {
  return `${orgId}/${projectId}/${videoId}.mp4`
}

/** Dónde deja el agente su grabación, según la misma convención. */
export function rutaDeGrabacionEnStorage(
  orgId: string,
  projectId: string,
  agentSessionId: string,
): string {
  return `${orgId}/${projectId}/${agentSessionId}.webm`
}

async function clienteStorage() {
  const { createAdminClient } = await import('@/lib/supabase/admin')
  return createAdminClient().storage
}

const subirAStorage: SubirVideo = async ({ ruta, archivo }) => {
  const storage = await clienteStorage()

  const { error } = await storage.from(B.videos).upload(ruta, archivo, {
    contentType: 'video/mp4',
    upsert: true,
  })
  if (error) throw new Error(error.message)

  const { data, error: errorFirma } = await storage
    .from(B.videos)
    .createSignedUrl(ruta, VIGENCIA_URL_S)

  if (errorFirma || !data?.signedUrl) {
    throw new Error(errorFirma?.message ?? 'Supabase no devolvió una dirección para el video.')
  }
  return { url: data.signedUrl }
}

const descargarDeStorage: DescargarGrabacion = async (ruta) => {
  const storage = await clienteStorage()
  const { data, error } = await storage.from(B.recordings).download(ruta)
  if (error || !data) return null
  return Buffer.from(await data.arrayBuffer())
}

/* ── Lecturas ─────────────────────────────────────────────────────────── */

interface HallazgoLeido extends Finding {
  projectId: string | null
}

async function leerHallazgo(db: JobsDb, findingId: string): Promise<HallazgoLeido> {
  const { data, error } = await db
    .from(T.findings)
    .select(
      'id, analysis_run_id, project_id, pillar, check_id, severity, confidence, status, ' +
        'title_plain, explanation_plain, impact_plain, fix_prompt, evidence, rank, video_id, created_at',
    )
    .eq('id', findingId)
    .maybeSingle()

  if (error) {
    throw new JobError(`No se pudo leer el hallazgo del video: ${describeDbError(error)}`, {
      retryable: true,
      code: 'hallazgo_ilegible',
    })
  }
  if (!data) {
    throw new JobError(
      'El hallazgo que había que demostrar ya no existe. Puede que el usuario lo haya borrado.',
      { retryable: false, code: 'hallazgo_inexistente' },
    )
  }

  const fila = data as Record<string, unknown>
  const evidence = Array.isArray(fila.evidence) ? (fila.evidence as Evidence[]) : []

  // Regla dura: nada sin evidencia. Un video sin nada que mostrar sería una
  // afirmación con locución, que es justo lo que este producto no hace.
  if (evidence.length === 0) {
    throw new JobError(
      'Ese hallazgo no tiene ninguna prueba que mostrar, así que no se puede demostrar en video.',
      { retryable: false, code: 'hallazgo_sin_evidencia' },
    )
  }

  return {
    id: String(fila.id),
    analysisRunId: String(fila.analysis_run_id ?? ''),
    projectId: (fila.project_id as string | null) ?? null,
    pillar: fila.pillar as Finding['pillar'],
    checkId: String(fila.check_id ?? ''),
    severity: fila.severity as Finding['severity'],
    confidence: fila.confidence as Finding['confidence'],
    status: fila.status as Finding['status'],
    titlePlain: String(fila.title_plain ?? ''),
    explanationPlain: String(fila.explanation_plain ?? ''),
    impactPlain: String(fila.impact_plain ?? ''),
    fixPrompt: String(fila.fix_prompt ?? ''),
    evidence,
    rank: numero(fila.rank, 0),
    videoId: (fila.video_id as string | null) ?? null,
    createdAt: String(fila.created_at ?? new Date().toISOString()),
  }
}

function aFindingDominio(leido: HallazgoLeido): Finding {
  const { projectId: _projectId, ...finding } = leido
  return finding
}

interface ArgsSesiones {
  db: JobsDb
  analysisRunId: string
  orgId: string
  projectId: string
  workspaceDir: string
  recordings?: Record<string, string> | undefined
  descargar?: DescargarGrabacion | undefined
  log: (mensaje: string) => void
}

/**
 * Las sesiones del agente, con su grabación resuelta a un archivo local.
 *
 * Sin grabación el clip igual sale —el guion cae a mostrar el código— pero se
 * pierde lo que hace único al producto, así que cuando no aparece se dice.
 */
async function leerSesiones(
  db: JobsDb,
  args: ArgsSesiones,
): Promise<AgentSessionResult[]> {
  if (!args.analysisRunId) return []

  const { data, error } = await db
    .from(T.agentSessions)
    .select('id, task_id, outcome, conclusion_plain, steps, duration_ms, cost_usd, recording_url')
    .eq('analysis_run_id', args.analysisRunId)

  if (error || !Array.isArray(data)) {
    if (error) args.log(`No se pudieron leer las pruebas del agente: ${describeDbError(error)}`)
    return []
  }

  const sesiones: AgentSessionResult[] = []
  for (const cruda of data as Array<Record<string, unknown>>) {
    const taskId = String(cruda.task_id ?? '')
    const recordingPath = await resolverGrabacion(cruda, taskId, args)

    sesiones.push({
      taskId: taskId as AgentSessionResult['taskId'],
      outcome: String(cruda.outcome ?? 'completed') as AgentSessionResult['outcome'],
      conclusionPlain: String(cruda.conclusion_plain ?? ''),
      steps: (Array.isArray(cruda.steps) ? cruda.steps : []) as AgentSessionResult['steps'],
      ...(recordingPath ? { recordingPath } : {}),
      durationMs: numero(cruda.duration_ms, 0),
      costUsd: numero(cruda.cost_usd, 0),
    })
  }

  if (sesiones.length > 0 && !sesiones.some((s) => s.recordingPath)) {
    args.log(
      'No se encontró ninguna grabación del agente: el video va a mostrar el código en vez de la app funcionando.',
    )
  }

  return sesiones
}

async function resolverGrabacion(
  cruda: Record<string, unknown>,
  taskId: string,
  args: ArgsSesiones,
): Promise<string | undefined> {
  const local = args.recordings?.[taskId]
  if (local && (await existeArchivo(local))) return local

  const guardada = typeof cruda.recording_url === 'string' ? cruda.recording_url : null
  if (guardada && !/^https?:/i.test(guardada) && (await existeArchivo(guardada))) {
    return guardada
  }

  const sessionId = typeof cruda.id === 'string' ? cruda.id : null
  if (!sessionId) return undefined

  // Última parada: el bucket. El worker que grabó puede no ser este.
  const destino = path.join(args.workspaceDir, 'grabaciones', `${sessionId}.webm`)
  if (await existeArchivo(destino)) return destino

  const descargar = args.descargar ?? descargarDeStorage
  try {
    const bytes = await descargar(
      rutaDeGrabacionEnStorage(args.orgId, args.projectId, sessionId),
    )
    if (!bytes) return undefined
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(path.dirname(destino), { recursive: true })
    await writeFile(destino, bytes)
    return destino
  } catch (error) {
    args.log(`No se pudo traer la grabación de ${taskId}: ${describirError(error)}`)
    return undefined
  }
}

async function existeArchivo(ruta: string): Promise<boolean> {
  try {
    const { access } = await import('node:fs/promises')
    await access(ruta)
    return true
  } catch {
    return false
  }
}

/**
 * El mapa del proyecto. A diferencia de `run_checks`, acá **no** es obligatorio:
 * el guion no depende de él (solo lo usa para reconocer nombres de archivo
 * reales). Si falta, el video se hace igual con lo que trae el hallazgo.
 */
async function leerIndice(db: JobsDb, analysisRunId: string): Promise<CodeIndex | null> {
  if (!analysisRunId) return null

  const { data, error } = await db
    .from(T.codeIndex)
    .select('symbol_graph, routes, ranked_files, db_schema, stats')
    .eq('analysis_run_id', analysisRunId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error || !data) return null

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
    dbSchema:
      (fila.db_schema as DbSchemaSnapshot) ??
      ({ source: 'none', tables: [], buckets: [], functions: [] } satisfies DbSchemaSnapshot),
    truncated: Boolean(stats.truncated),
    notes: arreglo(stats.notes) as string[],
  }
}

function numero(valor: unknown, porDefecto: number): number {
  const n = typeof valor === 'string' ? Number.parseFloat(valor) : valor
  return typeof n === 'number' && Number.isFinite(n) ? n : porDefecto
}

function arreglo(valor: unknown): unknown[] {
  return Array.isArray(valor) ? valor : []
}

function describirError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'Error desconocido'
}

/* ── Enganche ─────────────────────────────────────────────────────────── */

registerHandler('generate_video', crearHandlerGenerateVideo())
