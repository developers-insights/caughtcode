import 'server-only'

/**
 * Garantiza que el código del usuario esté en disco antes de leerlo.
 *
 * ## El problema que resuelve
 *
 * El pipeline son trabajos encadenados —`ingest_repo` → `index_code` →
 * (`run_browser_agent`) → `run_checks`— y cada uno puede correr en una
 * invocación distinta, en otra máquina. `ingest_repo` descomprime el código en
 * `CAUGHTCODE_STORAGE_DIR` y le pasa esa ruta al siguiente en `payload.repoPath`.
 * En producción esa carpeta vive en `/tmp`, que **no sobrevive entre
 * invocaciones**.
 *
 * Cuando el código no está, nada explota: `walkFiles()` ignora la carpeta que no
 * puede leer, el índice sale con `fileCount: 0`, los chequeos de código se
 * saltean solos por falta de insumo y la corrida termina *succeeded* con cero
 * hallazgos. Pasó de verdad: la corrida `c282c46b` de `alianzas-sabias` figura
 * exitosa con cero hallazgos sobre un repositorio que, corrido en local, da 180.
 * Un producto que promete encontrar problemas no puede fallar en silencio.
 *
 * ## La salida
 *
 * El .zip del código ya está guardado en el bucket `repos_caughtcode`, en la
 * ruta que quedó anotada en `projects_caughtcode.storage_path`. Si la carpeta no
 * está, se baja de ahí y se vuelve a descomprimir en la ruta canónica de la
 * corrida. Es exactamente lo que ya hacía `ingest_repo` adentro de su closure;
 * acá vive una sola vez para que los tres consumidores hagan lo mismo.
 *
 * ## Idempotencia
 *
 * La carpeta se deriva de `(projectId, analysisRunId)` y `ingestar()` la limpia
 * antes de escribir: rehidratar dos veces deja el resultado de la última, nunca
 * una mezcla. Y si el código ya está, no se baja nada.
 *
 * ## Nada de lo que llega en el payload se cree sin comprobar
 *
 * Este módulo es el único punto por el que el worker abre código del usuario, y
 * corre con `service_role`. Las dos entradas que decide vienen de afuera:
 *
 *   - `payload.repoPath`, la carpeta del disco (ver `esCarpetaDelProyecto`);
 *   - `projects.storage_path`, la clave del bucket (ver `esRutaDelProyecto`).
 *
 * Las dos se validan contra el `projectId` del trabajo antes de usarse. Sin eso,
 * en un worker largo —donde conviven en disco los workspaces de varios
 * inquilinos— o con una columna que cualquier miembro puede escribir, la
 * revisión de una organización terminaría leyendo el código de otra.
 */

import { B, T } from '@/lib/db/tablas'
import { describeDbError, jobsDb, type JobsDb } from '@/server/jobs/db'
import { JobError } from '@/server/jobs/errors'

import {
  hayCodigoEnDisco,
  ingestar,
  rutaDelCodigo,
  type ResultadoIngesta,
} from './index'
import { projectRoot, resolveInside } from './workspace'
import { ZipRejectedError } from './zip'

/* ── Guardado del archivo comprimido ──────────────────────────────────── */

/** Guardado del archivo comprimido. Detrás está Supabase Storage. */
export interface AlmacenRepos {
  descargar(bucket: string, ruta: string): Promise<Uint8Array>
  subir(bucket: string, ruta: string, bytes: Uint8Array): Promise<void>
}

/**
 * El import es tardío a propósito: `@/lib/supabase/admin` arranca con
 * `import 'server-only'`, que revienta fuera del runtime de React Server
 * Components. Cargándolo recién cuando de verdad se va a usar, los tests nunca
 * lo tocan.
 *
 * **Por qué ninguna de las dos fallas engancha `cause`.** La cola guarda
 * `describeError(error)` en `jobs.last_error`, y `describeError` copia el
 * mensaje de la causa adentro del texto. Enganchar el error de Supabase le
 * pondría en la pantalla al usuario la ruta del bucket y el texto crudo de
 * Storage. El detalle técnico va al log del servidor, que es donde sirve.
 */
