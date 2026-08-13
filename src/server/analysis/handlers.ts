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
 * Al terminar encola `run_checks` siempre. Si el proyecto tiene una URL
 * publicada, encola además `run_browser_agent` para ya y **difiere** la revisión
 * unos minutos: el agente la adelanta cuando termina, con la evidencia adentro,
 * y si el agente nunca corre la revisión se dispara sola. Ver
 * `encolarSiguientes()` acá abajo, que es donde está el razonamiento completo.
 */

import { buildCodeIndex, type BuildIndexOptions } from './index'
import type { CodeIndex, StackInfo } from '@/lib/types/domain'
import { leerConexionBase } from '@/server/ingest/conexion'
import { asegurarCodigoEnDisco } from '@/server/ingest/rehidratar'
import { encolarUnaVezPorCorrida, registerHandler, runStages } from '@/server/jobs'
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
  /**
   * @deprecated Solo para los trabajos que quedaron encolados con el secreto
   * adentro. La conexión ya no viaja en el payload —cualquier miembro de la
   * organización puede leer `jobs.payload`—: se resuelve acá con
   * `leerConexionBase()`. Ver `@/server/ingest/conexion`.
   */
  databaseUrl?: string | null
}

/* ── Inyección de dependencias ────────────────────────────────────────── */

export interface DependenciasIndexCode {
  db?: () => Promise<JobsDb>
  build?: (options: BuildIndexOptions) => ReturnType<typeof buildCodeIndex>
  /** Solo para tests: reemplaza el almacén de etapas que vive en `jobs.payload`. */
  store?: StageStore
  /** Cómo se garantiza que el código esté en disco. Se inyecta en los tests. */
  asegurar?: typeof asegurarCodigoEnDisco
  /** Cómo se resuelve la conexión a la base del usuario. Se inyecta en los tests. */
  conexion?: typeof leerConexionBase
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
    const asegurar = deps.asegurar ?? asegurarCodigoEnDisco
    const analysisRunId = exigirCorrida(ctx)

