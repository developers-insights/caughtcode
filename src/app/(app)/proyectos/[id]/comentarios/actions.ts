'use server'

/**
 * Acciones de la pantalla de comentarios.
 *
 * Ninguna escribe en el proyecto del usuario. La de limpieza arma un plan y un
 * archivo de cambios; aplicarlo es siempre decisión de la persona, desde su
 * propia máquina.
 *
 * Cada acción vuelve a resolver el proyecto contra la base con la sesión de
 * quien la llama: el identificador que llega del navegador nunca se toma por
 * bueno.
 */

import type { CommentsViewModel } from '@/components/comments/model'
import type { CleanMode, CleanPlanView, Resultado } from '@/components/comments/model-clean'
import { enqueue } from '@/server/jobs'
import type { ScanCommentsPayload } from '@/server/comments/handlers'
import { requireSession } from '../../../current-org'
import { resolverProyecto } from './repo'
import { escanearProyecto, generarPlan } from './view-model'

const SIN_CODIGO =
  'Todavía no tenemos el código de este proyecto. Conectalo o subí el zip y volvemos a intentar.'
const SIN_ACCESO = 'No tenés acceso a este proyecto.'
const SIN_SESION = 'No pudimos verificar tu sesión. Volvé a entrar.'

export async function escanearComentarios(
  projectId: string,
): Promise<Resultado<CommentsViewModel>> {
  const acceso = await resolverProyecto(projectId)
  if (acceso.estado !== 'ok') return { ok: false, error: SIN_ACCESO }
  if (!acceso.repoPath) return { ok: false, error: SIN_CODIGO }

  try {
    return { ok: true, data: await escanearProyecto(acceso.repoPath) }
  } catch (e) {
    return {
      ok: false,
      error: `No pudimos terminar de revisar tu código. ${e instanceof Error ? e.message : ''}`.trim(),
    }
  }
}

export async function prepararLimpieza(
  projectId: string,
  opciones: { mode: CleanMode; excluidos: string[] },
): Promise<Resultado<CleanPlanView>> {
  const acceso = await resolverProyecto(projectId)
  if (acceso.estado !== 'ok') return { ok: false, error: SIN_ACCESO }
  if (!acceso.repoPath) return { ok: false, error: SIN_CODIGO }

  try {
    return { ok: true, data: await generarPlan(acceso.repoPath, opciones) }
  } catch (e) {
    return {
      ok: false,
      error: `No pudimos preparar el cambio. ${e instanceof Error ? e.message : ''}`.trim(),
    }
  }
}

export interface ActionResult {
  ok: boolean
  error?: string
}

/**
 * Pone en marcha una revisión de comentarios de verdad, en la cola de
 * trabajos (`scan_comments`). Es distinta de `escanearComentarios`: esa
 * corre al instante para que la pantalla tenga algo útil apenas se abre,
 * pero no queda guardada en ningún lado. Esta la deja anotada en
 * `comment_scans`, para que se pueda consultar después sin volver a
 * escanear el proyecto entero.
 *
 * Nota para quien conecte el botón: `CommentsScreen` (fuera de lo que este
 * frente puede tocar) todavía no tiene un prop para esto — hoy solo llama a
 * `onEscanear` y `onGenerarPlan`. Falta agregarle el manejador que llame a
 * esta acción.
 */
export async function encolarEscaneoDeComentarios(projectId: string): Promise<ActionResult> {
  const acceso = await resolverProyecto(projectId)
  if (acceso.estado !== 'ok') return { ok: false, error: SIN_ACCESO }
  if (!acceso.repoPath) return { ok: false, error: SIN_CODIGO }

  const { supabase, org } = await requireSession()
  if (!supabase) return { ok: false, error: SIN_SESION }

  try {
    await enqueue<ScanCommentsPayload>({
      orgId: org.id,
      projectId,
      kind: 'scan_comments',
      payload: { repoPath: acceso.repoPath },
    })
  } catch {
    return {
      ok: false,
      error: 'No pudimos poner en marcha la revisión de comentarios. Probá de nuevo en un minuto.',
    }
  }

  return { ok: true }
}
