/**
 * Handler del trabajo `ingest_repo`: el primer eslabón de la cadena.
 *
 * Cuatro etapas, todas reanudables:
 *
 *   1. traer el código (de lo que guardamos, o del repositorio público)
 *   2. abrirlo y dejar afuera lo que no es código del usuario
 *   3. reconocer con qué está hecho el proyecto
 *   4. dejar todo listo para el siguiente paso
 *
 * ## Es el único trabajo que llega sin corrida
 *
 * `startAuditAction` encola esto con el payload vacío: la fila de
 * `analysis_runs` la crea **este** handler. Eso lo vuelve el punto más delicado
 * de toda la cola, porque un reintento mal resuelto no duplica una fila
 * cualquiera: duplica la auditoría entera, y el usuario la paga dos veces.
 *
 * La corrida se busca en tres lugares, en este orden: lo que trae el contexto,
 * lo que quedó anotado en la fila del trabajo (de un intento anterior) y, recién
 * si no hay nada, se crea una nueva. Apenas se crea, se anota en el trabajo. Así
 * la identidad de la corrida sobrevive incluso si se pierde el avance guardado
 * en el payload.
 *
 * ## Idempotencia
 *
 * - El código se descomprime en una carpeta derivada de `analysis_run_id`, que
 *   se limpia antes de escribir: correr dos veces deja el resultado de la
 *   última, nunca una mezcla.
 * - El archivo comprimido se guarda en una ruta derivada de `analysis_run_id`,
 *   sobrescribiendo.
 * - `index_code` se encola una sola vez por corrida: antes de encolarlo se
 *   comprueba que no esté ya. Sin eso, un reintento arrancaría dos análisis
 *   completos en paralelo.
 * - El costo se registra en la misma etapa que encola, así que tampoco se cobra
 *   dos veces lo mismo.
 *
 * ## Los textos de error de repositorio no se escriben acá
 *
 * `PublicRepoError` trae la causa clasificada; el texto que ve el usuario vive
 * en `src/content/copy.ts` y se elige por esa causa. Un mensaje inventado acá
 * sería un cuarto lugar donde mantener lo mismo.
 *
 * ## De dónde sale el código
 *
 * El orden de intentos lo decide `planDeFuentes` (`./fuente.ts`), que no toca ni
 * la red ni la base. Acá solo se ejecuta ese plan. La regla que no se puede
 * romper: un proyecto conectado con la GitHub App (`source_type = 'github'`)
 * **nunca** se baja por el camino anónimo. GitHub responde 404 a quien no tiene
 * credencial, lo traduciríamos a "tu repositorio es privado" y le estaríamos
 * pidiendo al usuario que conecte una cuenta que ya conectó.
 */

import { ONBOARDING } from '@/content/copy'
import { B, T } from '@/lib/db/tablas'
import type { CostEntry, RunStatus, StackInfo } from '@/lib/types/domain'
import { storageCostUsd } from '@/server/cost/pricing'
import { enqueue, registerHandler, runStages } from '@/server/jobs'
import type { JobContext, JobHandler, StageStore } from '@/server/jobs'
import { describeDbError, jobsDb, type JobsDb } from '@/server/jobs/db'
import { JobError, describeError } from '@/server/jobs/errors'
import { markRunFinished, publishRunProgress } from '@/server/jobs/progress'

import { planDeFuentes, type OrigenCodigo } from './fuente'
import {
  GithubNotConfiguredError,
  PublicRepoError,
  parseGithubUrl,
  type PublicRepoErrorCode,
  type RepoRef,
  type StoredGithubConnection,
} from './github'
import {
  hayCodigoEnDisco,
  ingestar,
  rutaDelCodigo,
  type ResultadoIngesta,
} from './index'
import { detectStack } from './stack'
import { ZipRejectedError } from './zip'

/* ── Lo que llega en el trabajo ───────────────────────────────────────── */

export interface IngestRepoPayload {
  /** Dirección del repositorio, si el pedido la trae. Si falta, se lee del proyecto. */
  repoUrl?: string | null
  /** Dirección de la app publicada. Si falta, se lee del proyecto. */
  deployedUrl?: string | null
  /** Conexión de solo lectura a la base del usuario. Si falta, se lee de sus conexiones. */
  databaseUrl?: string | null
}

