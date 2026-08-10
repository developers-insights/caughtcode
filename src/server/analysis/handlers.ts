/**
 * Handler del trabajo `index_code`: enchufa el motor de análisis a la cola.
 *
 * El motor (`buildCodeIndex`) hace casi todo el trabajo pesado y ya sabe
 * reanudarse por dentro (`IndexStages` + `resumeFrom`). Este handler es la capa
 * fina que falta: lo llama, guarda el resultado, y encadena el siguiente paso.
 *
 * ## El índice va a su tabla, al payload va un recibo
 *
 * `runStages` guarda el resultado de cada etapa en `jobs.payload` para poder
 * reanudar, y por eso tiene un tope de tamaño. El `CodeIndex` no entra ni cerca:
 * en un repo real de 406 archivos son 323 KB, y crece con el proyecto. Antes la
 * etapa `analizar` devolvía el índice entero y la siguiente lo guardaba — o sea
 * que el trabajo fallaba **siempre** en cuanto el repo dejaba de ser de
 * juguete, y con él se caía el pipeline completo (sin índice no hay chequeos,
 * sin chequeos no hay hallazgos ni videos).
 *
 * Ahora `analizar` escribe el índice en su tabla (`T.codeIndex`) y devuelve un
 * recibo de unos pocos bytes: el id de la fila y cuatro números. Es el mismo
 * contrato que ya usa `run_checks`, que lee el índice de esa tabla y nunca del
 * payload (ver `leerCodeIndex()` en `src/server/checks/handlers.ts`).
 *
 * **Regla para quien toque este archivo:** de una etapa sale un identificador y
 * un resumen, jamás una estructura que crezca con el tamaño del repo.
 *
 * ## Reanudación: qué se rehace y qué no
 *
 * Guardar el índice quedó *dentro* de `analizar`, no en una etapa aparte. Si la
 * escritura falla, el reintento rehace también el análisis. Es barato de
 * aceptar: escribir una fila son milisegundos contra minutos de análisis, y de
 * todas formas `buildCodeIndex` sabe reanudar sus etapas internas solo dentro de
 * **una** corrida (`IndexStages` no se persiste entre reintentos del trabajo).
 * La alternativa —dejar el índice en el payload para no recalcularlo— es
 * exactamente el bug que esto arregla.
 *
 * ## Idempotencia
 *
 * Mismo criterio que `run_checks`: borrar-y-reinsertar por `analysis_run_id`.
 * Solo puede existir **un** `code_index` por corrida.
 *
 * ## Encadenado
 *
 * Al terminar, encola `run_checks` siempre, y `run_browser_agent` si el
 * proyecto tiene una URL publicada — son independientes entre sí, no hace
 * falta esperar a que uno termine para arrancar el otro.
 */

import { buildCodeIndex, type BuildIndexOptions } from './index'
import type { CodeIndex, StackInfo } from '@/lib/types/domain'
import { enqueue, registerHandler, runStages } from '@/server/jobs'
import type { JobContext, JobHandler, StageStore } from '@/server/jobs'
import { describeDbError, jobsDb, type JobsDb } from '@/server/jobs/db'
import { JobError } from '@/server/jobs/errors'
import { T } from '@/lib/db/tablas'

/* ── Lo que llega en el trabajo ───────────────────────────────────────── */

export interface IndexCodePayload {
  /** Carpeta donde `ingest_repo` dejó el código. */
  repoPath: string
  /** Dirección de la app publicada, si el usuario la dio. Viaja al siguiente job. */
  deployedUrl?: string | null
  /** Conexión de solo lectura a la base del usuario, si la conectó. */
  databaseUrl?: string | null
}

/* ── Inyección de dependencias ────────────────────────────────────────── */

export interface DependenciasIndexCode {
  db?: () => Promise<JobsDb>
  build?: (options: BuildIndexOptions) => ReturnType<typeof buildCodeIndex>
  /** Solo para tests: reemplaza el almacén de etapas que vive en `jobs.payload`. */
  store?: StageStore
}

