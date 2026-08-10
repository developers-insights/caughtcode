'use server'

/**
 * Onboarding: crear un proyecto desde un .zip o desde GitHub.
 *
 * Todo pasa en UNA sola llamada de servidor (subir, descomprimir, detectar
 * stack, contar pantallas, crear la fila, subir a Storage). Nada queda en
 * disco entre dos pedidos: en un entorno serverless dos invocaciones pueden
 * caer en instancias distintas, así que no hay disco compartido en el que
 * confiar de un paso al siguiente.
 */

import { revalidatePath } from 'next/cache'
import { nanoid } from 'nanoid'

import { createAdminClient } from '@/lib/supabase/admin'
import { encryptSecret } from '@/lib/crypto'
import { B, F, T } from '@/lib/db/tablas'
import type { StackInfo } from '@/lib/types/domain'
import type { ProjectRow } from '@/lib/types/database'
import { ONBOARDING } from '@/content/copy'
import { enqueue } from '@/server/jobs'
import { estimate } from '@/server/cost/ledger'
import { walkFiles } from '@/server/analysis/files'
import { detectRoutes, visitableRoutes } from '@/server/analysis/routes'
import { detectStack } from '@/server/ingest/stack'
import { createWorkspace, type Workspace } from '@/server/ingest/workspace'
import { extractZip, ZipRejectedError, type ExtractResult } from '@/server/ingest/zip'
import {
  GithubNotConfiguredError,
  PublicRepoError,
  downloadPublicRepoArchive,
  downloadRepoArchive,
  encodeConnection,
  githubStatus,
  listInstallationRepos,
  listInstallations,
  parseGithubUrl,
  resolveRef,
  type GithubInstallation,
  type GithubRepo,
} from '@/server/ingest/github'

import { requireSession } from '../../current-org'

export interface PreviewStats {
  fileCount: number
  totalBytes: number
  routeCount: number
  stack: StackInfo
  warnings: string[]
}

export interface CostSummary {
  costUsd: number
  summaryPlain: string
  unitsPlain: string[]
}

export type CreateProjectResult =
  | { ok: true; projectId: string; preview: PreviewStats; cost: CostSummary }
  | { ok: false; error: string }

export interface ActionResult {
  ok: boolean
  error?: string
}

/** Cuántos archivos mira `estimate()`: no tiene sentido cobrar por más. */
function costFiles(fileCount: number): number {
  return fileCount
}

async function analyzeWorkspace(workspace: Workspace, stack: StackInfo) {
  const walked = await walkFiles(workspace.codeDir)
  const routes = await detectRoutes(workspace.codeDir, { stack, files: walked.files })
  return { fileCount: walked.files.length, totalBytes: walked.totalBytes, routeCount: visitableRoutes(routes).length }
}

/**
 * Deshace la creación del proyecto si algo falla después de insertarlo
 * (ej. la subida a Storage). Mejor esfuerzo: si tampoco esto funciona, el
 * proyecto queda visible y se puede borrar a mano desde la lista.
 */
async function rollbackProject(projectId: string): Promise<void> {
  try {
    const admin = createAdminClient()
    await admin.rpc(F.deleteProjectCascade, { p_project_id: projectId })
  } catch {
    /* mejor esfuerzo */
  }
}

/* ── Subir un .zip ───────────────────────────────────────────────────────── */

