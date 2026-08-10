import 'server-only'

/**
 * Puente entre el motor de comentarios y la pantalla.
 *
 * El motor vive en `src/server/comments` y arrastra Node y el compilador de
 * TypeScript, así que nada de eso puede cruzar al navegador. Acá se corre, se
 * vuelve a enmascarar por las dudas y se arma un objeto de texto y números que
 * sí puede viajar.
 *
 * El enmascarado se aplica de nuevo aunque el motor ya lo haga. Es a propósito:
 * este es el último punto donde el valor completo de una clave podría escaparse
 * hacia la pantalla, y sería ridículo que la herramienta que avisa de una
 * filtración la reprodujera.
 */

import { cleanProject, maskSecrets, scanProject } from '@/server/comments'
import type { CommentHit, CommentScanResult } from '@/lib/types/domain'
import { construirModelo, type CommentsViewModel } from '@/components/comments/model'
import type { CleanMode, CleanPlanView } from '@/components/comments/model-clean'

/** Última red antes de la pantalla. Es idempotente: enmascarar dos veces no cambia nada. */
export function enmascararHit(hit: CommentHit): CommentHit {
  const seguro = maskSecrets(hit.text)
  return seguro === hit.text ? hit : { ...hit, text: seguro }
}

export function enmascararScan(scan: CommentScanResult): CommentScanResult {
  return { ...scan, hits: scan.hits.map(enmascararHit) }
}

export async function escanearProyecto(repoPath: string): Promise<CommentsViewModel> {
  return construirModelo(enmascararScan(await scanProject(repoPath)))
}

export interface OpcionesDeLimpieza {
  mode: CleanMode
  /** Rutas relativas que el usuario dejó afuera. */
  excluidos: string[]
}

export async function generarPlan(
  repoPath: string,
  { mode, excluidos }: OpcionesDeLimpieza,
): Promise<CleanPlanView> {
  // Sin exclusiones no hace falta la lista: el motor limpia todo lo que encuentra.
  let files: string[] | undefined
  if (excluidos.length > 0) {
    const scan = await scanProject(repoPath)
    const fuera = new Set(excluidos)
    files = [...new Set(scan.hits.map((h) => h.file))].filter((f) => !fuera.has(f))
  }

  const { plan, patch } = await cleanProject(repoPath, { mode, files })

  return {
    mode: plan.mode,
    files: plan.files,
    totalRemoved: plan.totalRemoved,
    totalKept: plan.totalKept,
    skipped: plan.skipped,
    patch,
  }
}