    await runStages(
      ctx,
      [
      {
        name: 'analizar',
        label: ETAPAS.analizar,
        progress: 80,
        run: async (helper): Promise<ReciboDelIndice> => {
          const root = await asegurarRoot(asegurar, payload, ctx, analysisRunId)

          // El secreto se resuelve acá y muere con el trabajo. `payload` solo se
          // mira por los trabajos que quedaron encolados antes del cambio.
          const databaseUrl =
            payload.databaseUrl ??
            (await (deps.conexion ?? leerConexionBase)({
              db: await abrirDb(),
              projectId: ctx.projectId,
              log: ctx.log,
            }))

          const resultado = await build({
            root,
            databaseUrl,
            onProgress: async (_stage, pct) => {
              await helper.heartbeat(Math.round(pct * 0.8))
            },
          })

          exigirIndiceConArchivos(resultado.index)

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

          await encolarSiguientes(ctx, payload, analysisRunId)

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

/* ── Que el código esté de verdad ─────────────────────────────────────── */

/**
 * La carpeta que dejó `ingest_repo` puede no existir: este trabajo corre en otra
 * invocación y en producción el disco es efímero. Antes de leer nada, se
 * garantiza que el código esté (ver `@/server/ingest/rehidratar`).
 */
async function asegurarRoot(
  asegurar: typeof asegurarCodigoEnDisco,
  payload: IndexCodePayload,
  ctx: JobContext,
  analysisRunId: string,
): Promise<string> {
  // Sin proyecto no hay dónde buscar la copia guardada. No se corta acá: si de
  // verdad no hay código, el control de más abajo lo dice con todas las letras.
  if (!ctx.projectId) return payload.repoPath

  const { codeDir, rehidratado } = await asegurar({
    projectId: ctx.projectId,
    analysisRunId,
    repoPath: payload.repoPath,
    log: ctx.log,
  })

  if (rehidratado) ctx.log('Tu código ya está de nuevo acá: seguimos con el análisis.')
  return codeDir
}

/**
 * Un índice sin un solo archivo no se guarda ni encadena nada.
 *
 * Es el corazón del arreglo. Antes, con la carpeta vacía, `walkFiles()` devolvía
 * cero archivos sin fallar, el índice se escribía igual, `run_checks` no
 * encontraba nada y la corrida terminaba "exitosa" con un informe en blanco. Un
 * producto que promete encontrar problemas no puede entregar eso como si fuera
 * un resultado.
 *
 * **Sin reintento, y esto antes estaba mal.** El comentario viejo justificaba
 * reintentar diciendo que llegar acá casi siempre significaba que la copia de
 * Storage no se había podido bajar. Eso no puede pasar: si la copia no se baja,
 * `asegurarCodigoEnDisco` tira antes (`descarga_fallida`, `sin_copia_guardada`)
 * y nunca se llega hasta acá. La única forma de tener `fileCount === 0` con el
 * código en disco es que el árbol esté de verdad vacío o que los filtros se lo
 * hayan llevado entero —alguien subió un .zip con la carpeta compilada y poco
 * más—, y eso no lo arregla ningún reintento. Reintentar quemaba tres intentos
 * con backoff y le dejaba al usuario un "es algo momentáneo" sobre una corrida
 * definitivamente muerta.
 *
 * **Un repo sin nada de código NO cae acá.** `fileCount` cuenta todos los
 * archivos que sobrevivieron a los filtros, no solo los `.ts`/`.tsx`: un
 * proyecto de puro HTML, o de configuración, da `fileCount > 0` y el motor deja
 * la nota "No encontramos archivos de código para leer". Eso es un resultado
 * legítimo y sigue de largo.
 */
function exigirIndiceConArchivos(index: CodeIndex): void {
  if (index.fileCount > 0) return
  throw new JobError(
    'No encontramos ni un archivo para revisar en tu proyecto. Suele pasar cuando lo ' +
      'que llega es solo la carpeta ya compilada (dist, build) y no el código fuente. ' +
      'Revisá que esté el código y volvé a lanzar la revisión.',
    { retryable: false, code: 'indice_vacio' },
  )
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
 * Cuánto espera la revisión de red antes de arrancar sin el agente.
 *
 * El número sale de los tiempos reales del sistema, no de un redondeo lindo:
 *
 * - **Piso: lo que puede tardar el agente.** `runAgentSession` corre hasta 10
 *   tareas (`TASK_ORDER`) con `taskTimeoutMs = 90_000` cada una: 15 minutos en
 *   el peor caso imaginable, más el arranque del navegador, la pasada de
 *   celular y la subida de la evidencia. Un diferimiento por debajo de eso haría
 *   que la red se dispare encima de un agente lento pero sano, y ahí la revisión
 *   correría sin evidencia teniéndola a un minuto de distancia.
 * - **Techo: los 30 minutos de `ESPERA_MAXIMA_EN_COLA_MS`.** Pasado ese umbral,
 *   `vencerEncoladosDesatendidos()` da por perdido lo que nadie atiende. La red
 *   tiene que haber corrido antes: si no, se vencen las dos cosas y la corrida
 *   cierra sin un solo hallazgo, que es exactamente lo que esto viene a evitar.
 * - **El cron dispara cada 60 s** y el tick toma un trabajo por vez, así que la
 *   red no arranca en el minuto 20 exacto sino en el primer tick que la
 *   encuentre vencida. Los 10 minutos de margen contra el techo absorben eso.
 *
 * 20 minutos: cinco por encima del peor agente posible, diez por debajo del
 * abandono. En el camino normal —el agente termina y adelanta la red— este
 * número no se nota: la revisión arranca apenas termina la prueba.
 */
export const DIFERIMIENTO_RED_MS = 20 * 60_000

/**
 * Encadena el paso siguiente.
 *
 * ## Con app publicada: el agente primero, pero con red
 *
 * Los chequeos de cookies, de rastreadores, de flujos que faltan y de pantalla
 * en el celular leen lo que vio el agente. Cuando esto encolaba las dos cosas en
 * paralelo, la revisión ganaba la carrera y se salteaba justo los chequeos que el
 * producto promete — en silencio, porque un chequeo salteado no falla: no
 * aparece. Serializar lo arregló y sigue siendo lo correcto.
 *
 * Lo que no estaba contemplado es que el agente **nunca llegue a correr**. Hoy
 * eso es lo normal, no la excepción: el tick de Vercel no pide
 * `run_browser_agent` (no hay navegador en la función serverless, ver
 * `KINDS_EN_SERVERLESS`) y el worker de Render puede no existir todavía, estar
 * reiniciando o haberse caído. Con la cadena estrictamente serial, nadie
 * encolaba la revisión y el usuario recibía una auditoría vacía —con un motivo
 * legible, pero sin una sola línea de su código revisada—. Es el mismo bug de
 * siempre entrando por otra puerta.
 *
 * Entonces se encolan **las dos**:
 *
 *   - `run_browser_agent` para ya;
 *   - `run_checks` con `run_after` a `DIFERIMIENTO_RED_MS`, de red.
 *
 * Cuando el agente termina —bien o mal— no encola una revisión nueva: adelanta
 * la que ya está esperando y le mete la evidencia adentro
 * (`adelantarOEncolar()`, ver `src/server/agent/handlers.ts`). Si el agente
 * nunca corre, la red se dispara sola y la revisión sale sin evidencia del
 * navegador, con esos chequeos marcados como no revisados.
 *
 * ## Sin app publicada
 *
 * `run_checks` directo, que es todo lo que se puede hacer.
 */
async function encolarSiguientes(
  ctx: JobContext,
  payload: IndexCodePayload,
  analysisRunId: string,
): Promise<void> {
  if (!ctx.projectId) return

  // `encolarUnaVezPorCorrida` y no `enqueue`: esta etapa puede correr dos veces
  // (el worker se murió después de encolar y antes de guardar el avance), y dos
  // `run_checks` de la misma corrida son dos revisiones peleándose las mismas
  // filas de `findings`.
  const comun = {
    orgId: ctx.orgId,
    projectId: ctx.projectId,
    analysisRunId,
  }

  // La conexión a la base **no** se reenvía, ni siquiera cuando este trabajo la
  // resolvió: escribirla en el payload la deja legible para cualquier miembro de
  // la organización. Cada consumidor la vuelve a resolver por su cuenta.
  if (payload.deployedUrl) {
    await encolarUnaVezPorCorrida({
      ...comun,
      kind: 'run_browser_agent',
      // `repoPath` viaja porque el trabajo siguiente lo necesita: el agente no
      // lo usa, se lo pasa a `run_checks` cuando la adelanta.
      payload: {
        deployedUrl: payload.deployedUrl,
        repoPath: payload.repoPath,
      },
    })

    await encolarUnaVezPorCorrida({
      ...comun,
      kind: 'run_checks',
      payload: {
        repoPath: payload.repoPath,
        deployedUrl: payload.deployedUrl,
      },
      runAfter: new Date(Date.now() + DIFERIMIENTO_RED_MS),
    })
    return
  }

  await encolarUnaVezPorCorrida({
    ...comun,
    kind: 'run_checks',
    payload: {
      repoPath: payload.repoPath,
      deployedUrl: null,
    },
  })
}

/* ── Enganche ─────────────────────────────────────────────────────────── */

registerHandler('index_code', crearHandlerIndexCode())