/** Lo que espera `index_code`. Se replica acá para no importar del frente de análisis. */
interface IndexCodePayload {
  repoPath: string
  deployedUrl?: string | null
  databaseUrl?: string | null
}

/* ── Inyección de dependencias ────────────────────────────────────────── */

/** Guardado del archivo comprimido. Detrás está Supabase Storage. */
export interface AlmacenRepos {
  descargar(bucket: string, ruta: string): Promise<Uint8Array>
  subir(bucket: string, ruta: string, bytes: Uint8Array): Promise<void>
}

/**
 * Lo que el handler necesita de la GitHub App. Es una interfaz y no las
 * funciones sueltas para poder probar el camino de repositorio privado sin
 * clave privada, sin instalación y sin salir a la red.
 */
export interface AccesoGithubApp {
  /**
   * La cuenta de GitHub conectada **por esta organización** que sea dueña de
   * `owner`. `null` si el equipo no conectó ninguna que sirva.
   *
   * Toma `orgId` a propósito: buscar en la lista global de instalaciones sería
   * prestarle a un equipo el permiso de otro.
   */
  buscarInstalacionDeLaOrg(
    orgId: string,
    owner: string,
  ): Promise<{ id: number; accountLogin: string } | null>
  /** Qué rama y qué commit exacto vamos a analizar. Es lo que fecha la evidencia. */
  resolverRef(target: RepoRef): Promise<{ ref: string; sha: string }>
  bajarArchivo(target: RepoRef): Promise<Uint8Array>
}

export interface DependenciasIngestRepo {
  db?: () => Promise<JobsDb>
  store?: StageStore
  almacen?: AlmacenRepos
  /** Descifra la conexión a la base del usuario. Separado para poder probarlo. */
  descifrar?: (credencial: string) => Promise<string>
  /** Acceso a repositorios privados con la GitHub App. */
  github?: AccesoGithubApp
  /** Descifra la conexión con GitHub guardada en el proyecto. */
  descifrarGithub?: (credencial: string) => Promise<StoredGithubConnection>
}

/**
 * El import es tardío a propósito: `@/lib/supabase/admin` arranca con
 * `import 'server-only'`, que revienta fuera del runtime de React Server
 * Components. Cargándolo recién cuando de verdad se va a usar, los tests nunca
 * lo tocan.
 */
