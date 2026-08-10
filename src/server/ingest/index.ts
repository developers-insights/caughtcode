import 'server-only'

/**
 * Ingesta: de "una dirección o un archivo" a "el código del usuario en disco".
 *
 * Junta las piezas que ya existían sueltas —traer el archivo, abrirlo con el
 * extractor endurecido, descartar lo que no es código del usuario y reconocer
 * con qué está hecho el proyecto— en una sola operación con un resultado que se
 * puede contar: qué entró, qué quedó afuera y por qué.
 *
 * **No sabe nada de la cola de trabajos.** Eso vive en `handlers.ts`, al lado.
 * Acá no hay `jobs`, ni `analysis_runs`, ni Storage: se le pasa un proyecto, una
 * corrida y una fuente, y devuelve el resultado. Es lo que permite probarla sin
 * base de datos y reusarla desde el onboarding si algún día hace falta.
 */

import { readdir, rm, mkdir } from 'node:fs/promises'
import path from 'node:path'

import type { StackInfo } from '@/lib/types/domain'

import { IGNORE_MESSAGE, INGEST_LIMITS, type IgnoreCode } from './filters'
import {
  PublicRepoError,
  downloadPublicRepoArchive,
  parseGithubUrl,
  type RepoRef,
} from './github'
import { detectStack } from './stack'
import { createWorkspace, workspacePathFor, type Workspace } from './workspace'
import { extractZip, type ExtractResult, type SkippedEntry } from './zip'

/* ── Qué se puede ingerir ─────────────────────────────────────────────── */

export type FuenteIngesta =
  /** Un .zip: el que subió el usuario, o el que ya bajamos de GitHub. */
  | { tipo: 'archivo'; bytes: Uint8Array }
  /** Una dirección de GitHub. Solo repositorios públicos: no se manda credencial. */
  | { tipo: 'github'; url: string }

export interface ArchivoTraido {
  bytes: Uint8Array
  origen: 'archivo' | 'github'
  /** Qué repositorio y qué rama se trajo. `null` cuando vino como archivo. */
  repo: { owner: string; repo: string; ref: string | null } | null
}

export interface DependenciasIngesta {
  /** Solo para tests: reemplaza la bajada del repositorio público. */
  bajarRepoPublico?: (target: RepoRef) => Promise<Uint8Array>
}

/**
 * Consigue el archivo comprimido de la fuente que sea.
 *
 * Existe aparte de `ingestar()` porque quien llama muchas veces necesita los
 * bytes antes de descomprimirlos (para guardarlos, por ejemplo) y bajarlos dos
 * veces sería pagar dos veces lo mismo.
 */
export async function traerArchivo(
  fuente: FuenteIngesta,
  deps: DependenciasIngesta = {},
): Promise<ArchivoTraido> {
  if (fuente.tipo === 'archivo') {
    return { bytes: fuente.bytes, origen: 'archivo', repo: null }
  }

  const destino = parseGithubUrl(fuente.url)
  if (!destino) {
    // No salimos a la red con algo que no sabemos leer: sería pedirle un archivo
    // a un servidor cualquiera.
    throw new PublicRepoError(
      'no_existe',
      `La dirección "${fuente.url.slice(0, 200)}" no tiene forma de repositorio de GitHub.`,
    )
  }

  const bajar = deps.bajarRepoPublico ?? downloadPublicRepoArchive
  const bytes = await bajar(destino)
  return {
    bytes,
    origen: 'github',
    repo: { owner: destino.owner, repo: destino.repo, ref: destino.ref ?? null },
  }
}

/* ── Resultado ────────────────────────────────────────────────────────── */

export interface DescarteAgrupado {
  motivo: IgnoreCode
  cantidad: number
  /** Por qué quedó afuera, en castellano y sin jerga. */
  mensajePlain: string
  /** Hasta tres ejemplos, para que el usuario reconozca de qué estamos hablando. */
  ejemplos: string[]
}