export async function createProjectFromZipAction(formData: FormData): Promise<CreateProjectResult> {
  const file = formData.get('archivo')
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: 'No recibimos ningún archivo. Arrastrá el .zip de tu proyecto.' }
  }

  const { supabase, org } = await requireSession()
  if (!supabase) return { ok: false, error: 'No pudimos verificar tu sesión. Volvé a entrar.' }

  const nombreIngresado = String(formData.get('nombre') ?? '').trim()
  const name = nombreIngresado || file.name.replace(/\.zip$/i, '').trim() || 'Mi proyecto'

  const workspace = await createWorkspace(nanoid(), 'onboarding')

  try {
    const bytes = new Uint8Array(await file.arrayBuffer())

    let extracted: ExtractResult
    try {
      extracted = await extractZip(bytes, workspace.codeDir, { stripTopLevelDir: 'auto' })
    } catch (error) {
      if (error instanceof ZipRejectedError) return { ok: false, error: error.message }
      throw error
    }

    const stack = await detectStack(workspace.codeDir, { extraPaths: extracted.presentButSkipped })
    const { fileCount, totalBytes, routeCount } = await analyzeWorkspace(workspace, stack)

    const { data: project, error: insertError } = await supabase
      .from(T.projects)
      .insert({ org_id: org.id, name, source_type: 'zip', stack_detected: stack, retention_days: 30 })
      .select('id')
      .single()

    if (insertError || !project) {
      return { ok: false, error: 'No pudimos crear el proyecto. Probá de nuevo en un minuto.' }
    }

    try {
      const admin = createAdminClient()
      const storagePath = `${org.id}/${project.id}/source.zip`
      const { error: uploadError } = await admin.storage
        .from(B.repos)
        .upload(storagePath, bytes, { contentType: 'application/zip', upsert: true })
      if (uploadError) throw new Error(uploadError.message)

      const { error: updateError } = await supabase
        .from(T.projects)
        .update({ storage_path: storagePath })
        .eq('id', project.id)
      if (updateError) throw new Error(updateError.message)
    } catch {
      await rollbackProject(project.id)
      return { ok: false, error: 'Subimos tu código pero algo falló al guardarlo. Probá de nuevo.' }
    }

    const cost = estimate('full_audit', { files: costFiles(fileCount) })

    return {
      ok: true,
      projectId: project.id,
      preview: { fileCount, totalBytes, routeCount, stack, warnings: extracted.warnings },
      cost: { costUsd: cost.costUsd, summaryPlain: cost.summaryPlain, unitsPlain: cost.unitsPlain },
    }
  } finally {
    await workspace.cleanup()
  }
}

/* ── GitHub ──────────────────────────────────────────────────────────────── */

export interface GithubStatusResult {
  ready: boolean
  message: string
  installUrl: string | null
}

export async function getGithubStatusAction(): Promise<GithubStatusResult> {
  const status = githubStatus()
  return { ready: status.ready, message: status.message, installUrl: status.installUrl }
}

export type GithubInstallationsResult =
  | { ok: true; installations: GithubInstallation[] }
  | { ok: false; error: string }

export async function listGithubInstallationsAction(): Promise<GithubInstallationsResult> {
  try {
    const installations = await listInstallations()
    return { ok: true, installations }
  } catch (error) {
    if (error instanceof GithubNotConfiguredError) return { ok: false, error: error.message }
    return { ok: false, error: 'No pudimos conectar con GitHub. Probá de nuevo en un minuto.' }
  }
}

export type GithubReposResult = { ok: true; repos: GithubRepo[] } | { ok: false; error: string }

export async function listGithubReposAction(installationId: number): Promise<GithubReposResult> {
  try {
    const repos = await listInstallationRepos(installationId)
    return { ok: true, repos }
  } catch (error) {
    if (error instanceof GithubNotConfiguredError) return { ok: false, error: error.message }
    return { ok: false, error: 'No pudimos leer tus repositorios. Probá de nuevo en un minuto.' }
  }
}

export interface CreateFromGithubInput {
  installationId: number
  owner: string
  repo: string
  name?: string
}

