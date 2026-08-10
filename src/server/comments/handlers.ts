/**
 * Handler del trabajo `scan_comments`: revisa los comentarios del código y
 * deja el resultado guardado en `comment_scans`, para que otras pantallas lo
 * puedan mostrar después sin tener que volver a escanear el proyecto entero.
 *
 * Dos etapas, las dos reanudables:
 *
 *   1. revisar el proyecto y guardar lo que se encontró
 *   2. dejar registrado un resumen legible de lo que pasó
 *
 * ## Por qué la revisión y el guardado van en la misma etapa
 *
 * El resultado completo (`hits`) puede tener miles de filas — dogfoguendo
 * sobre este mismo repo encontró 1.951. Eso no entra en el resultado de una
 * etapa (el límite son 32 KB, ver `jobs/stages.ts`), así que no se puede
 * "revisar" en una etapa y "guardar" en la siguiente: a la etapa de guardado
 * no le llegaría de dónde sacar los datos. Por eso van juntas, igual que
 * `run_checks` combina revisar y guardar por la misma razón.
 *
 * ## Idempotencia
 *
 * Borrar-y-reinsertar por (`project_id`, `analysis_run_id`) — la regla que
 * fijó el frente de la cola en `jobs/registry.ts`. Correr esto dos veces deja
 * UNA fila en `comment_scans`, no dos. `analysis_run_id` puede ser nulo (esta
 * revisión no siempre está atada a una auditoría completa), y ahí Postgrest
 * necesita `.is()` en vez de `.eq()` — ver `borrarPorClave` más abajo.
 *
 * ## Defensa contra el bug que ya pasó una vez
 *
 * El motor llegó a colgarse hasta agotar memoria escaneando este mismo repo
 * (bug cuadrático del lector de código al toparse con `<` en JSX, ya
 * arreglado — ver `docs/PROGRESS.md`). Ya no debería volver a pasar, pero
 * este handler no confía a ciegas: le pone un tiempo máximo a la revisión
 * entera (bien por debajo de lo que dura el permiso del trabajo, para no
 * competir con eso) y, si el resultado trae una cantidad de comentarios fuera
 * de lo razonable, guarda igual el resumen —esos números son reales— pero
 * recorta la lista detallada antes de guardarla, y lo deja dicho.
 */

import { existsSync, statSync } from 'node:fs'

import type { CommentHit, CommentScanResult, CostEntry } from '@/lib/types/domain'
import { registerHandler, runStages } from '@/server/jobs'
import type { JobContext, JobHandler, StageStore } from '@/server/jobs'
import { describeDbError, jobsDb, type JobsDb } from '@/server/jobs/db'
import { JobError } from '@/server/jobs/errors'
import { T } from '@/lib/db/tablas'

import { scanProject } from './index'

/* ── Lo que llega en el trabajo ───────────────────────────────────────── */

export interface ScanCommentsPayload {
  /** Carpeta donde está el código a revisar. */
  repoPath: string
}

/* ── Inyección de dependencias ────────────────────────────────────────── */

export interface DependenciasScanComments {
  db?: () => Promise<JobsDb>
  store?: StageStore
  /** El motor. Se inyecta en los tests para no depender de un repo real en disco. */
  escanear?: (repoPath: string) => Promise<CommentScanResult>
  /** Tiempo máximo de la revisión. Se acorta en los tests. */
  tiempoMaximoMs?: number
}

/* ── Topes: defensa en profundidad, no confiamos en que el motor no se cuelgue ── */

/** Más filas que esto en `comment_scans.hits` es un texto que no le sirve a nadie leer entero. */
export const MAX_HITS_GUARDADOS = 20_000

/**
 * Si la revisión entera tarda más que esto, se corta y se avisa.
 *
 * A propósito bien por debajo de `DEFAULT_LEASE_SECONDS` (300 s, ver
 * `jobs/queue.ts`): `runStages` renueva el permiso del trabajo recién AL
 * EMPEZAR esta etapa, y adentro no hay otro latido hasta que termine. Si este
 * tope estuviera cerca de los 300 s, una revisión lenta pero legítima podría
 * perder el permiso a mitad de camino y otro trabajador se llevaría el mismo
 * trabajo por delante.
 */
export const TIEMPO_MAXIMO_ESCANEO_MS = 2 * 60 * 1000

/* ── Etapas: el texto lo lee el usuario ───────────────────────────────── */

const ETAPAS = {
  revisar: 'Revisando los comentarios de tu código',
  cerrar: 'Anotando lo que encontramos',
} as const

/* ── Handler ──────────────────────────────────────────────────────────── */

