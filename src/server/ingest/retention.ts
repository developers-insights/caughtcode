import 'server-only'

/**
 * Retención y borrado verificable del código del usuario.
 *
 * El producto promete que el código desaparece. Esa promesa se cumple acá, y se
 * cumple de forma comprobable: cada borrado devuelve un comprobante que dice qué
 * ruta se borró, cuánto ocupaba y si después de borrar realmente ya no está.
 *
 * Este módulo no habla con la base de datos a propósito: recibe la lista de
 * proyectos y sus días de retención por parámetro. Así se puede probar de verdad
 * y el frente de trabajos decide cuándo correrlo.
 */

import { readdir, rm } from 'node:fs/promises'
import path from 'node:path'

import {
  directorySize,
  pathExists,
  projectRoot,
  storageRoot,
  workspacePathFor,
} from './workspace'

/** Lo que trae `projects.retention_days` por defecto. */
export const DEFAULT_RETENTION_DAYS = 30

/** Techo duro: aunque el proyecto pida más, no guardamos código más de esto. */
export const MAX_RETENTION_DAYS = 90

const MS_PER_DAY = 24 * 60 * 60 * 1000

export interface DeletionReceipt {
  path: string
  /** Si había algo para borrar. */
  existedBefore: boolean
  bytesFreed: number
  deletedAt: string
  /** Se volvió a mirar el disco después de borrar y la carpeta ya no está. */
  verified: boolean
}

async function deletePath(target: string): Promise<DeletionReceipt> {
  const existedBefore = await pathExists(target)
  const bytesFreed = existedBefore ? await directorySize(target) : 0
  await rm(target, { recursive: true, force: true })
  const stillThere = await pathExists(target)
  return {
    path: target,
    existedBefore,
    bytesFreed,
    deletedAt: new Date().toISOString(),
    verified: !stillThere,
  }
}

/** Borra el código de una corrida puntual. Se llama al terminar el análisis. */
export function deleteRunCode(projectId: string, runId: string): Promise<DeletionReceipt> {
  return deletePath(workspacePathFor(projectId, runId))
}

/** Borra todo el código guardado de un proyecto. Se llama al borrar el proyecto o la cuenta. */
export function deleteProjectCode(projectId: string): Promise<DeletionReceipt> {
  return deletePath(projectRoot(projectId))
}

export interface RetainedProject {
  projectId: string
  /** `projects.retention_days`. */
  retentionDays?: number | null
  /** Última actividad del proyecto: fin de la última corrida, o su creación. */
  lastActivityAt: string | Date
}

export function effectiveRetentionDays(retentionDays?: number | null): number {
  if (retentionDays === null || retentionDays === undefined) return DEFAULT_RETENTION_DAYS
  if (!Number.isFinite(retentionDays) || retentionDays < 0) return DEFAULT_RETENTION_DAYS
  return Math.min(Math.floor(retentionDays), MAX_RETENTION_DAYS)
}

export function expiresAt(project: RetainedProject): Date {
  const last = new Date(project.lastActivityAt)
  return new Date(last.getTime() + effectiveRetentionDays(project.retentionDays) * MS_PER_DAY)
}

export function isExpired(project: RetainedProject, now: Date = new Date()): boolean {
  return expiresAt(project).getTime() <= now.getTime()
}

export interface PurgeReport {
  checked: number
  deleted: DeletionReceipt[]
  /** Carpetas en disco que ya no corresponden a ningún proyecto vivo. */
  orphans: DeletionReceipt[]
  bytesFreed: number
  /** Rutas que quedaron en disco pese al intento de borrado. Hay que mirarlas. */
  failed: string[]
}

/**
 * Borra el código de todos los proyectos vencidos y de las carpetas huérfanas.
 *
 * `projects` es la lista completa de proyectos vivos: lo que esté en disco y no
 * figure ahí se considera huérfano y también se borra. Si la lista viniera
 * incompleta borraríamos de más, así que `purgeOrphans` es opcional y viene
 * apagado por defecto.
 */
export async function purgeExpired(
  projects: RetainedProject[],
  options: { now?: Date; purgeOrphans?: boolean } = {},
): Promise<PurgeReport> {
  const now = options.now ?? new Date()
  const deleted: DeletionReceipt[] = []
  const orphans: DeletionReceipt[] = []
  const failed: string[] = []

  for (const project of projects) {
    if (!isExpired(project, now)) continue
    const receipt = await deleteProjectCode(project.projectId)
    if (receipt.existedBefore) deleted.push(receipt)
    if (!receipt.verified) failed.push(receipt.path)
  }

  if (options.purgeOrphans) {
    const known = new Set(projects.map((project) => path.basename(projectRoot(project.projectId))))
    let entries: string[] = []
    try {
      entries = (await readdir(storageRoot(), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    } catch {
      entries = []
    }
    for (const name of entries) {
      if (known.has(name)) continue
      const receipt = await deletePath(path.join(storageRoot(), name))
      if (receipt.existedBefore) orphans.push(receipt)
      if (!receipt.verified) failed.push(receipt.path)
    }
  }

  const bytesFreed =
    deleted.reduce((sum, item) => sum + item.bytesFreed, 0) +
    orphans.reduce((sum, item) => sum + item.bytesFreed, 0)

  return { checked: projects.length, deleted, orphans, bytesFreed, failed }
}

/** Comprueba desde afuera que una ruta ya no existe. Es la parte "verificable". */
export async function verifyDeleted(target: string): Promise<boolean> {
  return !(await pathExists(target))
}

/** Texto para mostrarle al usuario en la pantalla de privacidad. */
export function retentionSummary(retentionDays?: number | null): string {
  const days = effectiveRetentionDays(retentionDays)
  if (days === 0) return 'Tu código se borra apenas termina el análisis.'
  return `Tu código se borra apenas termina el análisis. Si algo queda guardado para reanudar un trabajo, se elimina a los ${days} días.`
}
