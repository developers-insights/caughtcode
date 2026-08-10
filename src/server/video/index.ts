/**
 * Producción de un clip de hallazgo, de punta a punta.
 *
 * Lo usa: el worker de la cola (`kind: 'generate_video'`) y
 * `scripts/medir-cogs.ts`.
 *
 * Cuatro etapas, cada una con su marca en disco: **guion → voz → render →
 * mezcla**. Si una ya corrió, no se repite. Eso no es una optimización: un clip
 * tarda minutos y cuesta plata, así que un reintento después de un fallo de red
 * en la etapa 4 no puede volver a pagar el guion y la locución.
 *
 * El orden importa y no es arbitrario: las duraciones definitivas de las
 * escenas salen de **medir el audio real**, no de estimar. Recién con la voz
 * grabada se sabe cuánto dura cada frase, y recién ahí se puede cerrar la banda
 * de 60-90 s recortando la demostración sin tocar la explicación.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type {
  AgentSessionResult,
  CodeIndex,
  CostBreakdown,
  Finding,
  RenderedVideo,
  VideoScene,
  VideoScript,
} from '@/lib/types/domain'
import { llmCostUsd } from '@/server/cost/pricing'

import { ensamblarVoz, pistaEsSilencio, type SegmentoVoz } from './audio'
import { costoRenderMedido, crearContador, desglosar, type DesgloseClip } from './cogs'
import { inspeccionar } from './ffmpeg'
import { mezclar } from './mux'
import { tonoDeSeveridad, type Tono } from './render/page'
import { crearRendererRemotion } from './render/remotion'
import { crearRendererWeb } from './render/web'
import { buildScript, type ScriptDeps } from './script'
import { construirTranscripcion, construirVtt, cuesDeGuion, type Cue } from './subtitles'
import {
  ajustarDuraciones,
  dentroDeBanda,
  duracionTotal,
  ubicarEscenas,
  type SceneRole,
  type TramoEntrada,
  type UbicacionEscena,
} from './timing'
import { crearProveedorNone, elegirProveedor, narrar, opcionesDesdeEntorno } from './tts'
import type { TtsProvider } from './tts/types'
import type { VideoRenderer } from './renderer'

export * from './renderer'
export { buildScript } from './script'
export { mezclar } from './mux'
export { ajustarDuraciones, dentroDeBanda } from './timing'

/* ── Entrada y salida ─────────────────────────────────────────────────── */

export type EtapaVideo = 'guion' | 'voz' | 'render' | 'mezcla'

/**
 * Vocabulario exacto de `videos.status` en la base. No inventar valores acá:
 * la columna tiene un check y cualquier otra cosa se rechaza.
 */
export type VideoStatus = 'queued' | 'rendering' | 'ready' | 'failed'

/** Mientras corre cualquiera de las cuatro etapas, la fila está `rendering`. */
export const ETAPA_A_ESTADO: Record<EtapaVideo, VideoStatus> = {
  guion: 'rendering',
  voz: 'rendering',
  render: 'rendering',
  mezcla: 'rendering',
}

export interface ProgresoVideo {
  etapa: EtapaVideo
  /** Estado a persistir en `videos.status` mientras dura esta etapa. */
  status: VideoStatus
  /** 0..100 sobre el clip completo. */
  porcentaje: number
  detalle?: string
}

export interface GenerarVideoOpciones {
  finding: Finding
  /**
   * Obligatorio: la base rechaza un video que no tenga ni `finding_id` ni
   * `project_id`. `Finding` no lo trae, así que viaja aparte.
   */
  projectId: string
  sessions: AgentSessionResult[]
  index?: CodeIndex | null
  /** Carpeta de trabajo del proyecto. Se crea `video/<idHallazgo>/` adentro. */
  workspaceDir: string
  /** Cliente de modelo inyectado. Sin esto el guion sale directo del catálogo. */
  complete?: ScriptDeps['complete']
  completeJson?: ScriptDeps['completeJson']
  /** Proveedor de voz. Si falta, se elige por `TTS_PROVIDER`. */
  tts?: TtsProvider
  /** Motor de video. Si falta, se elige por `VIDEO_RENDERER`. */
  renderer?: VideoRenderer
  onProgress?: (progreso: ProgresoVideo) => void
  /** Rehacer todo aunque haya etapas ya resueltas. */
  forzar?: boolean
  entorno?: NodeJS.ProcessEnv
}

