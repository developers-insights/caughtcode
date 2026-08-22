/**
 * Barrido del código que quedó tirado en el disco de ESTE proceso.
 *
 * ## Por qué hace falta si `reconcileRunStatus()` ya borra
 *
 * Cuando una corrida cierra, `reconcileRunStatus()` borra su carpeta
 * (`<raíz>/<projectId>/<runId>/`). Eso alcanza mientras el proceso que cierra la
 * corrida sea el mismo que bajó el código. **No siempre lo es**: el trabajo
 * pesado corre en el worker largo (Railway, disco montado en
 * `CAUGHTCODE_STORAGE_DIR`) y la corrida la puede cerrar el tick de Vercel —otra
 * máquina, otro disco—. Ese `rm` corre sobre el disco equivocado y la carpeta
 * del worker se queda ahí. Con un proceso que vive días, eso es disco pago
 * creciendo sin tope, y encima es código de clientes que no tenemos por qué
 * retener.
 *
 * Hay dos fugas más que el borrado por corrida no puede cubrir por diseño:
 *
 * - una corrida que **nunca cierra** (se borró el proyecto, se canceló a mano,
 *   la fila desapareció) no dispara ningún borrado;
 * - `createWorkspace(nanoid(), 'onboarding')` deja carpetas que no tienen fila
 *   en ninguna tabla, y si el request se cortó a la mitad no las borra nadie.
 *
 * ## La regla: no se borra sin evidencia de que ya nadie lo necesita
 *
 * Una carpeta se borra solo si pasa **las tres**:
 *
 * 1. Nadie la tocó hace `EDAD_MINIMA_MS`. Es un piso que no depende de la base:
 *    entre que un handler escribe y su fila se actualiza pasan segundos, y en
 *    esos segundos el código está vivo.
 * 2. Su corrida no está `running`.
 * 3. Ningún trabajo de esa corrida está `queued` ni `running` —de cualquier
 *    tipo, no solo los de revisión: `scan_comments` también lee
 *    `payload.repoPath` y la corrida puede haber cerrado con él en vuelo.
 *
 * Si la base no contesta, **no se borra nada**. Un barrido a ciegas sobre el
 * disco de otro es exactamente lo que no queremos.
 *
 * ## Qué NO toca
 *
 * Solo el código bajado. Los hallazgos, el índice y el costo viven en Postgres;
 * las grabaciones y los videos, en los buckets de Storage; el agente y el render
 * trabajan en `os.tmpdir()`, no acá. Nada de eso pasa por este archivo.
 *
 * Y solo borra carpetas cuyo nombre escribimos nosotros (`esSegmentoSeguro`):
 * si alguien montó otra cosa bajo la misma raíz, no es nuestra y no se toca.
 */

import { readdir, rmdir, stat } from 'node:fs/promises'
import path from 'node:path'

import type { JobStatus } from '@/lib/types/domain'
import type { DeletionReceipt } from '@/server/ingest/retention'
import { T } from '@/lib/db/tablas'
import { env } from '@/lib/env'
import { describeDbError, jobsDb } from './db'
import { describeError } from './errors'

/**
 * Cuánto tiene que hacer que nadie toca una carpeta para siquiera mirarla.
 *
 * Seis horas es dos órdenes de magnitud más que la corrida más larga que
 * medimos (minutos), y más que cualquier cadena de reintentos con backoff
 * (techo de 15 minutos por intento, 3 intentos).
 */
export const EDAD_MINIMA_MS = 6 * 60 * 60_000

/** Cada cuánto barre un proceso, como mucho. Es tarea de fondo, no del trabajo. */
export const INTERVALO_ENTRE_BARRIDAS_MS = 60 * 60_000

/** Tope de carpetas por pasada: un disco muy sucio no puede comerse la tanda. */
const MAX_CARPETAS_POR_BARRIDA = 200

/** Trabajos que todavía pueden necesitar el código. */
const EN_VUELO: readonly JobStatus[] = ['queued', 'running']

export interface OpcionesLimpieza {
  now?: Date
  /** Piso de antigüedad. Por defecto `EDAD_MINIMA_MS`. */
  edadMinimaMs?: number
  limite?: number
}