const ETAPAS = {
  analizar: 'Leyendo tu código',
  encadenar: 'Preparando la revisión',
} as const

/**
 * Lo único que la etapa `analizar` deja en `jobs.payload`. Todo acá adentro es
 * de tamaño fijo a propósito: no puede tener listas ni objetos que crezcan con
 * el repo. El mapa completo vive en `T.codeIndex`.
 */
export interface ReciboDelIndice {
  /** Fila de `T.codeIndex` recién escrita. `null` si la base no la devolvió. */
  codeIndexId: string | null
  archivos: number
  rutas: number
  simbolos: number
  /** `true` si el repo era tan grande que hubo que quedarse con lo más relevante. */
  recortado: boolean
}

/* ── Handler ──────────────────────────────────────────────────────────── */

export function crearHandlerIndexCode(
  deps: DependenciasIndexCode = {},
): JobHandler<IndexCodePayload> {
  return async (payload, ctx) => {
    const abrirDb = deps.db ?? jobsDb
    const build = deps.build ?? buildCodeIndex
    const analysisRunId = exigirCorrida(ctx)

    await runStages(
      ctx,
      [
      {
        name: 'analizar',
        label: ETAPAS.analizar,
        progress: 80,
        run: async (helper): Promise<ReciboDelIndice> => {
          const resultado = await build({
            root: payload.repoPath,
            databaseUrl: payload.databaseUrl ?? null,
            onProgress: async (_stage, pct) => {
              await helper.heartbeat(Math.round(pct * 0.8))
            },
          })

          // El índice se escribe acá mismo, no se devuelve: devolverlo revienta
          // el tope de `runStages` en cualquier repo real.
          const db = await abrirDb()
          const codeIndexId = await guardarIndice(db, analysisRunId, resultado.index)
          if (ctx.projectId) await guardarStack(db, ctx.projectId, resultado.stack)

          for (const nota of resultado.index.notes) ctx.log(nota)

          return {
            codeIndexId,
            archivos: resultado.index.fileCount,
            rutas: resultado.index.routes.length,
            simbolos: resultado.index.symbols.length,
            recortado: resultado.index.truncated,
          }
        },
      },
      {
        name: 'encadenar',
        label: ETAPAS.encadenar,
        progress: 100,
        run: async (helper) => {
          const recibo = helper.get<ReciboDelIndice>('analizar')
          if (!recibo) {
            throw new JobError('El análisis no dejó nada para guardar.', {
              retryable: false,
              code: 'analisis_vacio',
            })
          }

          await encolarSiguientes(ctx, payload)

          return { archivos: recibo.archivos, rutas: recibo.rutas, recortado: recibo.recortado }
        },
      },
      ],
      deps.store ? { store: deps.store } : {},
    )
  }
}

function exigirCorrida(ctx: JobContext): string {
  if (!ctx.analysisRunId) {
    throw new JobError('El trabajo de análisis llegó sin corrida asociada.', {
      retryable: false,
      code: 'sin_corrida',
    })
  }
  return ctx.analysisRunId
}

/* ── Guardado ─────────────────────────────────────────────────────────── */

/**
 * Borra el mapa anterior de esta corrida y escribe el nuevo. Devuelve el id de
 * la fila: es lo que viaja al payload del trabajo en lugar del índice entero.
 *
 * Las columnas son el contrato de lectura de `run_checks` (`leerCodeIndex()` en
 * `src/server/checks/handlers.ts`). Si cambian acá y no allá, la revisión se
 * queda sin datos sin que nada falle.
 */