export const almacenSupabase: AlmacenRepos = {
  async descargar(bucket, ruta) {
    const { createAdminClient } = await import('@/lib/supabase/admin')
    const { data, error } = await createAdminClient().storage.from(bucket).download(ruta)
    if (error || !data) {
      console.error(`[ingest] no se pudo bajar ${bucket}/${ruta}: ${error?.message ?? 'sin detalle'}`)
      throw new JobError('No pudimos abrir la copia guardada de tu código.', {
        retryable: true,
        code: 'descarga_fallida',
      })
    }
    return new Uint8Array(await data.arrayBuffer())
  },
  async subir(bucket, ruta, bytes) {
    const { createAdminClient } = await import('@/lib/supabase/admin')
    const { error } = await createAdminClient()
      .storage.from(bucket)
      .upload(ruta, bytes, { contentType: 'application/zip', upsert: true })
    if (error) {
      console.error(`[ingest] no se pudo guardar ${bucket}/${ruta}: ${error.message}`)
      throw new JobError('No pudimos guardar una copia de tu código para analizarlo.', {
        retryable: true,
        code: 'guardado_fallido',
      })
    }
  },
}

/* ── Asegurar el código ───────────────────────────────────────────────── */

export interface OpcionesCodigoEnDisco {
  projectId: string
  analysisRunId: string
  /** Dónde el trabajo anterior dijo que había dejado el código. */
  repoPath: string
  log: (mensaje: string) => void
  /**
   * De dónde sacar el .zip cuando no hay nada en disco. Por defecto, la copia
   * guardada del proyecto. `ingest_repo` pasa su propio plan de fuentes, que
   * además sabe ir al repositorio de GitHub.
   */
  conseguirArchivo?: () => Promise<Uint8Array>
  almacen?: AlmacenRepos
  db?: () => Promise<JobsDb>
}

export interface CodigoEnDisco {
  /** Carpeta donde está el código. Puede no ser la que llegó en el payload. */
  codeDir: string
  /** `true` si hubo que traerlo y descomprimirlo de nuevo. */
  rehidratado: boolean
  /** Lo que devolvió la descompresión. `null` si el código ya estaba. */
  ingesta: ResultadoIngesta | null
}

/**
 * Deja el código del usuario en disco y devuelve dónde quedó.
 *
 * Si no hay nada en disco ni forma de recuperarlo, tira `JobError` sin
 * reintento: volver a intentarlo con el mismo estado daría exactamente lo mismo,
 * y lo que el usuario tiene que hacer es lanzar la revisión de nuevo.
 */