export async function createProjectFromGithubAction(
  input: CreateFromGithubInput,
): Promise<CreateProjectResult> {
  const { supabase, org } = await requireSession()
  if (!supabase) return { ok: false, error: 'No pudimos verificar tu sesión. Volvé a entrar.' }

  let ref: { ref: string; sha: string }
  let bytes: Uint8Array
  try {
    const target = { installationId: input.installationId, owner: input.owner, repo: input.repo }
    ref = await resolveRef(target)
    bytes = await downloadRepoArchive({ ...target, ref: ref.ref })
  } catch (error) {
    if (error instanceof GithubNotConfiguredError) return { ok: false, error: error.message }
    return { ok: false, error: 'No pudimos traer el código desde GitHub. Probá de nuevo.' }
  }

  const name = input.name?.trim() || input.repo
  const workspace = await createWorkspace(nanoid(), 'onboarding')

  try {
    let extracted: ExtractResult
    try {
      extracted = await extractZip(bytes, workspace.codeDir, { stripTopLevelDir: 'auto' })
    } catch (error) {
      if (error instanceof ZipRejectedError) return { ok: false, error: error.message }
      throw error
    }

    const stack = await detectStack(workspace.codeDir, { extraPaths: extracted.presentButSkipped })
    const { fileCount, totalBytes, routeCount } = await analyzeWorkspace(workspace, stack)

    const { data: project, error: insertError } = await supabase
      .from(T.projects)
      .insert({
        org_id: org.id,
        name,
        source_type: 'github',
        repo_url: `https://github.com/${input.owner}/${input.repo}`,
        repo_ref: ref.sha,
        stack_detected: stack,
        retention_days: 30,
      })
      .select('id')
      .single()

    if (insertError || !project) {
      return { ok: false, error: 'No pudimos crear el proyecto. Probá de nuevo en un minuto.' }
    }

    try {
      const admin = createAdminClient()
      const storagePath = `${org.id}/${project.id}/${ref.sha}.zip`
      const { error: uploadError } = await admin.storage
        .from(B.repos)
        .upload(storagePath, bytes, { contentType: 'application/zip', upsert: true })
      if (uploadError) throw new Error(uploadError.message)

      const { error: updateError } = await supabase
        .from(T.projects)
        .update({ storage_path: storagePath })
        .eq('id', project.id)
      if (updateError) throw new Error(updateError.message)

      const { error: connError } = await supabase.from(T.projectConnections).insert({
        project_id: project.id,
        provider: 'github',
        credentials_ref: encodeConnection({
          installationId: input.installationId,
          owner: input.owner,
          repo: input.repo,
        }),
        scopes: ['contents:read', 'metadata:read'],
      })
      if (connError) throw new Error(connError.message)
    } catch {
      await rollbackProject(project.id)
      return { ok: false, error: 'Trajimos tu código pero algo falló al guardarlo. Probá de nuevo.' }
    }

    const cost = estimate('full_audit', { files: costFiles(fileCount) })

    return {
      ok: true,
      projectId: project.id,
      preview: { fileCount, totalBytes, routeCount, stack, warnings: extracted.warnings },
      cost: { costUsd: cost.costUsd, summaryPlain: cost.summaryPlain, unitsPlain: cost.unitsPlain },
    }
  } finally {
    await workspace.cleanup()
  }
}

/* ── Repositorio público (sin GitHub App) ───────────────────────────────── */

export type ValidatePublicRepoUrlResult = { ok: true; owner: string; repo: string } | { ok: false }

/**
 * Validación en vivo mientras el usuario escribe: corre el mismo parser que
 * usa el alta real (`parseGithubUrl`) pero no toca la red. Solo confirma que
 * la dirección tiene forma de repositorio de GitHub — "es privado", "no
 * existe", etc. solo se sabe al traer el código de verdad, en
 * `createProjectFromPublicUrlAction`.
 */
export async function validatePublicRepoUrlAction(url: string): Promise<ValidatePublicRepoUrlResult> {
  const target = parseGithubUrl(url)
  return target ? { ok: true, owner: target.owner, repo: target.repo } : { ok: false }
}

function publicRepoErrorMessage(error: PublicRepoError): string {
  switch (error.code) {
    case 'privado':
      return ONBOARDING.erroresDeRepositorio.privado
    case 'no_existe':
      return ONBOARDING.erroresDeRepositorio.noExiste
    case 'demasiados_intentos':
      return ONBOARDING.erroresDeRepositorio.demasiadosIntentos
    case 'demasiado_grande':
      return ONBOARDING.erroresDeRepositorio.demasiadoGrande
    default:
      // 'red': no hay frase dedicada en ONBOARDING.erroresDeRepositorio. Reusa
      // la misma frase de respaldo que ya usa este archivo para una falla de
      // red equivalente en el camino de GitHub App (ver createProjectFromGithubAction).
      return 'No pudimos traer el código desde GitHub. Probá de nuevo.'
  }
}

export interface CreateFromPublicUrlInput {
  url: string
  name?: string
}

/**
 * Crea un proyecto pegando la dirección de un repositorio público: sin
 * GitHub App, sin instalación, sin conexión guardada. A partir de acá, el
 * mismo camino que el `.zip` y el de la App: extraer, detectar stack, contar
 * pantallas, insertar la fila, subir a Storage.
 */