export const almacenSupabase: AlmacenRepos = {
  async descargar(bucket, ruta) {
    const { createAdminClient } = await import('@/lib/supabase/admin')
    const { data, error } = await createAdminClient().storage.from(bucket).download(ruta)
    if (error || !data) {
      throw new JobError('No pudimos abrir la copia guardada de tu código.', {
        retryable: true,
        code: 'descarga_fallida',
        cause: error,
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
      throw new JobError('No pudimos guardar una copia de tu código para analizarlo.', {
        retryable: true,
        code: 'guardado_fallido',
        cause: error,
      })
    }
  },
}

async function descifrarPorDefecto(credencial: string): Promise<string> {
  const { decryptSecret } = await import('@/lib/crypto')
  return decryptSecret(credencial)
}

/**
 * Acceso real a la GitHub App. Los imports son tardíos por lo mismo que en
 * `almacenSupabase`: cargar el cliente de GitHub exige variables de entorno que
 * en los tests no existen, y no hacen falta hasta que de verdad se usa.
 */
export const githubAppReal: AccesoGithubApp = {
  async buscarInstalacionDeLaOrg(orgId, owner) {
    const { findOrgInstallationForOwner } = await import('./github')
    const instalacion = await findOrgInstallationForOwner(orgId, owner)
    return instalacion ? { id: instalacion.id, accountLogin: instalacion.accountLogin } : null
  },
  async resolverRef(target) {
    const { resolveRef } = await import('./github')
    return resolveRef(target)
  },
  async bajarArchivo(target) {
    const { downloadRepoArchive } = await import('./github')
    return downloadRepoArchive(target)
  },
}

async function descifrarGithubPorDefecto(credencial: string): Promise<StoredGithubConnection> {
  const { decodeConnection } = await import('./github')
  return decodeConnection(credencial)
}

/* ── Etapas: el texto lo lee el usuario ───────────────────────────────── */

const ETAPAS = {
  traer: 'Trayendo tu código',
  abrir: 'Abriendo tu proyecto',
  reconocer: 'Viendo con qué está hecho',
  listo: 'Dejando todo listo para revisarlo',
} as const

/* ── Handler ──────────────────────────────────────────────────────────── */

export function crearHandlerIngestRepo(
  deps: DependenciasIngestRepo = {},
): JobHandler<IngestRepoPayload> {
  return async (payload, ctx) => {
    const db = await (deps.db ?? jobsDb)()
    const almacen = deps.almacen ?? almacenSupabase
    const descifrar = deps.descifrar ?? descifrarPorDefecto
    const github = deps.github ?? githubAppReal
    const descifrarGithub = deps.descifrarGithub ?? descifrarGithubPorDefecto

    const projectId = exigirProyecto(ctx)
    const proyecto = await leerProyecto(db, projectId)
    const analysisRunId = await asegurarCorrida(db, ctx, projectId)

    const codeDir = rutaDelCodigo(projectId, analysisRunId)
    const rutaCorrida = rutaDelArchivo(proyecto.orgId ?? ctx.orgId, projectId, analysisRunId)

    // Memoria de esta invocación: si una etapa ya trajo el archivo o ya
    // descomprimió, las siguientes no lo vuelven a hacer.
    let archivoEnMemoria: Uint8Array | null = null
    let rutaDeOrigen: string | null = null
    /** Commit exacto que se trajo de GitHub. `null` si el código salió de una copia. */
    let shaTraido: string | null = null
    let ingesta: ResultadoIngesta | null = null

    /** Trae el archivo de un origen concreto. Cada camino usa su credencial, o ninguna. */
    const traerDe = async (origen: OrigenCodigo): Promise<Uint8Array> => {
      if (origen.tipo === 'guardado') {
        const bytes = await almacen.descargar(B.repos, origen.ruta)
        rutaDeOrigen = origen.ruta
        shaTraido = null
        return bytes
      }

      if (origen.tipo === 'github_publico') {
        const { traerArchivo } = await import('./index')
        const traido = await traerArchivo({ tipo: 'github', url: origen.url })
        rutaDeOrigen = null
        shaTraido = null
        ctx.log(
          `Trajimos el código de ${traido.repo?.owner}/${traido.repo?.repo}` +
            `${traido.repo?.ref ? ` (rama ${traido.repo.ref})` : ''}.`,
        )
        return traido.bytes
      }

      // GitHub App: es el camino de los repositorios privados. Que llegue acá
      // sin instalación no es un caso raro que se pueda ignorar — es el bug que
      // hacía que un repositorio nuestro se leyera como ajeno.
      const destino = parseGithubUrl(origen.url)
      if (!destino) {
        throw new PublicRepoError(
          'no_existe',
          `La dirección guardada del proyecto ("${origen.url.slice(0, 200)}") no tiene forma de repositorio de GitHub.`,
        )
      }

      const installationId = await conseguirInstalacion(
        db,
        projectId,
        destino,
        ctx,
        github,
        descifrarGithub,
      )

      try {
        const objetivo: RepoRef = { ...destino, installationId }
        const { ref, sha } = await github.resolverRef(objetivo)
        const bytes = await github.bajarArchivo({ ...objetivo, ref })
        rutaDeOrigen = null
        shaTraido = sha
        ctx.log(`Trajimos el código de ${destino.owner}/${destino.repo} (rama ${ref}).`)
        return bytes
      } catch (error) {
        throw traducirErrorDeApp(error, destino)
      }
    }

    /** Consigue el archivo comprimido recorriendo el plan hasta que uno funcione. */
    const conseguirArchivo = async (): Promise<Uint8Array> => {
      if (archivoEnMemoria) return archivoEnMemoria

      const plan = planDeFuentes({
        sourceType: proyecto.sourceType,
        repoUrl: payload.repoUrl ?? proyecto.repoUrl,
        storagePath: proyecto.storagePath,
        rutaCorrida,
      })

      if (plan.length === 0) throw sinFuente()

      for (const [indice, origen] of plan.entries()) {
        try {
          archivoEnMemoria = await traerDe(origen)
          return archivoEnMemoria
        } catch (error) {
          // El último intento manda: su causa es la que va a ver el usuario.
          if (indice === plan.length - 1) throw error
          ctx.log(`${porQueFallo(origen, error)} Probamos con la otra fuente disponible.`)
        }
      }

      throw sinFuente()
    }

    /** Garantiza que el código esté descomprimido en la carpeta de la corrida. */
    const asegurarCodigo = async (): Promise<{ stack: StackInfo; ingesta: ResultadoIngesta | null }> => {
      if (ingesta) return { stack: ingesta.stack, ingesta }

      if (await hayCodigoEnDisco(codeDir)) {
        ctx.log('El código de esta corrida ya estaba listo: no hizo falta traerlo de nuevo.')
        return { stack: await detectStack(codeDir), ingesta: null }
      }

      const bytes = await conseguirArchivo()
      ingesta = await ingestar({
        projectId,
        runId: analysisRunId,
        fuente: { tipo: 'archivo', bytes },
      })
      for (const aviso of ingesta.avisos) ctx.log(aviso)
      for (const descarte of ingesta.descartes) {
        ctx.log(`Dejamos afuera ${descarte.cantidad} archivo(s): ${descarte.mensajePlain}`)
      }
      return { stack: ingesta.stack, ingesta }
    }

    try {
      await runStages(
        ctx,
        [
          {
            name: 'traer_codigo',
            label: ETAPAS.traer,
            progress: 35,
            run: async () => {
              await publicar(analysisRunId, ETAPAS.traer, 5)
              const bytes = await conseguirArchivo()

              if (rutaDeOrigen !== rutaCorrida) {
                await almacen.subir(B.repos, rutaCorrida, bytes)
              }
              // El commit solo se anota cuando de verdad se bajó de GitHub: si
              // el código salió de una copia, decir que es otro commit sería
              // inventar evidencia.
              await guardarEnProyecto(
                db,
                projectId,
                shaTraido
                  ? { storage_path: rutaCorrida, repo_ref: shaTraido }
                  : { storage_path: rutaCorrida },
                ctx,
              )

              await publicar(analysisRunId, ETAPAS.traer, 35)
              return { desde: rutaDeOrigen ? 'copia guardada' : 'repositorio', bytes: bytes.byteLength }
            },
          },
          {
            name: 'desempaquetar',
            label: ETAPAS.abrir,
            progress: 70,
            run: async () => {
              await publicar(analysisRunId, ETAPAS.abrir, 45)
              const { ingesta: resultado } = await asegurarCodigo()
              await publicar(analysisRunId, ETAPAS.abrir, 70)

              if (!resultado) return { archivos: null, yaEstaba: true }
              return {
                archivos: resultado.fileCount,
                bytes: resultado.totalBytes,
                // Recortado a propósito: el resultado de una etapa se guarda en
                // la fila del trabajo y tiene que seguir siendo chico.
                descartes: resultado.descartes.slice(0, 6).map((descarte) => ({
                  motivo: descarte.motivo,
                  cantidad: descarte.cantidad,
                })),
                avisos: resultado.avisos.slice(0, 5),
              }
            },
          },
          {
            name: 'reconocer',
            label: ETAPAS.reconocer,
            progress: 85,
            run: async () => {
              await publicar(analysisRunId, ETAPAS.reconocer, 78)
              const { stack } = await asegurarCodigo()
              await guardarEnProyecto(db, projectId, { stack_detected: stack }, ctx)
              await publicar(analysisRunId, ETAPAS.reconocer, 85)

              for (const linea of stack.evidence.slice(0, 6)) ctx.log(linea)
              return {
                conQueEstaHecho: stack.framework,
                lenguaje: stack.language,
                dondeViven: stack.backends,
              }
            },
          },
          {
            name: 'dejar_listo',
            label: ETAPAS.listo,
            progress: 100,
            run: async (helper) => {
              await publicar(analysisRunId, ETAPAS.listo, 92)
              await asegurarCodigo()

              if (await yaHayAnalisisEncolado(db, analysisRunId, ctx)) {
                ctx.log('El análisis de este proyecto ya estaba en marcha: no lo encolamos de nuevo.')
                return { encolado: false }
              }

              const traido = helper.get<{ bytes?: number }>('traer_codigo')
              const abierto = helper.get<{ archivos?: number | null }>('desempaquetar')
              await ctx.reportCost(
                costoDeIngesta(abierto?.archivos ?? null, traido?.bytes ?? 0),
              )

              const siguiente: IndexCodePayload = {
                repoPath: codeDir,
                deployedUrl: (payload.deployedUrl ?? proyecto.deployedUrl) || null,
                databaseUrl:
                  payload.databaseUrl ??
                  (await leerConexionBase(db, projectId, ctx, descifrar)),
              }

              await enqueue({
                orgId: ctx.orgId,
                projectId,
                analysisRunId,
                kind: 'index_code',
                payload: siguiente,
              })

              await publicar(analysisRunId, ETAPAS.listo, 100)
              return { encolado: true }
            },
          },
        ],
        deps.store ? { store: deps.store } : {},
      )
    } catch (error) {
      const traducido = traducirError(error)
      // Solo cerramos la corrida cuando ya no hay nada que hacer. Si el trabajo
      // se va a reintentar, dejarla en "falló" le mentiría al usuario.
      if (!traducido.retryable || ctx.attempt >= ctx.maxAttempts) {
        await cerrarCorridaFallida(analysisRunId, traducido.message, ctx)
      }
      throw traducido
    }
  }
}

/* ── Contexto mínimo ──────────────────────────────────────────────────── */

function exigirProyecto(ctx: JobContext): string {
  if (!ctx.projectId) {
    throw new JobError('El trabajo para traer el código llegó sin proyecto asociado.', {
      retryable: false,
      code: 'sin_proyecto',
    })
  }
  return ctx.projectId
}

interface ProyectoParaIngesta {
  orgId: string | null
  sourceType: string
  repoUrl: string | null
  repoRef: string | null
  deployedUrl: string | null
  storagePath: string | null
}

async function leerProyecto(db: JobsDb, projectId: string): Promise<ProyectoParaIngesta> {
  const { data, error } = await db
    .from(T.projects)
    .select('org_id, source_type, repo_url, repo_ref, deployed_url, storage_path')
    .eq('id', projectId)
    .maybeSingle()

  if (error) {
    throw new JobError(`No pudimos leer los datos de tu proyecto: ${describeDbError(error)}`, {
      retryable: true,
      code: 'proyecto_ilegible',
    })
  }
  if (!data) {
    throw new JobError('Este proyecto ya no existe. Puede que se haya borrado.', {
      retryable: false,
      code: 'proyecto_inexistente',
    })
  }

  const fila = data as Record<string, unknown>
  return {
    orgId: fila.org_id ? String(fila.org_id) : null,
    sourceType: String(fila.source_type ?? 'zip'),
    repoUrl: fila.repo_url ? String(fila.repo_url) : null,
    repoRef: fila.repo_ref ? String(fila.repo_ref) : null,
    deployedUrl: fila.deployed_url ? String(fila.deployed_url) : null,
    storagePath: fila.storage_path ? String(fila.storage_path) : null,
  }
}

/* ── La corrida ───────────────────────────────────────────────────────── */

/**
 * Devuelve la corrida de este trabajo, creándola solo si de verdad no existe.
 *
 * El orden importa: primero el contexto, después lo anotado en la fila del
 * trabajo (que sobrevive a que se pierda el avance del payload) y recién
 * entonces se crea una nueva.
 */
async function asegurarCorrida(
  db: JobsDb,
  ctx: JobContext,
  projectId: string,
): Promise<string> {
  if (ctx.analysisRunId) return ctx.analysisRunId

  const { data, error } = await db
    .from(T.jobs)
    .select('analysis_run_id')
    .eq('id', ctx.jobId)
    .maybeSingle()

  if (error) {
    throw new JobError(
      `No pudimos comprobar si este análisis ya había arrancado: ${describeDbError(error)}`,
      { retryable: true, code: 'trabajo_ilegible' },
    )
  }

  const yaCreada = (data as Record<string, unknown> | null)?.analysis_run_id
  if (yaCreada) return String(yaCreada)

  const creada = await db
    .from(T.analysisRuns)
    .insert({
      project_id: projectId,
      status: 'running' satisfies RunStatus,
      stage: ETAPAS.traer,
      progress: 0,
      started_at: new Date().toISOString(),
    })
    .select('id')
    .single()

  if (creada.error || !creada.data?.id) {
    throw new JobError(
      `No pudimos abrir el análisis de tu proyecto: ${describeDbError(creada.error)}`,
      { retryable: true, code: 'corrida_no_creada' },
    )
  }

  const analysisRunId = String(creada.data.id)

  // Anotarlo en el trabajo es lo que evita crear una segunda corrida si el
  // worker se muere y el avance guardado se pierde.
  const anotado = await db
    .from(T.jobs)
    .update({ analysis_run_id: analysisRunId })
    .eq('id', ctx.jobId)

  if (anotado.error) {
    ctx.log(
      `Aviso: no pudimos anotar el análisis en el trabajo (${describeDbError(anotado.error)}). ` +
        'Si este trabajo se reintenta, podría abrir un análisis nuevo.',
    )
  }

  return analysisRunId
}

async function publicar(analysisRunId: string, stage: string, progress: number): Promise<void> {
  await publishRunProgress(analysisRunId, { stage, progress })
}

async function cerrarCorridaFallida(
  analysisRunId: string,
  mensaje: string,
  ctx: JobContext,
): Promise<void> {
  try {
    await markRunFinished(analysisRunId, { status: 'failed', error: mensaje, stage: null })
  } catch (error) {
    // Que no se pueda cerrar la corrida no puede tapar el error original.
    ctx.log(`No pudimos dejar registrado que el análisis falló: ${describeError(error)}`)
  }
}

/* ── De dónde sale el código ──────────────────────────────────────────── */

function sinFuente(): JobError {
  return new JobError(
    'No encontramos el código de este proyecto. Subilo de nuevo como archivo .zip o pegá la dirección de tu repositorio.',
    { retryable: false, code: 'sin_fuente' },
  )
}

/** Qué decir en el registro cuando un intento falla y todavía queda otro. */
function porQueFallo(origen: OrigenCodigo, error: unknown): string {
  if (origen.tipo === 'guardado') {
    return `No pudimos usar la copia guardada de tu código (${describeError(error)}).`
  }
  return `No pudimos traer tu código de GitHub (${describeError(error)}).`
}

/**
 * Con qué instalación de la GitHub App entramos a este repositorio.
 *
 * Primero la que el proyecto dejó guardada al conectarse: es la que el usuario
 * eligió. Si no está —o quedó ilegible— se busca **entre las instalaciones de
 * esta organización** la de la cuenta dueña del repositorio.
 *
 * Que la búsqueda sea por organización y no global es lo único que separa esto
 * de una fuga entre clientes: `authenticated` puede insertar filas en
 * `projects_caughtcode`, así que cualquiera podría crear un proyecto apuntando
 * al repositorio privado de otra empresa y, si acá buscáramos en la lista
 * completa de instalaciones, el worker le prestaría un permiso ajeno sin que
 * nadie lo note. Es exactamente el tipo de falla que este producto audita.
 */
async function conseguirInstalacion(
  db: JobsDb,
  projectId: string,
  destino: { owner: string; repo: string },
  ctx: JobContext,
  github: AccesoGithubApp,
  descifrarGithub: (credencial: string) => Promise<StoredGithubConnection>,
): Promise<number> {
  const guardada = await leerConexionGithub(db, projectId, ctx, descifrarGithub)
  if (guardada) return guardada.installationId

  let propia: { id: number; accountLogin: string } | null
  try {
    propia = await github.buscarInstalacionDeLaOrg(ctx.orgId, destino.owner)
  } catch (error) {
    throw traducirErrorDeApp(error, destino)
  }

  if (propia) {
    ctx.log(`Entramos a ${destino.owner}/${destino.repo} con el acceso de ${propia.accountLogin}.`)
    return propia.id
  }

  // Sin instalación propia de esa cuenta no hay forma de entrar. La causa es de
  // permisos, así que el texto y el "no reintentar" salen del mismo lugar que
  // el resto de los errores de repositorio.
  throw new PublicRepoError(
    'privado',
    `Tu equipo no tiene conectada ninguna cuenta de GitHub con acceso a ` +
      `${destino.owner}/${destino.repo}.`,
  )
}

async function leerConexionGithub(
  db: JobsDb,
  projectId: string,
  ctx: JobContext,
  descifrarGithub: (credencial: string) => Promise<StoredGithubConnection>,
): Promise<StoredGithubConnection | null> {
  const { data, error } = await db
    .from(T.projectConnections)
    .select('credentials_ref')
    .eq('project_id', projectId)
    .eq('provider', 'github')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    ctx.log(
      `No pudimos leer con qué cuenta de GitHub habías conectado este proyecto ` +
        `(${describeDbError(error)}). Buscamos el acceso entre las cuentas conectadas.`,
    )
    return null
  }

  const credencial = (data as Record<string, unknown> | null)?.credentials_ref
  if (!credencial) return null

  try {
    return await descifrarGithub(String(credencial))
  } catch (error) {
    ctx.log(
      `La conexión con GitHub guardada quedó ilegible (${describeError(error)}). ` +
        'Buscamos el acceso entre las cuentas conectadas.',
    )
    return null
  }
}

/** Estado HTTP que trae el cliente de GitHub, si lo trae. */
function estadoHttp(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null
  const estado = (error as { status?: unknown }).status
  return typeof estado === 'number' ? estado : null
}

function frenadoPorGithub(error: unknown, estado: number | null): boolean {
  if (estado === 429) return true
  if (estado !== 403) return false
  const cabeceras = (error as { response?: { headers?: Record<string, unknown> } }).response?.headers
  return String(cabeceras?.['x-ratelimit-remaining'] ?? '') === '0'
}

/**
 * Traduce una falla de la GitHub App a la misma causa clasificada que usa el
 * camino público, para que el texto que ve el usuario salga de un solo lugar.
 *
 * Un 404 **con credencial** no significa lo mismo que sin ella: quiere decir que
 * la instalación ya no tiene ese repositorio entre los elegidos. Por eso cae en
 * "privado", que es el texto que le pide al usuario revisar a cuáles nos dio
 * acceso — y no en "no existe", que lo mandaría a revisar la dirección.
 */
function traducirErrorDeApp(
  error: unknown,
  destino: { owner: string; repo: string },
): PublicRepoError | JobError {
  if (error instanceof PublicRepoError) return error
  if (error instanceof JobError) return error

  if (error instanceof GithubNotConfiguredError) {
    // Su mensaje ya está escrito para el usuario y ofrece la salida (subir un
    // .zip). Reintentar con la misma configuración daría exactamente lo mismo.
    return new JobError(error.message, {
      retryable: false,
      code: 'github_sin_configurar',
      cause: error,
    })
  }

  const estado = estadoHttp(error)
  const donde = `${destino.owner}/${destino.repo}`

  if (frenadoPorGithub(error, estado)) {
    return new PublicRepoError(
      'demasiados_intentos',
      `GitHub respondió ${estado} por límite de consultas al pedir ${donde} con la instalación de la app.`,
      { cause: error },
    )
  }

  if (estado === 401 || estado === 403 || estado === 404 || estado === 451) {
    return new PublicRepoError(
      'privado',
      `GitHub respondió ${estado} al pedir ${donde} con la instalación de la app: ` +
        'la instalación existe pero ya no alcanza para ese repositorio.',
      { cause: error },
    )
  }

  return new PublicRepoError(
    'red',
    `GitHub respondió ${estado ?? 'un error'} al pedir ${donde} con la instalación de la app.`,
    { cause: error },
  )
}

/* ── Escrituras auxiliares ────────────────────────────────────────────── */

async function guardarEnProyecto(
  db: JobsDb,
  projectId: string,
  cambios: Record<string, unknown>,
  ctx: JobContext,
): Promise<void> {
  const { error } = await db.from(T.projects).update(cambios).eq('id', projectId)
  if (error) {
    // No es fatal: el análisis puede seguir. Pero tiene que quedar dicho.
    ctx.log(`No pudimos actualizar los datos de tu proyecto: ${describeDbError(error)}`)
  }
}

async function yaHayAnalisisEncolado(
  db: JobsDb,
  analysisRunId: string,
  ctx: JobContext,
): Promise<boolean> {
  const { data, error } = await db
    .from(T.jobs)
    .select('id')
    .eq('analysis_run_id', analysisRunId)
    .eq('kind', 'index_code')
    .limit(1)
    .maybeSingle()

  if (error) {
    ctx.log(
      `No pudimos comprobar si el análisis ya estaba encolado: ${describeDbError(error)}. ` +
        'Seguimos adelante.',
    )
    return false
  }
  return Boolean(data)
}

async function leerConexionBase(
  db: JobsDb,
  projectId: string,
  ctx: JobContext,
  descifrar: (credencial: string) => Promise<string>,
): Promise<string | null> {
  const { data, error } = await db
    .from(T.projectConnections)
    .select('credentials_ref')
    .eq('project_id', projectId)
    .eq('provider', 'supabase')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    ctx.log(
      `No pudimos leer la conexión a tu base (${describeDbError(error)}). ` +
        'El análisis sigue, pero sin comprobar quién puede ver qué.',
    )
    return null
  }

  const credencial = (data as Record<string, unknown> | null)?.credentials_ref
  if (!credencial) return null

  try {
    const url = await descifrar(String(credencial))
    return url.trim() || null
  } catch (error) {
    ctx.log(
      `No pudimos leer la conexión a tu base guardada (${describeError(error)}). ` +
        'El análisis sigue, pero sin comprobar quién puede ver qué.',
    )
    return null
  }
}

