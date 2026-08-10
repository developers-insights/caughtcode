import 'server-only'

/**
 * Carpeta temporal donde vive el código descargado mientras dura una corrida.
 *
 * Regla del producto: el código del usuario desaparece cuando termina el trabajo.
 * Por eso todo pasa por `withWorkspace`, que borra aunque la corrida explote.
 *
 * Estructura: <raíz>/<projectId>/<runId>/code
 */

import { createHash } from 'node:crypto'
import { mkdir, rm, stat, readdir } from 'node:fs/promises'
import path from 'node:path'

import { env } from '@/lib/env'

const DEFAULT_DIR_NAME = '.caughtcode-storage'

/** Raíz de almacenamiento. Configurable por entorno para poder apuntarla a un disco efímero. */
export function storageRoot(): string {
  const configured = env.storageDir()
  if (configured) return path.resolve(configured)
  return path.join(process.cwd(), DEFAULT_DIR_NAME)
}

/**
 * Los ids vienen de la base (uuid), pero nunca confiamos en que sea así:
 * cualquier cosa rara se reduce a un hash y no puede escaparse de la raíz.
 */
function safeSegment(value: string): string {
  if (/^[A-Za-z0-9._-]{1,64}$/.test(value) && value !== '.' && value !== '..') return value
  return createHash('sha256').update(value).digest('hex').slice(0, 32)
}

export function projectRoot(projectId: string): string {
  return path.join(storageRoot(), safeSegment(projectId))
}

export function workspacePathFor(projectId: string, runId: string): string {
  return path.join(projectRoot(projectId), safeSegment(runId))
}

export interface Workspace {
  projectId: string
  runId: string
  /** Carpeta de la corrida. */
  root: string
  /** Donde se deja el código del usuario. */
  codeDir: string
  /** Carpeta para artefactos intermedios (grabaciones, capturas, resultados de etapa). */
  artifactsDir: string
  /** Resuelve una ruta dentro del workspace. Tira si intenta salirse. */
  resolve: (...segments: string[]) => string
  /** Borra la carpeta entera. Idempotente. */
  cleanup: () => Promise<void>
}

/** Impide que una ruta armada con datos externos se escape del workspace. */
export function resolveInside(baseDir: string, ...segments: string[]): string {
  const base = path.resolve(baseDir)
  const target = path.resolve(base, ...segments)
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error('La ruta apunta fuera de la carpeta de trabajo del proyecto.')
  }
  return target
}

export async function createWorkspace(projectId: string, runId: string): Promise<Workspace> {
  const root = workspacePathFor(projectId, runId)
  const codeDir = path.join(root, 'code')
  const artifactsDir = path.join(root, 'artifacts')
  await mkdir(codeDir, { recursive: true })
  await mkdir(artifactsDir, { recursive: true })

  return {
    projectId,
    runId,
    root,
    codeDir,
    artifactsDir,
    resolve: (...segments: string[]) => resolveInside(root, ...segments),
    cleanup: async () => {
      await rm(root, { recursive: true, force: true })
    },
  }
}

/**
 * Corre `fn` con un workspace y garantiza el borrado, haya fallado o no.
 * `keepOnError` sirve para depurar en local; en producción siempre se borra.
 */
export async function withWorkspace<T>(
  projectId: string,
  runId: string,
  fn: (workspace: Workspace) => Promise<T>,
  options: { keepOnError?: boolean } = {},
): Promise<T> {
  const workspace = await createWorkspace(projectId, runId)
  let failed = false
  try {
    return await fn(workspace)
  } catch (error) {
    failed = true
    throw error
  } finally {
    if (!(failed && options.keepOnError)) {
      await workspace.cleanup().catch(() => {
        // El borrado no puede tapar el error original de la corrida.
      })
    }
  }
}

export async function removeWorkspace(projectId: string, runId: string): Promise<void> {
  await rm(workspacePathFor(projectId, runId), { recursive: true, force: true })
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

/** Suma recursiva de bytes. Se usa para reportar cuánto liberó un borrado. */
export async function directorySize(target: string): Promise<number> {
  let total = 0
  const stack: string[] = [target]
  while (stack.length > 0) {
    const current = stack.pop() as string
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
      } else if (entry.isFile()) {
        try {
          total += (await stat(full)).size
        } catch {
          // Archivo que desapareció entre el listado y el stat: no suma.
        }
      }
    }
  }
  return total
}
