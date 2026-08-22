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
import { PILLAR_LABEL, SEVERITY_ORDER, TRABAJOS_DE_REVISION } from '@/lib/types/domain'
import { traducirErrorTecnico, type ErrorLegible } from '@/content/lenguaje'

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
  /**
   * Cuándo se tocó por última vez esta fila. Mientras el trabajo corre, el
   * motor la toca con cada latido — es lo único que tenemos para saber si
   * sigue vivo o si el proceso que lo tenía se murió sin avisar.
   */
  updatedAt: string
}

/**
 * Los trabajos que componen una revisión.
 *
 * `scan_comments` y `build_tutorials` son de otras pantallas: si uno de esos
 * falla, no tiene nada que decir acá y no puede teñir el estado de la revisión.
 *
 * La lista vive en `@/lib/types/domain`, compartida con el servidor
 * (`@/server/jobs/reconcile`). Se re-exporta para no romper a quien la
 * importaba desde este módulo.
 */
export { TRABAJOS_DE_REVISION }

export function esTrabajoDeRevision(trabajo: Pick<JobView, 'kind'>): boolean {
  return TRABAJOS_DE_REVISION.includes(trabajo.kind)
}

/* ── Corrida abandonada ────────────────────────────────────────────────── */

/**
 * Cuánto puede pasar sin un latido antes de dar por muerto un trabajo que la
 * base todavía dice "corriendo".
 *
 * El número sale de la aritmética del motor, no de una intuición:
 *
 *   - el runner late cada 15 s (`HEARTBEAT_MS` en `src/server/jobs/runner.ts`)
 *     y cada latido renueva el arriendo del trabajo;
 *   - el arriendo dura 90 s (`DEFAULT_LEASE_SECONDS` en
 *     `src/server/jobs/queue.ts`), o sea seis latidos perdidos seguidos;
 *   - vencido el arriendo, `requeueExpired()` devuelve el trabajo a la cola en
 *     el próximo tick, y el tick corre cada minuto.
 *
 * Un worker que se murió tiene entonces su trabajo de vuelta en la fila a los
 * 150 s (90 + 60) de su último latido. Ahí esta pantalla lo ve `queued` y sigue
 * mostrando progreso, que es exactamente lo correcto: el sistema se está
 * curando solo y no hay nada que anunciar. Le damos lugar a un tick perdido
 * —el candado puede estar tomado, o la instancia puede haberse muerto por
 * memoria a mitad de tanda— y llegamos a 210 s. Redondeamos a 4 minutos.
 *
 * Pasado eso ya no queda nadie que lo vaya a rescatar (el cron está caído, o se
 * acabaron los intentos sin que nadie escribiera el fallo), y esta pantalla es
 * lo único que puede sacar al usuario de un spinner que gira para siempre.
 *
 * Eran 6 minutos, heredados de cuando el arriendo duraba 300 s. Ese arriendo ya
 * no existe: el número no tenía por qué sobrevivirlo, y de hecho lo único que
 * agregaba eran dos minutos de spinner de más.
 */
export const UMBRAL_SIN_LATIDO_MS = 4 * 60 * 1000

/**
 * Cuánto esperamos, con todos los trabajos ya terminados, antes de decir que la
 * corrida quedó abierta y no la va a cerrar nadie.
 *
 * Ese cierre hoy lo hace el servidor solo: `barrerCorridasHuerfanas()` corre al
 * principio de cada tick y cierra toda corrida `running` que no tenga un solo
 * trabajo de revisión pendiente. Con el cron cada minuto, y dando lugar a un
 * tick perdido, en 2 minutos ya está cerrada.
 *
 * Sin esta espera estaríamos corriendo una carrera contra el propio servidor: el
 * usuario vería "Se cortó la revisión" y unos segundos después la misma pantalla
 * se convertiría en un informe terminado. Un cartel de error que se desmiente
 * solo enseña a no creerle a los carteles. Preferimos llegar tarde.
 */
export const GRACIA_CIERRE_MS = 2 * 60 * 1000