export interface ResultadoVideo extends RenderedVideo {
  /** Listo para insertar en `videos`: los tres campos que exige la base. */
  findingId: string
  projectId: string
  status: VideoStatus
  /** Ruta del MP4 en disco. Subirlo a Storage no es tarea de este frente. */
  videoPath: string
  vttPath: string
  transcriptPath: string
  script: VideoScript
  cues: Cue[]
  costBreakdown: CostBreakdown
  desglose: DesgloseClip
  /** Todo lo que salió distinto de lo ideal. No se esconde nada acá. */
  avisos: string[]
  /**
   * El clip salió sin narración. **No es un fallo**: el video existe, se ve y
   * se entiende con los subtítulos. Pero nunca se entrega mudo sin decir por
   * qué, así que viene siempre acompañado de `motivoSinVoz`.
   */
  sinVoz: boolean
  /** Por qué no hay voz. Siempre presente cuando `sinVoz` es `true`. */
  motivoSinVoz?: string
  workDir: string
}

/** Cuando la voz está apagada a propósito, el motivo igual tiene que existir. */
const VOZ_APAGADA =
  'La voz está apagada en la configuración de este entorno (TTS_PROVIDER=none). ' +
  'El clip sale con los subtítulos y la transcripción intactos.'

/* ── Motor de video ───────────────────────────────────────────────────── */

export function elegirRenderer(entorno: NodeJS.ProcessEnv = process.env): VideoRenderer {
  const pedido = (entorno.VIDEO_RENDERER ?? 'web').toLowerCase()
  if (pedido === 'remotion') return crearRendererRemotion()
  return crearRendererWeb()
}

/* ── Marcas de etapa ──────────────────────────────────────────────────── */

async function leerMarca<T>(ruta: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(ruta, 'utf8')) as T
  } catch {
    return null
  }
}

async function escribirMarca(ruta: string, valor: unknown): Promise<void> {
  await writeFile(ruta, JSON.stringify(valor, null, 2), 'utf8')
}

async function existe(ruta: string): Promise<boolean> {
  try {
    await readFile(ruta)
    return true
  } catch {
    return false
  }
}

interface MarcaGuion {
  script: VideoScript
  roles: SceneRole[]
  usoLlm: boolean
  modelo?: string
  costUsd: number
  avisos: string[]
}

interface MarcaVoz {
  provider: string
  voice: string
  motivo?: string
  costUsd: number
  caracteres: number
  segmentos: Array<{ sceneId: string; audioPath: string; durationMs: number; characters: number }>
  script: VideoScript
  ubicaciones: UbicacionEscena[]
  cues: Cue[]
  pistaPath: string
  silencio: boolean
  avisos: string[]
}

interface MarcaRender {
  videoPath: string
  preRollMs: number
  timelineMs: number
  computeMs: number
  origenTokens: 'app' | 'fallback'
  renderer: string
}

/* ── Entrada principal ────────────────────────────────────────────────── */