async function guardarIndice(
  db: JobsDb,
  analysisRunId: string,
  index: CodeIndex,
): Promise<string | null> {
  const { error: borrarError } = await db.from(T.codeIndex).delete().eq('analysis_run_id', analysisRunId)
  if (borrarError) {
    throw new JobError(`No se pudo limpiar el mapa anterior: ${describeDbError(borrarError)}`, {
      retryable: true,
      code: 'limpieza_fallida',
    })
  }

  const { data, error } = await db.from(T.codeIndex).insert({
    analysis_run_id: analysisRunId,
    symbol_graph: { symbols: index.symbols, edges: index.edges },
    routes: index.routes,
    ranked_files: index.rankedFiles,
    db_schema: index.dbSchema,
    stats: {
      fileCount: index.fileCount,
      totalBytes: index.totalBytes,
      languages: index.languages,
      truncated: index.truncated,
      notes: index.notes,
    },
  })
    .select('id')
    .single()

  if (error) {
    throw new JobError(`No se pudo guardar el mapa del proyecto: ${describeDbError(error)}`, {
      retryable: true,
      code: 'guardado_fallido',
    })
  }

  // Si la fila entró pero la base no devolvió el id, no es motivo para fallar:
  // lo que importa ya está escrito y `run_checks` lo busca por corrida, no por id.
  const id = (data as { id?: unknown } | null)?.id
  return typeof id === 'string' ? id : null
}

async function guardarStack(db: JobsDb, projectId: string, stack: StackInfo): Promise<void> {
  // No es crítico: si falla, la corrida sigue. El stack ya se detectó una vez
  // en la ingesta; esto solo lo refina con lo que vio el análisis completo.
  await db.from(T.projects).update({ stack_detected: stack }).eq('id', projectId)
}

/* ── Encadenado ───────────────────────────────────────────────────────── */

/**
 * Encadena el paso siguiente. **En serie cuando hay app publicada**, no en paralelo.
 *
 * Antes esto encolaba `run_checks` y `run_browser_agent` a la vez, con el
 * argumento de que son independientes. No lo son: los chequeos de cookies, de
 * rastreadores, de flujos que faltan y de pantalla en el celular leen lo que vio
 * el agente. Corriendo a la par, la revisión ganaba la carrera, no encontraba
 * nada de eso, y se salteaba justo los chequeos que el producto promete — sin
 * que nadie se enterara, porque un chequeo salteado no falla: no aparece.
 *
 * Entonces:
 *   - con app publicada: `run_browser_agent`, y **él** encola `run_checks` con la
 *     evidencia adentro (ver `src/server/agent/handlers.ts`);
 *   - sin app publicada: `run_checks` directo, que es todo lo que se puede hacer.
 *
 * El costo de serializar es que la revisión arranca unos minutos más tarde. Lo
 * paga el handler del agente, que encola la revisión **aunque la prueba falle**:
 * si el navegador no abre, el usuario recibe igual la revisión de su código.
 */
async function encolarSiguientes(ctx: JobContext, payload: IndexCodePayload): Promise<void> {
  if (!ctx.projectId) return

  const comun = {
    orgId: ctx.orgId,
    projectId: ctx.projectId,
    analysisRunId: ctx.analysisRunId,
  }

  if (payload.deployedUrl) {
    await enqueue({
      ...comun,
      kind: 'run_browser_agent',
      // `repoPath` y `databaseUrl` viajan porque el trabajo siguiente los necesita:
      // el agente no los usa, se los pasa a `run_checks` cuando lo encola.
      payload: {
        deployedUrl: payload.deployedUrl,
        repoPath: payload.repoPath,
        databaseUrl: payload.databaseUrl ?? null,
      },
    })
    return
  }

  await enqueue({
    ...comun,
    kind: 'run_checks',
    payload: {
      repoPath: payload.repoPath,
      deployedUrl: null,
      databaseUrl: payload.databaseUrl ?? null,
    },
  })
}

/* ── Enganche ─────────────────────────────────────────────────────────── */

registerHandler('index_code', crearHandlerIndexCode())