export interface ResultadoIngesta {
  workspace: Workspace
  /** Carpeta donde quedó el código. Es lo que recibe el análisis. */
  codeDir: string
  /** Rutas relativas de lo que entró. */
  archivos: string[]
  fileCount: number
  totalBytes: number
  /** Tamaño del archivo comprimido que se procesó. */
  archivoBytes: number
  descartes: DescarteAgrupado[]
  /** Existen en el proyecto pero no guardamos su contenido (por ejemplo, un lockfile enorme). */
  presentesSinLeer: string[]
  /** Avisos para mostrarle al usuario. */
  avisos: string[]
  stack: StackInfo
  origen: 'archivo' | 'github'
  repo: ArchivoTraido['repo']
}

export interface IngestarInput {
  projectId: string
  /** Identifica la corrida: la carpeta se deriva de acá, así que correr dos veces sobrescribe. */
  runId: string
  fuente: FuenteIngesta
  /** `false` para conservar lo que ya hubiera en la carpeta. Por defecto se limpia. */
  limpiarAntes?: boolean
}

/** Dónde queda el código de una corrida. Se puede calcular sin tocar el disco. */
export function rutaDelCodigo(projectId: string, runId: string): string {
  return path.join(workspacePathFor(projectId, runId), 'code')
}

/** `true` si la carpeta tiene al menos un archivo adentro. */
export async function hayCodigoEnDisco(codeDir: string): Promise<boolean> {
  const pendientes: string[] = [codeDir]
  while (pendientes.length > 0) {
    const actual = pendientes.pop() as string
    let entradas
    try {
      entradas = await readdir(actual, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entrada of entradas) {
      if (entrada.isFile()) return true
      if (entrada.isDirectory()) pendientes.push(path.join(actual, entrada.name))
    }
  }
  return false
}

export function agruparDescartes(salteados: SkippedEntry[]): DescarteAgrupado[] {
  const porMotivo = new Map<IgnoreCode, DescarteAgrupado>()
  for (const salteado of salteados) {
    const existente = porMotivo.get(salteado.code)
    if (existente) {
      existente.cantidad += 1
      if (existente.ejemplos.length < 3) existente.ejemplos.push(salteado.path)
      continue
    }
    porMotivo.set(salteado.code, {
      motivo: salteado.code,
      cantidad: 1,
      mensajePlain: salteado.message || IGNORE_MESSAGE[salteado.code],
      ejemplos: [salteado.path],
    })
  }
  return [...porMotivo.values()].sort((a, b) => b.cantidad - a.cantidad)
}

/**
 * Trae el código, lo descomprime en la carpeta de la corrida y reconoce el stack.
 *
 * Idempotente por construcción: la carpeta se deriva de `runId`, y antes de
 * escribir se limpia. Correrla dos veces deja el resultado de la última, nunca
 * una mezcla de las dos.
 *
 * Todo lo que puede salir mal sale por excepción con mensaje ya escrito:
 * `ZipRejectedError` (archivo peligroso o inservible) o `PublicRepoError`
 * (no se pudo traer de GitHub).
 */
export async function ingestar(
  input: IngestarInput,
  deps: DependenciasIngesta = {},
): Promise<ResultadoIngesta> {
  const traido = await traerArchivo(input.fuente, deps)

  const workspace = await createWorkspace(input.projectId, input.runId)
  if (input.limpiarAntes !== false) {
    await rm(workspace.codeDir, { recursive: true, force: true })
    await mkdir(workspace.codeDir, { recursive: true })
  }

  const extraido: ExtractResult = await extractZip(traido.bytes, workspace.codeDir, {
    // Tanto el archivo de GitHub como el .zip que arma el usuario suelen venir
    // con todo adentro de una sola carpeta contenedora. Se saca sola.
    stripTopLevelDir: 'auto',
    maxArchiveBytes: INGEST_LIMITS.maxArchiveBytes,
  })

  const stack = await detectStack(workspace.codeDir, { extraPaths: extraido.presentButSkipped })

  return {
    workspace,
    codeDir: workspace.codeDir,
    archivos: extraido.files,
    fileCount: extraido.files.length,
    totalBytes: extraido.totalBytes,
    archivoBytes: traido.bytes.byteLength,
    descartes: agruparDescartes(extraido.skipped),
    presentesSinLeer: extraido.presentButSkipped,
    avisos: extraido.warnings,
    stack,
    origen: traido.origen,
    repo: traido.repo,
  }
}