export async function generateVideo(opciones: GenerarVideoOpciones): Promise<ResultadoVideo> {
  const entorno = opciones.entorno ?? process.env
  // El estado no lo decide cada llamada: sale de la etapa, así nadie escribe
  // en `videos.status` un valor que la base no acepta.
  const avisar = (progreso: Omit<ProgresoVideo, 'status'>) =>
    opciones.onProgress?.({ ...progreso, status: ETAPA_A_ESTADO[progreso.etapa] })
  const avisos: string[] = []
  const contador = crearContador()

  const workDir = path.join(opciones.workspaceDir, 'video', opciones.finding.id)
  await mkdir(workDir, { recursive: true })
  const dirVoz = path.join(workDir, 'voz')

  const tono: Tono = tonoDeSeveridad(
    opciones.finding.severity,
    opciones.finding.confidence === 'to_review',
  )

  /* Etapa 1 — guion ---------------------------------------------------- */

  const rutaGuion = path.join(workDir, 'guion.json')
  avisar({ etapa: 'guion', porcentaje: 2, detalle: 'escribiendo el guion' })

  let marcaGuion = opciones.forzar ? null : await leerMarca<MarcaGuion>(rutaGuion)
  if (!marcaGuion) {
    const resultado = await buildScript(opciones.finding, opciones.sessions, opciones.index, {
      complete: opciones.complete,
      completeJson: opciones.completeJson,
      costoLlm: llmCostUsd,
    })
    marcaGuion = {
      script: resultado.script,
      roles: rolesDeEscenas(resultado.script.scenes),
      usoLlm: resultado.usoLlm,
      modelo: resultado.modelo,
      costUsd: resultado.costUsd,
      avisos: resultado.avisos,
    }
    await escribirMarca(rutaGuion, marcaGuion)
  }
  avisos.push(...marcaGuion.avisos)
  if (marcaGuion.costUsd > 0) {
    contador.sumar({
      category: 'llm',
      units: 1,
      unitLabel: 'guion',
      costUsd: marcaGuion.costUsd,
      detail: marcaGuion.modelo,
    })
  }

  /* Etapa 2 — voz y cierre de tiempos ---------------------------------- */

  const rutaVoz = path.join(workDir, 'voz.json')
  avisar({ etapa: 'voz', porcentaje: 15, detalle: 'grabando la narración' })

  let marcaVoz = opciones.forzar ? null : await leerMarca<MarcaVoz>(rutaVoz)
  if (marcaVoz && !(await existe(marcaVoz.pistaPath))) marcaVoz = null

  if (!marcaVoz) {
    marcaVoz = await producirVoz({
      script: marcaGuion.script,
      roles: marcaGuion.roles,
      dirVoz,
      workDir,
      tts: opciones.tts,
      entorno,
      onProgress: (p) => avisar({ etapa: 'voz', porcentaje: 15 + Math.round(p * 0.25) }),
    })
    await escribirMarca(rutaVoz, marcaVoz)
  }
  avisos.push(...marcaVoz.avisos)
  if (marcaVoz.motivo) avisos.push(marcaVoz.motivo)
  // Se registra aunque el costo sea cero: con TTS_PROVIDER=none los caracteres
  // igual sirven para proyectar cuánto saldría el mismo clip con Azure.
  contador.sumar({
    category: 'tts',
    units: marcaVoz.caracteres,
    unitLabel: 'caracteres narrados',
    costUsd: marcaVoz.costUsd,
    detail: `${marcaVoz.provider} · ${marcaVoz.voice}`,
  })

  const script = marcaVoz.script
  if (!dentroDeBanda(script.totalDurationMs)) {
    avisos.push(
      `El clip dura ${Math.round(script.totalDurationMs / 1000)} s y la banda comprometida es 60-90 s.`,
    )
  }

  /* Etapa 3 — render ---------------------------------------------------- */

  const rutaRender = path.join(workDir, 'render.json')
  avisar({ etapa: 'render', porcentaje: 45, detalle: 'grabando la escena' })

  const renderer = opciones.renderer ?? elegirRenderer(entorno)
  let marcaRender = opciones.forzar ? null : await leerMarca<MarcaRender>(rutaRender)
  if (marcaRender && !(await existe(marcaRender.videoPath))) marcaRender = null

  if (!marcaRender) {
    const salida = await renderer.render({
      script,
      ubicaciones: marcaVoz.ubicaciones,
      cues: marcaVoz.cues,
      contexto: { titulo: opciones.finding.titlePlain, tono },
      workDir,
      onProgress: (detalle, p) =>
        avisar({ etapa: 'render', porcentaje: 45 + Math.round(p * 0.3), detalle }),
    })
    marcaRender = { ...salida, renderer: renderer.id }
    await escribirMarca(rutaRender, marcaRender)
  }
  if (marcaRender.origenTokens === 'fallback') {
    avisos.push(
      'Los colores del video salieron de la copia de tokens de video/template/, no de src/styles/tokens.css.',
    )
  }
  contador.sumar({
    category: 'render',
    units: Math.round((marcaRender.computeMs / 60_000) * 100) / 100,
    unitLabel: 'minutos de máquina',
    costUsd: costoRenderMedido(marcaRender.computeMs),
    detail: renderer.id,
  })

  /* Etapa 4 — mezcla ---------------------------------------------------- */

  avisar({ etapa: 'mezcla', porcentaje: 80, detalle: 'pegando la voz' })

  const videoPath = path.join(workDir, 'clip.mp4')
  const mezcla = await mezclar({
    videoPath: marcaRender.videoPath,
    audioPath: marcaVoz.pistaPath,
    salidaPath: videoPath,
    preRollMs: marcaRender.preRollMs,
    durationMs: script.totalDurationMs,
    normalizarAudio: !marcaVoz.silencio,
    onProgress: (p) => avisar({ etapa: 'mezcla', porcentaje: 80 + Math.round(p * 0.18) }),
  })
  contador.sumar({
    category: 'render',
    units: Math.round((mezcla.computeMs / 60_000) * 100) / 100,
    unitLabel: 'minutos de máquina',
    costUsd: costoRenderMedido(mezcla.computeMs),
    detail: 'mezcla',
  })

  if (!mezcla.info.tieneVideo) avisos.push('El archivo final no tiene pista de video.')
  if (!mezcla.info.tieneAudio) avisos.push('El archivo final no tiene pista de audio.')

  /* Subtítulos y transcripción ------------------------------------------ */

  const vttPath = path.join(workDir, 'subtitulos.vtt')
  const transcriptPath = path.join(workDir, 'transcripcion.txt')
  const transcript = construirTranscripcion(script.scenes)
  await Promise.all([
    writeFile(vttPath, construirVtt(marcaVoz.cues), 'utf8'),
    writeFile(transcriptPath, transcript, 'utf8'),
  ])

  const sinVoz = marcaVoz.provider === 'none'
  const motivoSinVoz = sinVoz ? (marcaVoz.motivo ?? VOZ_APAGADA) : undefined
  if (sinVoz && !marcaVoz.motivo) avisos.push(VOZ_APAGADA)

  const breakdown = contador.resumen()
  const computeTotalMs = marcaRender.computeMs + mezcla.computeMs
  const desglose = desglosar(breakdown, computeTotalMs, mezcla.info.durationMs || script.totalDurationMs)

  await escribirMarca(path.join(workDir, 'costo.json'), { breakdown, desglose, avisos })
  avisar({ etapa: 'mezcla', porcentaje: 100, detalle: 'listo' })

  return {
    findingId: opciones.finding.id,
    projectId: opciones.projectId,
    status: 'ready',
    url: videoPath,
    videoPath,
    vttPath,
    transcriptPath,
    durationSeconds: Math.round(((mezcla.info.durationMs || script.totalDurationMs) / 1000) * 100) / 100,
    transcript,
    costUsd: breakdown.totalUsd,
    renderer: renderer.id,
    script,
    cues: marcaVoz.cues,
    costBreakdown: breakdown,
    desglose,
    avisos,
    sinVoz,
    ...(motivoSinVoz ? { motivoSinVoz } : {}),
    workDir,
  }
}