export async function createProjectFromPublicUrlAction(
  input: CreateFromPublicUrlInput,
): Promise<CreateProjectResult> {
  const { supabase, org } = await requireSession()
  if (!supabase) return { ok: false, error: 'No pudimos verificar tu sesión. Volvé a entrar.' }

  const target = parseGithubUrl(input.url)
  if (!target) return { ok: false, error: ONBOARDING.erroresDeRepositorio.direccionInvalida }

  let bytes: Uint8Array
  try {
    bytes = await downloadPublicRepoArchive(target)
  } catch (error) {
    if (error instanceof PublicRepoError) return { ok: false, error: publicRepoErrorMessage(error) }
    return { ok: false, error: 'No pudimos traer el código desde GitHub. Probá de nuevo.' }
  }

  const name = input.name?.trim() || target.repo
  const workspace = await createWorkspace(nanoid(), 'onboarding')

  try {
    let extracted: ExtractResult
    try {
      extracted = await extractZip(bytes, workspace.codeDir, { stripTopLevelDir: 'auto' })
    } catch (error) {
      if (error instanceof ZipRejectedError) return { ok: false, error: error.message }
      throw error
    }

    const stack = await detectStack(workspace.codeDir, { extraPaths: extracted.presentButSkipped })
    const { fileCount, totalBytes, routeCount } = await analyzeWorkspace(workspace, stack)

    const { data: project, error: insertError } = await supabase
      .from(T.projects)
      .insert({
        org_id: org.id,
        name,
        // Fuente propia: no hay credencial guardada ni instalación asociada,
        // y eso importa después para decidir si podemos volver a traer el
        // código. Habilitado en la migración 0011.
        source_type: 'github_public',
        repo_url: `https://github.com/${target.owner}/${target.repo}`,
        stack_detected: stack,
        retention_days: 30,
      })
      .select('id')
      .single()

    if (insertError || !project) {
      return { ok: false, error: 'No pudimos crear el proyecto. Probá de nuevo en un minuto.' }
    }

    try {
      const admin = createAdminClient()
      const storagePath = `${org.id}/${project.id}/source.zip`
      const { error: uploadError } = await admin.storage
        .from(B.repos)
        .upload(storagePath, bytes, { contentType: 'application/zip', upsert: true })
      if (uploadError) throw new Error(uploadError.message)

      const { error: updateError } = await supabase
        .from(T.projects)
        .update({ storage_path: storagePath })
        .eq('id', project.id)
      if (updateError) throw new Error(updateError.message)
    } catch {
      await rollbackProject(project.id)
      return { ok: false, error: 'Trajimos tu código pero algo falló al guardarlo. Probá de nuevo.' }
    }

    const cost = estimate('full_audit', { files: costFiles(fileCount) })

    return {
      ok: true,
      projectId: project.id,
      preview: { fileCount, totalBytes, routeCount, stack, warnings: extracted.warnings },
      cost: { costUsd: cost.costUsd, summaryPlain: cost.summaryPlain, unitsPlain: cost.unitsPlain },
    }
  } finally {
    await workspace.cleanup()
  }
}

/* ── Confirmar y arrancar la auditoría ──────────────────────────────────── */

export interface StartAuditInput {
  projectId: string
  deployedUrl?: string
  databaseUrl?: string
}

export async function startAuditAction(input: StartAuditInput): Promise<ActionResult> {
  const { supabase, org } = await requireSession()
  if (!supabase) return { ok: false, error: 'No pudimos verificar tu sesión. Volvé a entrar.' }

  const deployedUrl = input.deployedUrl?.trim()
  if (deployedUrl) {
    const { error } = await supabase
      .from(T.projects)
      .update({ deployed_url: deployedUrl })
      .eq('id', input.projectId)
    if (error) return { ok: false, error: 'No pudimos guardar la dirección publicada.' }
  }

  const databaseUrl = input.databaseUrl?.trim()
  if (databaseUrl) {
    const { error } = await supabase.from(T.projectConnections).insert({
      project_id: input.projectId,
      provider: 'supabase',
      credentials_ref: encryptSecret(databaseUrl),
      scopes: ['read'],
    })
    if (error) return { ok: false, error: 'No pudimos guardar la conexión a tu base.' }
  }

  // La corrida de análisis la crea el propio trabajo "ingest_repo" (tabla de
  // sistema: solo el worker escribe ahí). Acá solo lo encolamos.
  try {
    await enqueue({ orgId: org.id, projectId: input.projectId, kind: 'ingest_repo', payload: {} })
  } catch {
    return {
      ok: false,
      error: 'El proyecto quedó creado, pero no pudimos poner en marcha el análisis. Reintentá desde el proyecto.',
    }
  }

  revalidatePath('/proyectos')
  return { ok: true }
}