/* ── Costo ────────────────────────────────────────────────────────────── */

function pesoPlain(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`
}

function costoDeIngesta(archivos: number | null, bytes: number): CostEntry {
  const gigas = bytes / (1024 * 1024 * 1024)
  return {
    category: 'storage',
    units: archivos ?? 0,
    unitLabel: 'archivos traídos',
    costUsd: storageCostUsd(gigas, 1),
    detail:
      archivos === null
        ? `Guardamos el código de tu proyecto (${pesoPlain(bytes)}) mientras dura el análisis.`
        : `Trajimos ${archivos.toLocaleString('es-AR')} archivo${archivos === 1 ? '' : 's'} de tu proyecto ` +
          `y guardamos una copia de ${pesoPlain(bytes)} mientras dura el análisis.`,
  }
}

/* ── Errores ──────────────────────────────────────────────────────────── */

const COPY_REPOSITORIO: Record<PublicRepoErrorCode, string> = {
  privado: ONBOARDING.erroresDeRepositorio.privado,
  no_existe: ONBOARDING.erroresDeRepositorio.noExiste,
  demasiados_intentos: ONBOARDING.erroresDeRepositorio.demasiadosIntentos,
  demasiado_grande: ONBOARDING.erroresDeRepositorio.demasiadoGrande,
  red: ONBOARDING.erroresDeRepositorio.noExiste,
}

/** Reintentar solo tiene sentido cuando el problema puede dejar de existir solo. */
const REINTENTABLE: Record<PublicRepoErrorCode, boolean> = {
  privado: false,
  no_existe: false,
  demasiados_intentos: true,
  demasiado_grande: false,
  red: true,
}

/**
 * Traduce lo que tiran los módulos de ingesta al vocabulario de la cola.
 * Todo lo que no reconoce pasa tal cual: tapar un error ajeno sería peor.
 */
export function traducirError(error: unknown): JobError {
  if (error instanceof JobError) return error

  if (error instanceof PublicRepoError) {
    return new JobError(COPY_REPOSITORIO[error.code], {
      retryable: REINTENTABLE[error.code],
      code: `repositorio_${error.code}`,
      cause: error,
    })
  }

  if (error instanceof ZipRejectedError) {
    // Su mensaje ya está escrito para el usuario, y volver a intentarlo con el
    // mismo archivo daría exactamente lo mismo.
    return new JobError(error.message, {
      retryable: false,
      code: `archivo_${error.code}`,
      cause: error,
    })
  }

  return new JobError(describeError(error), { retryable: true, cause: error })
}

/* ── Rutas ────────────────────────────────────────────────────────────── */

/**
 * Dónde se guarda el archivo comprimido de una corrida.
 * Derivada de la corrida: volver a correr sobrescribe en vez de acumular.
 */
export function rutaDelArchivo(orgId: string, projectId: string, analysisRunId: string): string {
  return `${orgId}/${projectId}/corridas/${analysisRunId}/codigo.zip`
}

/* ── Enganche ─────────────────────────────────────────────────────────── */

registerHandler('ingest_repo', crearHandlerIngestRepo())
