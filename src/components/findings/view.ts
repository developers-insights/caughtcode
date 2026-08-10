/**
 * Lógica pura de la pantalla de hallazgos.
 *
 * Vive separada de los componentes para que se pueda testear sin renderizar:
 * la regla de los tres destacados y el orden de lectura son reglas de producto,
 * no detalles de presentación.
 */

import type {
  Evidence,
  Finding,
  FindingStatus,
  JobKind,
  JobStatus,
  Pillar,
  Severity,
  VideoScript,
} from '@/lib/types/domain'
import { PILLAR_LABEL, SEVERITY_ORDER } from '@/lib/types/domain'

/** Regla dura del producto (D15). Nunca más de tres "hacé esto ya". */
export const MAX_DESTACADOS = 3

/* ── Video asociado a un hallazgo ──────────────────────────────────────── */

export type VideoStatus = 'queued' | 'rendering' | 'ready' | 'failed'

export interface FindingVideo {
  id: string
  status: VideoStatus
  url: string | null
  durationSeconds: number | null
  transcript: string | null
  script: VideoScript | null
}

/* ── Corrida ───────────────────────────────────────────────────────────── */

export type RunStatus = 'queued' | 'running' | 'partial' | 'succeeded' | 'failed' | 'cancelled'

export interface RunView {
  id: string
  status: RunStatus
  /** Etapa actual, ya escrita en castellano por el motor. */
  stage: string | null
  progress: number
  finishedAt: string | null
  error: string | null
}

/** ¿La auditoría sigue trabajando? Determina si mostramos progreso en vivo. */
export function estaCorriendo(run: RunView | null): boolean {
  return run?.status === 'queued' || run?.status === 'running'
}

/** Terminó, pero no del todo bien: hay hallazgos y además algo se cortó. */
export function terminoAMedias(run: RunView | null): boolean {
  return run?.status === 'partial'
}

/** Se cortó antes de terminar. Lo que haya llegado sigue siendo válido. */
export function seCorto(run: RunView | null): boolean {
  return run?.status === 'failed' || run?.status === 'cancelled'
}

/* ── Trabajos en cola ──────────────────────────────────────────────────── */

export interface JobView {
  id: string
  kind: JobKind
  status: JobStatus
  /** Lo que dijo el motor al fallar. Ya viene escrito para el usuario. */
  lastError: string | null
  createdAt: string
}

/**
 * Los trabajos que componen una revisión.
 *
 * `scan_comments` y `build_tutorials` son de otras pantallas: si uno de esos
 * falla, no tiene nada que decir acá y no puede teñir el estado de la revisión.
 */
export const TRABAJOS_DE_REVISION: readonly JobKind[] = [
  'ingest_repo',
  'index_code',
  'run_checks',
  'run_browser_agent',
  'generate_video',
]

export function esTrabajoDeRevision(trabajo: Pick<JobView, 'kind'>): boolean {
  return TRABAJOS_DE_REVISION.includes(trabajo.kind)
}

/**
 * En qué punto está la revisión de este proyecto.
 *
 * Existe por la regla dura de "ninguna afirmación sin evidencia". Mirando solo
 * la corrida no se puede distinguir *nunca revisamos* de *revisamos y salió
 * limpio*: en los dos casos no hay hallazgos. La diferencia está en la cola, y
 * confundirlas es decirle a alguien que su app está bien sin haberla mirado.
 */
export type EstadoDeRevision =
  /** No se pidió nunca. Hay que ofrecer arrancar. */
  | { fase: 'sin-revisar' }
  /** Pedida, esperando que la agarre un trabajador. */
  | { fase: 'en-cola' }
  /** Corriendo ahora mismo. */
  | { fase: 'corriendo'; run: RunView }
  /** Se cortó o ni arrancó. `motivo` es lo que dijo el motor, tal cual. */
  | { fase: 'fallada'; motivo: string | null }
  /** Terminó. Recién acá tiene sentido hablar de lo que se encontró. */
  | { fase: 'lista'; run: RunView }