/* ── Etapa de voz ─────────────────────────────────────────────────────── */

interface ProducirVozArgs {
  script: VideoScript
  roles: SceneRole[]
  dirVoz: string
  workDir: string
  tts?: TtsProvider
  entorno: NodeJS.ProcessEnv
  onProgress?: (porcentaje: number) => void
}

/**
 * Graba cada frase, mide lo que realmente dura, y recién entonces cierra las
 * duraciones de las escenas. Es el único punto del pipeline donde el tiempo
 * deja de ser una estimación.
 */
async function producirVoz(args: ProducirVozArgs): Promise<MarcaVoz> {
  const avisos: string[] = []
  const elegido = args.tts
    ? { provider: args.tts, motivo: undefined as string | undefined }
    : elegirProveedor(opcionesDesdeEntorno(args.entorno))

  await mkdir(args.dirVoz, { recursive: true })

  // Primero se intenta con el proveedor configurado. Si el servicio no
  // responde, la clave está vencida o la cuota se acabó, el clip **igual sale**:
  // se rehace la locución completa en silencio y se deja dicho por qué.
  //
  // Se rehace *toda*, no solo la frase que falló, a propósito. Un clip mitad
  // narrado y mitad mudo se ve como un producto roto; uno entero sin voz, con
  // los subtítulos puestos, se ve como una decisión.
  let provider = elegido.provider
  let motivo = elegido.motivo

  let grabacion = await grabarNarracion(provider, args)
  if (!grabacion.ok) {
    if (provider.id === 'none') throw grabacion.error
    provider = crearProveedorNone()
    motivo =
      `No se pudo grabar la narración con ${elegido.provider.name}: ${describirFalla(grabacion.error)}. ` +
      'El clip sale sin voz, con los subtítulos y la transcripción intactos.'
    grabacion = await grabarNarracion(provider, args)
    if (!grabacion.ok) throw grabacion.error
  }

  const { audios, costUsd, caracteres } = grabacion

  // Cuánto material de grabación hay de verdad, para no estirar al vacío.
  const materiales = await medirMateriales(args.script)

  const entrada: TramoEntrada[] = args.script.scenes.map((escena, i) => ({
    role: args.roles[i] ?? 'demostracion',
    audioMs: audios[i].durationMs,
    materialMaxMs: materiales[i],
  }))

  const ajuste = ajustarDuraciones(entrada)
  avisos.push(...ajuste.avisos)

  const ubicaciones = ubicarEscenas(
    ajuste.tramos.map((t, i) => ({ durationMs: t.durationMs, audioMs: audios[i].durationMs })),
  )

  // El guion definitivo: duraciones medidas y tramos de grabación alineados a
  // lo que cada escena va a estar realmente en pantalla.
  const scenes: VideoScene[] = args.script.scenes.map((escena, i) => ({
    ...escena,
    durationMs: ubicaciones[i].durationMs,
    visual:
      escena.visual.type === 'recording'
        ? {
            ...escena.visual,
            endMs: escena.visual.startMs + ubicaciones[i].durationMs,
          }
        : escena.visual,
  }))

  const script: VideoScript = {
    ...args.script,
    scenes,
    totalDurationMs: duracionTotal(ubicaciones),
  }

  const cues = cuesDeGuion(
    scenes.map((escena, i) => ({
      narration: escena.narration,
      vozStartMs: ubicaciones[i].vozStartMs,
      audioMs: audios[i].durationMs,
    })),
  )

  const segmentos: SegmentoVoz[] = audios.map((a, i) => ({
    audioPath: a.audioPath,
    startMs: ubicaciones[i].vozStartMs,
  }))

  const pistaPath = path.join(args.workDir, 'narracion.wav')
  const pista = await ensamblarVoz(segmentos, script.totalDurationMs, pistaPath)
  avisos.push(...pista.avisos)

  return {
    provider: provider.id,
    voice: provider.defaultVoice,
    motivo,
    costUsd,
    caracteres,
    segmentos: audios,
    script,
    ubicaciones,
    cues,
    pistaPath,
    silencio: await pistaEsSilencio(pistaPath),
    avisos,
  }
}