export function crearHandlerScanComments(
  deps: DependenciasScanComments = {},
): JobHandler<ScanCommentsPayload> {
  return async (payload, ctx) => {
    const abrirDb = deps.db ?? jobsDb
    const projectId = exigirProyecto(ctx)
    const repoPath = exigirRepoPath(payload)

    await runStages(
      ctx,
      [
        {
          name: 'revisar_y_guardar',
          label: ETAPAS.revisar,
          progress: 90,
          run: async () => {
            verificarQueElCodigoExiste(repoPath)

            const escanear = deps.escanear ?? scanProject
            const resultado = await conTiempoLimite(
              escanear(repoPath),
              deps.tiempoMaximoMs ?? TIEMPO_MAXIMO_ESCANEO_MS,
            )

            const db = await abrirDb()
            const { hits: aGuardar, recortados } = recortarHits(resultado.hits)

            await borrarEscaneoPrevio(db, projectId, ctx.analysisRunId)
            const scanId = await insertarEscaneo(db, projectId, ctx.analysisRunId, resultado, aGuardar)

            if (recortados > 0) {
              ctx.log(
                `Encontramos ${resultado.hits.length.toLocaleString('es-AR')} comentarios y guardamos el detalle ` +
                  `de los primeros ${MAX_HITS_GUARDADOS.toLocaleString('es-AR')}. Los números de arriba cuentan ` +
                  'el total real, no solo lo guardado.',
              )
            }

            const resumen = resumenDe(scanId, resultado, aGuardar.length)
            await reportarCosto(ctx, resumen)
            return resumen
          },
        },
        {
          name: 'dejar_registro',
          label: ETAPAS.cerrar,
          progress: 100,
          run: async (helper) => {
            const resumen = helper.get<ResumenGuardado>('revisar_y_guardar')
            if (!resumen) return { anotado: false }

            ctx.log(
              `Revisamos ${resumen.scannedFiles.toLocaleString('es-AR')} archivo(s) y encontramos ` +
                `${resumen.hitsEncontrados.toLocaleString('es-AR')} comentario(s). ` +
                `${resumen.exposedCount.toLocaleString('es-AR')} de esos llegan al navegador de quien visita tu app.`,
            )
            return { anotado: true }
          },
        },
      ],
      deps.store ? { store: deps.store } : {},
    )
  }
}

/* ── Validación de entrada ────────────────────────────────────────────── */

function exigirProyecto(ctx: JobContext): string {
  if (!ctx.projectId) {
    throw new JobError('El trabajo de revisión de comentarios llegó sin proyecto asociado.', {
      retryable: false,
      code: 'sin_proyecto',
    })
  }
  return ctx.projectId
}

function exigirRepoPath(payload: ScanCommentsPayload): string {
  const repoPath = payload?.repoPath?.trim()
  if (!repoPath) {
    throw new JobError('El trabajo de revisión de comentarios llegó sin decir dónde está el código.', {
      retryable: false,
      code: 'sin_repo_path',
    })
  }
  return repoPath
}

/**
 * El motor recorre el disco en silencio: si la carpeta no existe, devuelve
 * "cero comentarios" en vez de fallar, que sería mentirle al usuario ("tu
 * código está limpio" cuando en realidad nunca lo miramos). Por eso el
 * handler comprueba esto antes de llamarlo.
 *
 * No es reintentable: si el código no está en esta carpeta ahora, correr el
 * mismo trabajo de nuevo con el mismo dato no lo va a hacer aparecer.
 */
function verificarQueElCodigoExiste(repoPath: string): void {
  const existe = existsSync(repoPath) && statSync(repoPath).isDirectory()
  if (!existe) {
    throw new JobError(
      'No encontramos el código de tu proyecto para revisar los comentarios. Puede que todavía no se haya ' +
        'terminado de traer, o que se haya borrado mientras tanto.',
      { retryable: false, code: 'codigo_no_encontrado' },
    )
  }
}

/* ── Tiempo máximo ─────────────────────────────────────────────────────── */

function conTiempoLimite<T>(promesa: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const temporizador = setTimeout(() => {
      reject(
        new JobError(
          'La revisión de comentarios está tardando demasiado y la cortamos para no colgar el trabajo. ' +
            'Puede que el proyecto sea muy grande para revisarlo de una sola vez.',
          { retryable: false, code: 'escaneo_demasiado_lento' },
        ),
      )
    }, ms)
    // Corre en el trabajador (Node), no en el navegador: sin esto, un
    // temporizador vivo mantendría el proceso despierto de más.
    temporizador.unref?.()

    promesa.then(
      (valor) => {
        clearTimeout(temporizador)
        resolve(valor)
      },
      (error: unknown) => {
        clearTimeout(temporizador)
        reject(error)
      },
    )
  })
}