export function estadoDeRevision(
  run: RunView | null,
  trabajos: readonly JobView[] = [],
): EstadoDeRevision {
  // Más reciente primero. El último trabajo manda: un reintento pisa al fallo
  // anterior, no al revés.
  const propios = [...trabajos]
    .filter(esTrabajoDeRevision)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  if (run) {
    if (estaCorriendo(run)) return { fase: 'corriendo', run }
    if (seCorto(run)) return { fase: 'fallada', motivo: motivoDelCorte(run, propios) }
    // Terminada (`succeeded` o `partial`). Si después falló un trabajo suelto
    // —el video de un hallazgo, por ejemplo— la revisión sigue siendo válida y
    // lo encontrado no se tapa con un cartel de error.
    return { fase: 'lista', run }
  }

  const ultimo = propios[0]
  if (!ultimo) return { fase: 'sin-revisar' }
  if (ultimo.status === 'failed') return { fase: 'fallada', motivo: ultimo.lastError }
  if (propios.some((t) => t.status === 'queued' || t.status === 'running')) {
    return { fase: 'en-cola' }
  }

  // Trabajos terminados y ninguna corrida: no hay nada en marcha ni nada que
  // mostrar. Ofrecer empezar de nuevo es lo único cierto que podemos decir.
  return { fase: 'sin-revisar' }
}

function motivoDelCorte(run: RunView, trabajos: readonly JobView[]): string | null {
  if (run.error?.trim()) return run.error
  return trabajos.find((t) => t.status === 'failed' && t.lastError?.trim())?.lastError ?? null
}

/* ── Orden y agrupación ────────────────────────────────────────────────── */

const ESTADO_PESO: Record<FindingStatus, number> = { open: 0, fixed: 1, dismissed: 2 }

/**
 * Orden de lectura: primero lo sin resolver, después por posición asignada por
 * el motor, y a igualdad por gravedad. El desempate final es estable por id
 * para que la lista no salte cuando llegan hallazgos nuevos en vivo.
 */
export function ordenarHallazgos<T extends Finding>(findings: readonly T[]): T[] {
  return [...findings].sort((a, b) => {
    const porEstado = ESTADO_PESO[a.status] - ESTADO_PESO[b.status]
    if (porEstado !== 0) return porEstado

    const rankA = a.rank > 0 ? a.rank : Number.MAX_SAFE_INTEGER
    const rankB = b.rank > 0 ? b.rank : Number.MAX_SAFE_INTEGER
    if (rankA !== rankB) return rankA - rankB

    const porGravedad = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    if (porGravedad !== 0) return porGravedad

    return a.id.localeCompare(b.id)
  })
}

export interface ListaDeHallazgos<T extends Finding> {
  /** Como mucho tres. Se presentan como "hacé esto ya". */
  destacados: T[]
  /** Todo lo demás que sigue sin resolver. Va colapsado, agrupado por área. */
  resto: T[]
  /** Ya resueltos o descartados. Fuera del camino, pero no borrados. */
  cerrados: T[]
}

/**
 * Parte la lista en las tres bandejas de la pantalla.
 *
 * Los destacados salen del `rank` 1..3 que asigna el motor. Si por lo que sea
 * llegaran más de tres marcados, acá se corta igual: la pantalla nunca muestra
 * cuatro cosas urgentes, porque cuatro urgencias no son urgencias.
 */
export function partirHallazgos<T extends Finding>(findings: readonly T[]): ListaDeHallazgos<T> {
  const ordenados = ordenarHallazgos(findings)

  const abiertos = ordenados.filter((f) => f.status === 'open')
  const cerrados = ordenados.filter((f) => f.status !== 'open')

  const candidatos = abiertos.filter((f) => f.rank >= 1 && f.rank <= MAX_DESTACADOS)
  const destacados = candidatos.slice(0, MAX_DESTACADOS)
  const elegidos = new Set(destacados.map((f) => f.id))

  return {
    destacados,
    resto: abiertos.filter((f) => !elegidos.has(f.id)),
    cerrados,
  }
}