export interface InformeLimpieza {
  /** Carpetas de corrida que hay en este disco. */
  encontradas: number
  /** De esas, cuántas se dejaron en paz (recientes, o con algo en vuelo). */
  protegidas: number
  /** Comprobante por cada borrado: qué ruta, cuánto liberó y si se verificó. */
  borradas: DeletionReceipt[]
  bytesLiberados: number
  /** Rutas que siguieron en disco pese al intento. Hay que mirarlas. */
  fallidas: string[]
  /** Por qué no se hizo nada, cuando corresponde. */
  motivo?: 'sin_raiz' | 'sin_evidencia'
}

interface Candidata {
  projectDir: string
  runDir: string
  ruta: string
}

const INFORME_VACIO: InformeLimpieza = {
  encontradas: 0,
  protegidas: 0,
  borradas: [],
  bytesLiberados: 0,
  fallidas: [],
}

/**
 * Barre el disco de este proceso. **Nunca tira**: es mantenimiento, no puede
 * tumbar un trabajo que ya terminó.
 *
 * Los imports de `workspace` y `retention` son tardíos a propósito: los dos
 * arrancan con `import 'server-only'`, y así este módulo sigue siendo importable
 * desde cualquier lado.
 */
export async function barrerCodigoHuerfano(
  options: OpcionesLimpieza = {},
): Promise<InformeLimpieza> {
  const ahora = (options.now ?? new Date()).getTime()
  // Piso de un minuto: una edad de cero convertiría esto en "borrá todo lo que
  // haya en disco", que es justo lo contrario de lo que hace falta.
  const edadMinima = Math.max(60_000, options.edadMinimaMs ?? EDAD_MINIMA_MS)
  const limite = Math.max(1, options.limite ?? MAX_CARPETAS_POR_BARRIDA)

  const { storageRoot, esSegmentoSeguro } = await import('@/server/ingest/workspace')
  const raiz = storageRoot()

  const proyectos = await subcarpetas(raiz)
  if (proyectos === null) return { ...INFORME_VACIO, motivo: 'sin_raiz' }

  const candidatas: Candidata[] = []
  let encontradas = 0
  let protegidas = 0

  for (const projectDir of proyectos) {
    if (!esSegmentoSeguro(projectDir)) continue
    const rutaProyecto = path.join(raiz, projectDir)
    const corridas = await subcarpetas(rutaProyecto)
    if (corridas === null) continue

    for (const runDir of corridas) {
      if (!esSegmentoSeguro(runDir)) continue
      const ruta = path.join(rutaProyecto, runDir)
      encontradas += 1

      let info
      try {
        info = await stat(ruta)
      } catch {
        continue
      }
      if (ahora - info.mtimeMs < edadMinima) {
        protegidas += 1
        continue
      }
      if (candidatas.length < limite) candidatas.push({ projectDir, runDir, ruta })
    }
  }

  if (candidatas.length === 0) {
    await borrarProyectosVacios(raiz, proyectos)
    return { ...INFORME_VACIO, encontradas, protegidas }
  }

  let vivas: Set<string>
  try {
    vivas = await corridasQueSiguenVivas(candidatas.map((candidata) => candidata.runDir))
  } catch (error) {
    console.warn(
      '[jobs] no se pudo saber qué corridas siguen vivas, así que no se borró nada del disco: ' +
        describeError(error),
    )
    return {
      ...INFORME_VACIO,
      encontradas,
      protegidas: protegidas + candidatas.length,
      motivo: 'sin_evidencia',
    }
  }

  const { deleteRunCode } = await import('@/server/ingest/retention')
  const borradas: DeletionReceipt[] = []
  const fallidas: string[] = []

  for (const candidata of candidatas) {
    if (vivas.has(candidata.runDir)) {
      protegidas += 1
      continue
    }
    try {
      const comprobante = await deleteRunCode(candidata.projectDir, candidata.runDir)
      if (comprobante.existedBefore) borradas.push(comprobante)
      if (!comprobante.verified) fallidas.push(comprobante.path)
    } catch (error) {
      fallidas.push(candidata.ruta)
      console.error(`[jobs] no se pudo borrar ${candidata.ruta}: ${describeError(error)}`)
    }
  }

  await borrarProyectosVacios(raiz, proyectos)

  return {
    encontradas,
    protegidas,
    borradas,
    bytesLiberados: borradas.reduce((suma, comprobante) => suma + comprobante.bytesFreed, 0),
    fallidas,
  }
}