/* ── Tope de tamaño ────────────────────────────────────────────────────── */

function recortarHits(hits: CommentHit[]): { hits: CommentHit[]; recortados: number } {
  if (hits.length <= MAX_HITS_GUARDADOS) return { hits, recortados: 0 }
  return { hits: hits.slice(0, MAX_HITS_GUARDADOS), recortados: hits.length - MAX_HITS_GUARDADOS }
}

/* ── Guardado ──────────────────────────────────────────────────────────── */

/**
 * Filtro por la clave natural (`project_id`, `analysis_run_id`).
 *
 * Postgrest no entiende `.eq(columna, null)` como "está vacío" (compara con
 * el valor `null`, que en SQL nunca es igual a nada, ni siquiera a otro
 * `null`): hace falta `.is()`. El cliente real siempre lo tiene. Si algún
 * doble de test no lo implementa, cae a `.eq()`, que en una base en memoria
 * compara por igualdad estricta y alcanza para probar la lógica del handler.
 */
function borrarPorClave(db: JobsDb, projectId: string, analysisRunId: string | null): PromiseLike<unknown> {
  const query = db.from(T.commentScans).delete().eq('project_id', projectId)
  if (analysisRunId === null) {
    return typeof query.is === 'function' ? query.is('analysis_run_id', null) : query.eq('analysis_run_id', null)
  }
  return query.eq('analysis_run_id', analysisRunId)
}

async function borrarEscaneoPrevio(
  db: JobsDb,
  projectId: string,
  analysisRunId: string | null,
): Promise<void> {
  const { error } = (await borrarPorClave(db, projectId, analysisRunId)) as {
    error: { message?: string } | null
  }
  if (error) {
    throw new JobError(`No pudimos limpiar la revisión anterior de comentarios: ${describeDbError(error)}`, {
      retryable: true,
      code: 'limpieza_fallida',
    })
  }
}

async function insertarEscaneo(
  db: JobsDb,
  projectId: string,
  analysisRunId: string | null,
  resultado: CommentScanResult,
  hits: CommentHit[],
): Promise<string> {
  const { data, error } = await db
    .from(T.commentScans)
    .insert({
      project_id: projectId,
      analysis_run_id: analysisRunId,
      scanned_files: resultado.scannedFiles,
      exposed_count: resultado.exposedCount,
      risky_count: resultado.riskyCount,
      removable_count: resultado.removableCount,
      hits,
    })
    .select('id')
    .single()

  if (error || !data) {
    throw new JobError(`No pudimos guardar la revisión de comentarios: ${describeDbError(error)}`, {
      retryable: true,
      code: 'guardado_fallido',
    })
  }
  return String((data as Record<string, unknown>).id)
}

/* ── Resumen y costo ───────────────────────────────────────────────────── */

interface ResumenGuardado {
  scanId: string
  scannedFiles: number
  hitsEncontrados: number
  hitsGuardados: number
  exposedCount: number
  riskyCount: number
  removableCount: number
}

function resumenDe(scanId: string, resultado: CommentScanResult, hitsGuardados: number): ResumenGuardado {
  return {
    scanId,
    scannedFiles: resultado.scannedFiles,
    hitsEncontrados: resultado.hits.length,
    hitsGuardados,
    exposedCount: resultado.exposedCount,
    riskyCount: resultado.riskyCount,
    removableCount: resultado.removableCount,
  }
}

/**
 * Costo real, en unidades concretas — nunca "créditos". La lectura de
 * comentarios es análisis de código, no un modelo de lenguaje, así que el
 * costo en dólares es cero; lo que importa es dejar registrado cuánto se
 * revisó.
 */
async function reportarCosto(ctx: JobContext, resumen: ResumenGuardado): Promise<void> {
  const entradas: CostEntry[] = [
    {
      category: 'llm',
      units: resumen.scannedFiles,
      unitLabel: 'archivos revisados',
      costUsd: 0,
      detail: 'Revisamos los comentarios de tu código. No usó modelo de lenguaje.',
    },
    {
      category: 'llm',
      units: resumen.hitsEncontrados,
      unitLabel: 'comentarios encontrados',
      costUsd: 0,
      detail: 'Comentarios clasificados por dónde llegan y qué tan riesgosos son.',
    },
  ]
  for (const entrada of entradas) await ctx.reportCost(entrada)
}

/* ── Enganche ─────────────────────────────────────────────────────────── */

registerHandler('scan_comments', crearHandlerScanComments())