/** ¿Este trabajo, que la base todavía dice que está corriendo, dejó de latir? */
export function trabajoSinLatido(
  trabajo: Pick<JobView, 'status' | 'updatedAt'>,
  ahoraMs: number,
): boolean {
  if (trabajo.status !== 'running') return false
  const ultimoLatido = Date.parse(trabajo.updatedAt)
  if (!Number.isFinite(ultimoLatido)) return false
  return ahoraMs - ultimoLatido > UMBRAL_SIN_LATIDO_MS
}

/**
 * La corrida dice "corriendo" pero ya no hay nadie trabajándola de verdad.
 *
 * ## Por qué mira todos los trabajos y no el último
 *
 * Mirar solo el más nuevo valía mientras la cadena era estrictamente serial.
 * Dejó de valer con el abanico de videos: `run_checks` encola hasta tres
 * (`MAX_VIDEOS_POR_CORRIDA`) y el worker los toma de a dos, así que terminan en
 * el orden en que tardan, no en el que se encolaron. Con el tercero terminando
 * antes que el segundo, "el último trabajo" está `succeeded` mientras el segundo
 * sigue renderizando tranquilo — y la pantalla anunciaba que la revisión se
 * había cortado encima de un trabajo vivo.
 *
 * ## La regla
 *
 * Es un agregado sobre **todos** los trabajos de la revisión:
 *
 *   - si alguno espera turno, no está abandonada: puede estar por arrancar, o
 *     puede ser uno que el servidor acaba de rescatar por arriendo vencido;
 *   - si alguno corre, alcanza con que **uno solo** siga latiendo para que la
 *     corrida esté viva. Abandonada solo si ninguno late;
 *   - si no queda ninguno pendiente, la corrida quedó abierta sin nadie que la
 *     cierre — pero eso lo arregla el servidor solo en ≤ `GRACIA_CIERRE_MS`, así
 *     que recién después de esa espera lo decimos.
 *
 * Sin ningún trabajo propio no afirmamos nada — sin datos, la pantalla sigue
 * mostrando el progreso normal en vez de acusar en falso.
 */