export async function asegurarCodigoEnDisco(
  opciones: OpcionesCodigoEnDisco,
): Promise<CodigoEnDisco> {
  const { projectId, analysisRunId, repoPath, log } = opciones
  const canonica = rutaDelCodigo(projectId, analysisRunId)

  // La ruta del payload no se acepta a ciegas: este módulo existe justamente
  // porque puede llegar desincronizada. En el worker largo, donde conviven en
  // disco los workspaces de varios inquilinos, una carpeta de otro proyecto
  // haría que el índice y los hallazgos se armaran con código ajeno. Si no cae
  // adentro de la carpeta de ESTE proyecto, se ignora y se sigue con la
  // canónica, que no la elige nadie de afuera.
  const esDelProyecto = esCarpetaDelProyecto(repoPath, projectId)
  if (!esDelProyecto) {
    log(
      'La carpeta que traía este trabajo no es de este proyecto: la ignoramos y ' +
        'seguimos con la de esta revisión.',
    )
  }

  if (esDelProyecto && (await hayCodigoEnDisco(repoPath))) {
    log('El código de esta corrida ya estaba listo: no hizo falta traerlo de nuevo.')
    return { codeDir: repoPath, rehidratado: false, ingesta: null }
  }

  // Puede pasar que el payload traiga una ruta vieja (de otra corrida, o de una
  // versión anterior del pipeline) y el código de ESTA corrida sí esté donde
  // corresponde. Bajarlo de nuevo sería tirar trabajo hecho.
  if (repoPath !== canonica && (await hayCodigoEnDisco(canonica))) {
    log('El código de esta corrida ya estaba listo: no hizo falta traerlo de nuevo.')
    return { codeDir: canonica, rehidratado: false, ingesta: null }
  }

  const traer = opciones.conseguirArchivo
  if (!traer) {
    log('Tu código ya no estaba donde lo habíamos dejado: lo traemos de nuevo de la copia guardada.')
  }

  const bytes = traer
    ? await traer()
    : await bajarCopiaGuardada(
        projectId,
        opciones.db ?? jobsDb,
        opciones.almacen ?? almacenSupabase,
        log,
      )

  const ingesta = await descomprimir(projectId, analysisRunId, bytes)

  for (const aviso of ingesta.avisos) log(aviso)
  for (const descarte of ingesta.descartes) {
    log(`Dejamos afuera ${descarte.cantidad} archivo(s): ${descarte.mensajePlain}`)
  }

  // Un comprimido válido pero sin un solo archivo adentro es la misma falla
  // silenciosa por otro camino: si lo dejáramos pasar, el índice saldría vacío y
  // el informe también.
  if (ingesta.fileCount === 0) {
    throw new JobError(
      'La copia de tu código llegó vacía, así que no hay nada para revisar. Volvé a lanzar la revisión y lo traemos de nuevo.',
      { retryable: false, code: 'copia_vacia' },
    )
  }

  return { codeDir: ingesta.codeDir, rehidratado: true, ingesta }
}

/* ── Qué rutas son de este proyecto ───────────────────────────────────── */

/**
 * ¿Esa clave del bucket es de este proyecto?
 *
 * Todo lo nuestro en Storage vive en `<org_id>/<project_id>/…` (convención de
 * `supabase/README.md`). Pero quien baja el archivo usa `service_role`, que
 * **ignora las políticas del bucket**: la ruta es el único control que queda. Y
 * `storage_path` es una columna que cualquier miembro de la organización puede
 * escribir por PostgREST —no hay trigger guarda en `projects_caughtcode`, a
 * diferencia de `organizations_caughtcode`—, así que sin este chequeo alcanzaba
 * con apuntarla al .zip de otra empresa para que el worker lo bajara, lo
 * descomprimiera en el workspace propio y publicara hallazgos con fragmentos de
 * código ajeno.
 *
 * El control que de verdad cierra la puerta es el **segundo** segmento: el
 * `project_id` sale del trabajo, no de la fila, así que no se puede falsear
 * desde el cliente ni cambiándole el `org_id` al proyecto.
 *
 * Se rechazan también las rutas con segmentos vacíos, `.` o `..`: se normalizan
 * del otro lado y podrían escaparse del prefijo aunque empiecen bien.
 */
export function esRutaDelProyecto(
  ruta: string,
  orgId: string | null,
  projectId: string,
): boolean {
  if (!orgId) return false
  const segmentos = ruta.trim().split('/')
  if (segmentos.length < 3) return false
  if (segmentos.some((s) => s === '' || s === '.' || s === '..')) return false
  return segmentos[0] === orgId && segmentos[1] === projectId
}

/** ¿Esa carpeta del disco cuelga del workspace de este proyecto? */
function esCarpetaDelProyecto(repoPath: string, projectId: string): boolean {
  if (!repoPath.trim()) return false
  try {
    resolveInside(projectRoot(projectId), repoPath)
    return true
  } catch {
    // `resolveInside` solo tira cuando la ruta se sale de la base. Acá eso no es
    // una falla que haya que propagar: es la respuesta "no, no es de este
    // proyecto", y quien llama sigue con la ruta canónica.
    return false
  }
}