interface AudioDeEscena {
  sceneId: string
  audioPath: string
  durationMs: number
  characters: number
}

type Grabacion =
  | { ok: true; audios: AudioDeEscena[]; costUsd: number; caracteres: number }
  | { ok: false; error: unknown }

/**
 * Narra todas las escenas con un proveedor. No tira: devuelve el error para que
 * el llamador decida si degrada o corta.
 *
 * La caché de `narrar` está indexada por (proveedor, voz, ssml), así que
 * reintentar con otro proveedor sobre el mismo `basename` regenera el archivo en
 * vez de devolver el de la tanda anterior. Sin eso, un reintento después de una
 * falla a mitad de camino mezclaría frases narradas con frases mudas.
 */
async function grabarNarracion(
  provider: TtsProvider,
  args: ProducirVozArgs,
): Promise<Grabacion> {
  const audios: AudioDeEscena[] = []
  let costUsd = 0
  let caracteres = 0

  for (const [i, escena] of args.script.scenes.entries()) {
    let resultado
    try {
      resultado = await narrar(provider, escena.narration, {
        outDir: args.dirVoz,
        basename: escena.id,
      })
    } catch (error) {
      return { ok: false, error }
    }
    audios.push({
      sceneId: escena.id,
      audioPath: resultado.audioPath,
      durationMs: resultado.durationMs,
      characters: resultado.characters,
    })
    costUsd += resultado.costUsd
    caracteres += resultado.characters
    args.onProgress?.(Math.round(((i + 1) / args.script.scenes.length) * 100))
  }

  return { ok: true, audios, costUsd, caracteres }
}

function describirFalla(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Cuánta grabación queda desde el inicio de cada tramo. */
async function medirMateriales(script: VideoScript): Promise<Array<number | undefined>> {
  const cache = new Map<string, number>()

  return Promise.all(
    script.scenes.map(async (escena) => {
      if (escena.visual.type !== 'recording') return undefined
      const ruta = escena.visual.recordingPath
      if (!ruta) return undefined
      if (!cache.has(ruta)) {
        try {
          const info = await inspeccionar(ruta)
          cache.set(ruta, info.durationMs)
        } catch {
          cache.set(ruta, 0)
        }
      }
      const total = cache.get(ruta) ?? 0
      if (total <= 0) return undefined
      return Math.max(0, total - escena.visual.startMs)
    }),
  )
}

/** Los roles se deducen del id de escena que puso `script.ts`. */
export function rolesDeEscenas(scenes: VideoScene[]): SceneRole[] {
  return scenes.map((escena) => {
    if (escena.id === 'gancho') return 'gancho'
    if (escena.id === 'prueba') return 'prueba'
    if (escena.id === 'accion') return 'accion'
    return 'demostracion'
  })
}