export interface GrupoPorPilar<T extends Finding> {
  pilar: Pillar
  titulo: string
  hallazgos: T[]
}

/** Orden fijo de las áreas: seguridad primero siempre. */
const ORDEN_PILARES: Pillar[] = ['security', 'completeness', 'store_hygiene']

export function agruparPorPilar<T extends Finding>(findings: readonly T[]): GrupoPorPilar<T>[] {
  return ORDEN_PILARES.map((pilar) => ({
    pilar,
    titulo: PILLAR_LABEL[pilar],
    hallazgos: ordenarHallazgos(findings.filter((f) => f.pillar === pilar)),
  })).filter((grupo) => grupo.hallazgos.length > 0)
}

/** Cuántos siguen sin resolver. Alimenta el contador de la navegación. */
export function contarSinResolver(findings: readonly Finding[]): number {
  return findings.filter((f) => f.status === 'open').length
}

/** La peor gravedad que hay sin resolver. Define el tono del encabezado. */
export function peorGravedad(findings: readonly Finding[]): Severity | null {
  const abiertos = findings.filter((f) => f.status === 'open')
  if (abiertos.length === 0) return null
  return abiertos.reduce<Severity>(
    (peor, f) => (SEVERITY_ORDER[f.severity] < SEVERITY_ORDER[peor] ? f.severity : peor),
    'low',
  )
}

/* ── Evidencia ─────────────────────────────────────────────────────────── */

/**
 * Regla dura (D14): un hallazgo sin evidencia no se puede renderizar.
 * Si llega uno así es un error del sistema, y la pantalla lo dice.
 */
export function tieneEvidencia(finding: Pick<Finding, 'evidence'>): boolean {
  return Array.isArray(finding.evidence) && finding.evidence.length > 0
}

/** Momento de la grabación al que apunta la evidencia, si lo hay. */
export function momentoEnGrabacion(evidence: readonly Evidence[]): number | null {
  const clip = evidence.find((e) => e.kind === 'recording')
  return clip ? clip.startMs / 1000 : null
}

/* ── Subtítulos derivados del guion ────────────────────────────────────── */

export interface Cue {
  id: string
  startSeconds: number
  endSeconds: number
  /** Lo que se ve en pantalla. Más corto que la narración. */
  caption: string
  /** Lo que dice la voz. Es lo que se busca en la transcripción. */
  narration: string
}

/**
 * Convierte el guion en subtítulos con tiempos.
 *
 * El guion trae la duración de cada escena, no el momento en que arranca:
 * acá se acumulan. Sirve para dos cosas a la vez — el subtítulo sobre el
 * video y la transcripción de abajo, que se puede clickear para saltar.
 */
export function cuesDelGuion(script: VideoScript | null | undefined): Cue[] {
  if (!script?.scenes?.length) return []

  let acumulado = 0
  return script.scenes.map((escena) => {
    const startSeconds = acumulado / 1000
    acumulado += escena.durationMs
    return {
      id: escena.id,
      startSeconds,
      endSeconds: acumulado / 1000,
      caption: escena.caption ?? escena.narration,
      narration: escena.narration,
    }
  })
}

/** Qué subtítulo corresponde al segundo actual de reproducción. */
export function cueActivo(cues: readonly Cue[], seconds: number): Cue | null {
  return cues.find((c) => seconds >= c.startSeconds && seconds < c.endSeconds) ?? null
}

/** Búsqueda dentro de la transcripción. Sin acentos ni mayúsculas de por medio. */
export function filtrarCues(cues: readonly Cue[], consulta: string): Cue[] {
  const q = normalizar(consulta)
  if (!q) return [...cues]
  return cues.filter((c) => normalizar(`${c.narration} ${c.caption}`).includes(q))
}

const ACENTOS = /[\u0300-\u036f]/g

function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(ACENTOS, '')
    .trim()
}

/* ── Formato ───────────────────────────────────────────────────────────── */

/** mm:ss. Se usa en el reproductor y en la transcripción. */
export function reloj(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}