/* ── De dónde sale la copia ───────────────────────────────────────────── */

/**
 * Baja el respaldo del proyecto, o explica por qué no.
 *
 * Cuando la ruta guardada no pertenece al proyecto se trata como si no hubiera
 * copia, y no como un error propio. Es a propósito: acá no hay un segundo
 * origen al que caer —eso solo existe en `ingest_repo`, que además sabe ir al
 * repositorio—, así que las dos únicas salidas son bajar algo ajeno o no bajar
 * nada. `sinCopia()` no reintenta y le pide al usuario que vuelva a lanzar la
 * revisión, que arranca de nuevo desde `ingest_repo` y reescribe `storage_path`
 * con una ruta canónica. Un cliente con una ruta histórica rara no queda sin
 * servicio: queda a un click de recuperarlo, y mientras tanto no bajamos el
 * código de nadie más.
 */
async function bajarCopiaGuardada(
  projectId: string,
  abrirDb: () => Promise<JobsDb>,
  almacen: AlmacenRepos,
  log: (mensaje: string) => void,
): Promise<Uint8Array> {
  const db = await abrirDb()
  const { data, error } = await db
    .from(T.projects)
    .select('org_id, storage_path')
    .eq('id', projectId)
    .maybeSingle()

  if (error) {
    // El detalle técnico va al log del worker, nunca al mensaje: lo que se tira
    // acá termina en `jobs.last_error` y de ahí a la pantalla del usuario.
    log(`No se pudo leer el proyecto ${projectId}: ${describeDbError(error)}`)
    throw new JobError(
      'No pudimos leer los datos de tu proyecto. Lo intentamos de nuevo en un ratito.',
      { retryable: true, code: 'proyecto_ilegible' },
    )
  }

  const fila = (data as Record<string, unknown> | null) ?? {}
  const orgId = typeof fila.org_id === 'string' ? fila.org_id : null
  const ruta = typeof fila.storage_path === 'string' ? fila.storage_path.trim() : ''
  if (!ruta) throw sinCopia()

  if (!esRutaDelProyecto(ruta, orgId, projectId)) {
    log(
      `La copia guardada del proyecto ${projectId} no está en su propia carpeta: ` +
        'no se descargó nada.',
    )
    throw sinCopia()
  }

  return almacen.descargar(B.repos, ruta)
}

/**
 * Sin carpeta y sin copia no hay nada que hacer con este trabajo: la única
 * salida es que el usuario vuelva a lanzar la revisión, que arranca de nuevo
 * desde `ingest_repo` y trae el código otra vez.
 */
function sinCopia(): JobError {
  return new JobError(
    'Perdimos la copia de tu código. Volvé a lanzar la revisión y lo traemos de nuevo.',
    { retryable: false, code: 'sin_copia_guardada' },
  )
}

/**
 * `ingestar()` ya sabe descomprimir con el extractor endurecido y dejar afuera
 * lo que no es código del usuario. Acá solo se traduce lo que tira al
 * vocabulario de la cola: el mensaje de `ZipRejectedError` ya está escrito para
 * el usuario, y volver a intentarlo con el mismo archivo daría lo mismo.
 */
async function descomprimir(
  projectId: string,
  analysisRunId: string,
  bytes: Uint8Array,
): Promise<ResultadoIngesta> {
  try {
    return await ingestar({
      projectId,
      runId: analysisRunId,
      fuente: { tipo: 'archivo', bytes },
    })
  } catch (error) {
    if (error instanceof ZipRejectedError) {
      throw new JobError(error.message, {
        retryable: false,
        code: `archivo_${error.code}`,
        cause: error,
      })
    }
    throw error
  }
}