/* ── El que llama el worker ──────────────────────────────────────────── */

let ultimaBarrida = 0

/** Solo para tests: olvida cuándo fue la última barrida. */
export function reiniciarRelojDeLimpieza(): void {
  ultimaBarrida = 0
}

/**
 * Barre como mucho una vez por hora, y solo donde hay un disco propio que
 * cuidar.
 *
 * Sin `CAUGHTCODE_STORAGE_DIR` no se mira el disco siquiera: ese es el caso de
 * Vercel (`/tmp` se muere con la invocación) y el de la máquina de desarrollo,
 * donde la raíz por defecto cuelga del repo y no es nuestra para barrer.
 *
 * Devuelve `null` cuando no le tocaba. Nunca tira.
 */
export async function barrerCodigoHuerfanoSiToca(
  options: OpcionesLimpieza = {},
): Promise<InformeLimpieza | null> {
  if (!env.storageDir()) return null

  const ahora = (options.now ?? new Date()).getTime()
  if (ultimaBarrida !== 0 && ahora - ultimaBarrida < INTERVALO_ENTRE_BARRIDAS_MS) return null
  ultimaBarrida = ahora

  try {
    return await barrerCodigoHuerfano(options)
  } catch (error) {
    console.error(`[jobs] falló la limpieza de disco: ${describeError(error)}`)
    return null
  }
}

/* ── Piezas ──────────────────────────────────────────────────────────── */

/** Subcarpetas de `target`, o `null` si no se puede leer. */
async function subcarpetas(target: string): Promise<string[] | null> {
  try {
    return (await readdir(target, { withFileTypes: true }))
      .filter((entrada) => entrada.isDirectory())
      .map((entrada) => entrada.name)
  } catch {
    return null
  }
}

/**
 * Qué corridas de esta lista todavía pueden necesitar su código.
 *
 * Dos consultas fijas, no una por carpeta. Tira si alguna falla: quien llama
 * traduce eso en "no borro nada".
 */
async function corridasQueSiguenVivas(ids: string[]): Promise<Set<string>> {
  const unicos = [...new Set(ids)]
  const vivas = new Set<string>()
  const db = await jobsDb()

  const { data: corridas, error: errorCorridas } = await db
    .from(T.analysisRuns)
    .select('id')
    .in('id', unicos)
    .eq('status', 'running')

  if (errorCorridas) {
    throw new Error(`No se pudo listar las auditorías abiertas: ${describeDbError(errorCorridas)}`)
  }
  for (const fila of (corridas ?? []) as Array<Record<string, any>>) {
    if (typeof fila?.id === 'string') vivas.add(fila.id)
  }

  const { data: trabajos, error: errorTrabajos } = await db
    .from(T.jobs)
    .select('analysis_run_id')
    .in('analysis_run_id', unicos)
    .in('status', [...EN_VUELO])

  if (errorTrabajos) {
    throw new Error(
      `No se pudo saber qué trabajos siguen en vuelo: ${describeDbError(errorTrabajos)}`,
    )
  }
  for (const fila of (trabajos ?? []) as Array<Record<string, any>>) {
    const id = fila?.analysis_run_id
    if (typeof id === 'string' && id.length > 0) vivas.add(id)
  }

  return vivas
}

/** Deja la raíz sin carpetas de proyecto que ya no tienen nada adentro. */
async function borrarProyectosVacios(raiz: string, proyectos: string[]): Promise<void> {
  for (const projectDir of proyectos) {
    const ruta = path.join(raiz, projectDir)
    try {
      const contenido = await readdir(ruta)
      if (contenido.length === 0) await rmdir(ruta)
    } catch {
      // Ya no está, o le entró algo entre el listado y el borrado. En los dos
      // casos no hay nada que hacer y no es un problema.
    }
  }
}