export function corridaAbandonada(
  run: RunView | null,
  trabajos: readonly JobView[],
  ahoraMs: number = Date.now(),
): boolean {
  if (!estaCorriendo(run)) return false

  const propios = trabajos.filter(esTrabajoDeRevision)
  if (propios.length === 0) return false

  if (propios.some((t) => t.status === 'queued')) return false

  const corriendo = propios.filter((t) => t.status === 'running')
  if (corriendo.length > 0) return corriendo.every((t) => trabajoSinLatido(t, ahoraMs))

  // Todos terminaron y la corrida sigue abierta. La barrida del servidor la
  // cierra sola enseguida; hablamos solo si ese plazo ya pasó.
  const ultimoToque = propios.reduce((maximo, t) => {
    const ms = Date.parse(t.updatedAt)
    return Number.isFinite(ms) && ms > maximo ? ms : maximo
  }, Number.NEGATIVE_INFINITY)

  // Sin una sola fecha legible no sabemos cuánto hace que terminaron. Callarse
  // es lo único honesto.
  if (!Number.isFinite(ultimoToque)) return false
  return ahoraMs - ultimoToque > GRACIA_CIERRE_MS
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
  /**
   * La base todavía dice "corriendo", pero dejamos de saber de ella: el
   * trabajo que la sostenía dejó de latir. A diferencia de `fallada`, acá el
   * motor no avisó nada — por eso no hay `motivo` que mostrar.
   */
  | { fase: 'abandonada'; run: RunView }
  /**
   * Se cortó o ni arrancó.
   *
   * `motivo` **no** es lo que dijo el motor tal cual: pasa antes por
   * `traducirErrorTecnico()`. El texto crudo —un error de Postgres, una traza
   * de Node— queda en `motivo.detalle` para mostrarlo plegado, nunca como el
   * texto principal. Es la regla dura de cero jerga en pantalla: el tipo mismo
   * hace que renderizar el crudo sea un acto deliberado y no un descuido.
   */
  | { fase: 'fallada'; motivo: ErrorLegible | null }
  /** Terminó. Recién acá tiene sentido hablar de lo que se encontró. */
  | { fase: 'lista'; run: RunView }

export function estadoDeRevision(
  run: RunView | null,
  trabajos: readonly JobView[] = [],
  ahoraMs: number = Date.now(),
): EstadoDeRevision {
  // Más reciente primero. El último trabajo manda: un reintento pisa al fallo
  // anterior, no al revés.
  const propios = [...trabajos]
    .filter(esTrabajoDeRevision)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  if (run) {
    if (estaCorriendo(run)) {
      return corridaAbandonada(run, trabajos, ahoraMs)
        ? { fase: 'abandonada', run }
        : { fase: 'corriendo', run }
    }
    if (seCorto(run)) return { fase: 'fallada', motivo: motivoDelCorte(run, propios) }
    // Terminada (`succeeded` o `partial`). Si después falló un trabajo suelto
    // —el video de un hallazgo, por ejemplo— la revisión sigue siendo válida y
    // lo encontrado no se tapa con un cartel de error.
    return { fase: 'lista', run }
  }

  const ultimo = propios[0]
  if (!ultimo) return { fase: 'sin-revisar' }
  if (ultimo.status === 'failed') {
    return { fase: 'fallada', motivo: traducirErrorTecnico(ultimo.lastError) }
  }
  if (propios.some((t) => t.status === 'queued' || t.status === 'running')) {
    return { fase: 'en-cola' }
  }

  // Trabajos terminados y ninguna corrida: no hay nada en marcha ni nada que
  // mostrar. Ofrecer empezar de nuevo es lo único cierto que podemos decir.
  return { fase: 'sin-revisar' }
}

/**
 * Por qué se cortó, ya en criollo.
 *
 * Antes esto devolvía el texto del motor tal cual y terminaba impreso en la
 * pantalla: al usuario le podía llegar un error crudo de Postgres, que no le
 * dice nada y encima lo asusta. Ahora sale traducido, con el original
 * disponible pero plegado (ver `traducirErrorTecnico`).
 */
function motivoDelCorte(run: RunView, trabajos: readonly JobView[]): ErrorLegible | null {
  const crudo =
    run.error?.trim() ||
    trabajos.find((t) => t.status === 'failed' && t.lastError?.trim())?.lastError ||
    null
  return traducirErrorTecnico(crudo)
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

/** `HH:MM:SS.mmm`, que es el único formato de tiempo que acepta WebVTT. */
function tiempoVtt(seconds: number): string {
  const total = Math.max(0, Math.round((Number.isFinite(seconds) ? seconds : 0) * 1000))
  const dos = (n: number) => String(n).padStart(2, '0')
  const h = Math.floor(total / 3_600_000)
  const m = Math.floor((total % 3_600_000) / 60_000)
  const s = Math.floor((total % 60_000) / 1000)
  return `${dos(h)}:${dos(m)}:${dos(s)}.${String(total % 1000).padStart(3, '0')}`
}

/**
 * Los mismos subtítulos, pero como pista WebVTT de verdad.
 *
 * El reproductor los dibuja él mismo para que se vean igual en los dos temas,
 * y eso alcanzaba para quien mira la pantalla. No alcanza para el resto: sin
 * una pista `<track>` real, el navegador y el lector de pantalla no tienen
 * forma de saber que este video **tiene** subtítulos, ni de ofrecerlos donde
 * nuestra capa no llega (pantalla completa nativa, picture-in-picture, el
 * reproductor propio de iOS). El dato ya estaba; lo que faltaba era publicarlo
 * en el formato que el navegador entiende.
 *
 * Se saltean los cues vacíos y los de duración cero: un cue mal formado hace
 * que el navegador descarte el archivo entero, y perder todos los subtítulos
 * por una escena rota sería peor que no tener esa escena.
 */
export function construirVtt(cues: readonly Cue[]): string {
  const cuerpo = cues
    .map((c) => ({ ...c, caption: c.caption.replace(/\s+/g, ' ').trim() }))
    .filter((c) => c.caption.length > 0 && c.endSeconds > c.startSeconds)
    .map(
      (c, i) =>
        `${i + 1}\n${tiempoVtt(c.startSeconds)} --> ${tiempoVtt(c.endSeconds)}\n${c.caption}`,
    )
    .join('\n\n')

  return cuerpo ? `WEBVTT\n\n${cuerpo}\n` : 'WEBVTT\n'
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
