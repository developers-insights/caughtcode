import 'server-only'

/**
 * Conexión con GitHub mediante una GitHub App de **solo lectura**.
 *
 * Por qué App y no OAuth: GitHub no ofrece un permiso de solo-lectura acotado a
 * repos privados puntuales vía OAuth (DECISIONS D19 / MEMORY). La App permite que
 * el usuario elija exactamente qué repositorios ve caughtcode, y nada más.
 *
 * Si faltan las variables de entorno de GitHub, nada explota: `githubStatus()`
 * devuelve el motivo en español y la app cae al camino de subir un .zip.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import { createAppAuth } from '@octokit/auth-app'
import { Octokit } from '@octokit/rest'

import { decryptSecret, encryptSecret } from '@/lib/crypto'
import { env } from '@/lib/env'
import { INGEST_LIMITS } from './filters'

export class GithubNotConfiguredError extends Error {
  readonly missing: string[]

  constructor(missing: string[]) {
    super(
      'La conexión con GitHub todavía no está configurada. Por ahora podés subir tu proyecto como archivo .zip.',
    )
    this.name = 'GithubNotConfiguredError'
    this.missing = missing
  }
}

export interface GithubStatus {
  ready: boolean
  /** Nombres de las variables que faltan. Para el equipo, no para el usuario. */
  missing: string[]
  /** Mensaje para mostrarle al usuario cuando no está listo. */
  message: string
  /** Link para instalar la app, si conocemos el slug. */
  installUrl: string | null
}

export function githubStatus(): GithubStatus {
  const config = env.github()
  const missing: string[] = []
  if (!config.appId) missing.push('GITHUB_APP_ID')
  if (!config.privateKey) missing.push('GITHUB_APP_PRIVATE_KEY')

  const ready = missing.length === 0
  return {
    ready,
    missing,
    message: ready
      ? 'Conexión con GitHub disponible.'
      : 'Todavía no podemos conectarnos a GitHub. Subí tu proyecto como archivo .zip y funciona igual.',
    installUrl: config.slug ? `https://github.com/apps/${config.slug}/installations/new` : null,
  }
}

function requireConfig() {
  const config = env.github()
  const status = githubStatus()
  if (!status.ready || !config.appId || !config.privateKey) {
    throw new GithubNotConfiguredError(status.missing)
  }
  return { appId: Number(config.appId), privateKey: config.privateKey }
}

/** Cliente autenticado como la App (sin acceso a repos todavía). */
export function createAppClient(): Octokit {
  const { appId, privateKey } = requireConfig()
  return new Octokit({ authStrategy: createAppAuth, auth: { appId, privateKey } })
}

/** Cliente autenticado como una instalación concreta: solo ve los repos que el usuario eligió. */
export function createInstallationClient(installationId: number): Octokit {
  const { appId, privateKey } = requireConfig()
  return new Octokit({ authStrategy: createAppAuth, auth: { appId, privateKey, installationId } })
}

export interface GithubInstallation {
  id: number
  accountLogin: string
  accountType: string
  /** true si el usuario le dio acceso a todos sus repos. */
  allRepositories: boolean
}

export async function listInstallations(): Promise<GithubInstallation[]> {
  const octokit = createAppClient()
  const { data } = await octokit.rest.apps.listInstallations({ per_page: 100 })
  return data.map((installation) => ({
    id: installation.id,
    accountLogin:
      (installation.account && 'login' in installation.account ? installation.account.login : null) ??
      'desconocido',
    accountType:
      installation.account && 'type' in installation.account ? String(installation.account.type) : 'User',
    allRepositories: installation.repository_selection === 'all',
  }))
}

export interface GithubRepo {
  id: number
  owner: string
  name: string
  fullName: string
  private: boolean
  defaultBranch: string
  /** Fecha del último push, para mostrar cuál está más fresco. */
  pushedAt: string | null
  sizeKb: number
}

export async function listInstallationRepos(installationId: number): Promise<GithubRepo[]> {
  const octokit = createInstallationClient(installationId)
  const repos: GithubRepo[] = []
  for (let page = 1; page <= 10; page++) {
    const { data } = await octokit.rest.apps.listReposAccessibleToInstallation({ per_page: 100, page })
    for (const repo of data.repositories) {
      repos.push({
        id: repo.id,
        owner: repo.owner.login,
        name: repo.name,
        fullName: repo.full_name,
        private: repo.private,
        defaultBranch: repo.default_branch,
        pushedAt: repo.pushed_at ?? null,
        sizeKb: repo.size ?? 0,
      })
    }
    if (data.repositories.length < 100) break
  }
  return repos
}

export interface RepoRef {
  /**
   * Instalación de la GitHub App. **Opcional**: los repositorios públicos se
   * bajan sin ninguna credencial y no tienen instalación asociada.
   */
  installationId?: number
  owner: string
  repo: string
  /** Rama, tag o sha. Si falta, se usa la rama por defecto. */
  ref?: string
}

/** Las funciones que hablan como la App sí necesitan la instalación. */
function requireInstallation(target: RepoRef): number {
  if (typeof target.installationId !== 'number') {
    throw new GithubNotConfiguredError(['installationId'])
  }
  return target.installationId
}

/** Resuelve el sha exacto que se va a analizar, para que el hallazgo quede fechado. */
export async function resolveRef(target: RepoRef): Promise<{ ref: string; sha: string }> {
  const octokit = createInstallationClient(requireInstallation(target))
  const ref = target.ref ?? (await octokit.rest.repos.get({ owner: target.owner, repo: target.repo })).data.default_branch
  const { data } = await octokit.rest.repos.getCommit({
    owner: target.owner,
    repo: target.repo,
    ref,
    mediaType: { format: 'sha' },
  })
  const sha = typeof data === 'string' ? data : data.sha
  return { ref, sha }
}

/**
 * Baja el código de un ref como archivo comprimido.
 *
 * Usamos el `zipball` y no el `tarball` a propósito: así el código de GitHub
 * pasa por el mismo extractor endurecido que el zip que sube el usuario
 * (`extractZip`), en vez de tener dos caminos de descompresión con dos
 * conjuntos de defensas distintos.
 *
 * Ojo: el zip de GitHub envuelve todo en una carpeta `owner-repo-sha/`.
 * `extractZip` la saca sola con `stripTopLevelDir: 'auto'`.
 */
export async function downloadRepoArchive(target: RepoRef): Promise<Uint8Array> {
  const octokit = createInstallationClient(requireInstallation(target))
  const ref = target.ref ?? (await octokit.rest.repos.get({ owner: target.owner, repo: target.repo })).data.default_branch

  const response = await octokit.request('GET /repos/{owner}/{repo}/zipball/{ref}', {
    owner: target.owner,
    repo: target.repo,
    ref,
  })

  const data = response.data as unknown
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  throw new Error('GitHub devolvió el código en un formato que no esperábamos.')
}

/* ── Repositorios públicos, sin instalar nada ─────────────────────────────── */

/**
 * El camino anónimo existe por una razón concreta: instalar una GitHub App es
 * una fricción enorme para alguien que solo quiere ver si su app está bien. Si
 * el repositorio es público no hace falta nada de eso — se baja el archivo
 * comprimido de la API pública y listo.
 *
 * Límite conocido: GitHub permite 60 consultas por hora por dirección IP sin
 * credencial. Alcanza de sobra para probar y para el uso normal de una persona;
 * cuando eso se agote, el error lo dice y el usuario puede subir un .zip.
 */

export type PublicRepoErrorCode =
  | 'privado'
  | 'no_existe'
  | 'demasiados_intentos'
  | 'demasiado_grande'
  | 'red'

/**
 * Falla al traer un repositorio público, con la causa ya clasificada.
 *
 * El `message` es para el log del worker: dice el estado que devolvió GitHub y
 * qué se pidió. **El texto que ve el usuario no vive acá**, lo elige la interfaz
 * a partir del `code` (`src/content/copy.ts`).
 */
export class PublicRepoError extends Error {
  readonly code: PublicRepoErrorCode

  constructor(code: PublicRepoErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'PublicRepoError'
    this.code = code
  }
}

/** `fetch` que se usa contra GitHub. Se reemplaza en los tests. */
let githubFetch: typeof fetch | null = null

/** Solo para tests: cambia el `fetch` que se usa contra GitHub. `null` restaura el real. */
export function setGithubFetch(impl: typeof fetch | null): void {
  githubFetch = impl
}

function pedir(url: string, init: RequestInit = {}): Promise<Response> {
  const impl = githubFetch ?? fetch
  return impl(url, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'caughtcode',
      'x-github-api-version': '2022-11-28',
      ...(init.headers ?? {}),
    },
  })
}

const DUENO_VALIDO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const REPO_VALIDO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

/**
 * Convierte lo que el usuario pegó en `{ owner, repo, ref }`.
 *
 * Tolerante a propósito: acepta la dirección del navegador, con o sin `.git`,
 * con o sin barra final, con `/tree/<rama>`, la forma corta `usuario/proyecto` y
 * la dirección de clonar por ssh. Devuelve `null` si no es GitHub o si los
 * nombres no tienen forma de nombre — no queremos que una ruta rara termine
 * armando una URL a cualquier otro lado.
 */
export function parseGithubUrl(raw: string): RepoRef | null {
  if (typeof raw !== 'string') return null
  let texto = raw.trim()
  if (texto.length === 0 || texto.length > 400) return null

  // Dirección de clonar por ssh: git@github.com:owner/repo.git
  texto = texto.replace(/^git@github\.com:/i, 'github.com/')
  // Protocolo, si vino.
  texto = texto.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  texto = texto.replace(/^www\./i, '')

  // Cortamos parámetros y ancla antes de mirar los segmentos.
  texto = texto.split('#')[0].split('?')[0]

  if (/^github\.com(\/|$)/i.test(texto)) {
    texto = texto.slice('github.com'.length)
  } else if (/^[^/]*\./.test(texto)) {
    // Tiene otro host: no es GitHub.
    return null
  }

  const segmentos = texto.split('/').filter((parte) => parte.length > 0)
  if (segmentos.length < 2) return null

  const owner = segmentos[0]
  const repo = segmentos[1].replace(/\.git$/i, '')
  if (!DUENO_VALIDO.test(owner)) return null
  if (!REPO_VALIDO.test(repo) || repo === '.' || repo === '..') return null

  const referencia =
    segmentos[2] === 'tree' && segmentos.length > 3
      ? segmentos
          .slice(3)
          .map((parte) => decodeURIComponent(parte))
          .join('/')
      : null

  // Una rama con `..` o barras invertidas no es una rama: es un intento de armar
  // otra ruta. Mejor tratar la dirección como inválida que pedirle algo raro a GitHub.
  if (referencia !== null) {
    if (referencia.length === 0) return { owner, repo }
    if (/(^|\/)\.\.(\/|$)/.test(referencia) || referencia.includes('\\')) return null
    return { owner, repo, ref: referencia }
  }

  return { owner, repo }
}

function codificarRef(ref: string): string {
  return ref
    .split('/')
    .map((parte) => encodeURIComponent(parte))
    .join('/')
}

function frenadoPorGithub(response: Response): boolean {
  if (response.status === 429) return true
  return response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0'
}

/** ¿Existe la cuenta dueña del repositorio? Es la única evidencia que podemos juntar. */
async function existeElDueno(owner: string): Promise<boolean> {
  for (const url of [
    `https://api.github.com/users/${encodeURIComponent(owner)}`,
    `https://api.github.com/orgs/${encodeURIComponent(owner)}`,
  ]) {
    try {
      const response = await pedir(url)
      if (response.ok) return true
    } catch {
      // Si no podemos comprobarlo, no inventamos: seguimos con el otro intento.
    }
  }
  return false
}

async function leerConTope(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declarado = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declarado) && declarado > maxBytes) {
    throw new PublicRepoError(
      'demasiado_grande',
      `GitHub declaró ${declarado} bytes y el máximo que traemos es ${maxBytes}.`,
    )
  }

  const cuerpo = response.body
  if (!cuerpo || typeof cuerpo.getReader !== 'function') {
    const buffer = new Uint8Array(await response.arrayBuffer())
    if (buffer.byteLength > maxBytes) {
      throw new PublicRepoError(
        'demasiado_grande',
        `El archivo bajado ocupa ${buffer.byteLength} bytes y el máximo es ${maxBytes}.`,
      )
    }
    return buffer
  }

  // Vamos leyendo de a pedazos: si el tamaño declarado mentía, cortamos ahí
  // mismo en vez de terminar con el disco lleno.
  const lector = cuerpo.getReader()
  const pedazos: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await lector.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) {
        throw new PublicRepoError(
          'demasiado_grande',
          `El archivo superó los ${maxBytes} bytes mientras se bajaba.`,
        )
      }
      pedazos.push(value)
    }
  } finally {
    await lector.cancel().catch(() => {
      // Cancelar es mejor esfuerzo: no puede tapar el error de arriba.
    })
  }

  const salida = new Uint8Array(total)
  let offset = 0
  for (const pedazo of pedazos) {
    salida.set(pedazo, offset)
    offset += pedazo.byteLength
  }
  return salida
}

export interface DownloadPublicOptions {
  /** Tope de bytes a traer. Por defecto, el mismo que el del .zip que sube el usuario. */
  maxBytes?: number
}

/**
 * Baja el código de un repositorio **público** como archivo comprimido, sin
 * ninguna credencial.
 *
 * Sale por `zipball` (y no `tarball`) a propósito: así el código de GitHub pasa
 * por el mismo extractor endurecido que el .zip que sube el usuario, en vez de
 * tener dos caminos de descompresión con dos conjuntos de defensas distintos.
 */
export async function downloadPublicRepoArchive(
  target: RepoRef,
  options: DownloadPublicOptions = {},
): Promise<Uint8Array> {
  const maxBytes = options.maxBytes ?? INGEST_LIMITS.maxArchiveBytes
  const url =
    `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/zipball` +
    (target.ref ? `/${codificarRef(target.ref)}` : '')

  let response: Response
  try {
    response = await pedir(url)
  } catch (error) {
    throw new PublicRepoError(
      'red',
      `No se pudo conectar con GitHub para pedir ${target.owner}/${target.repo}.`,
      { cause: error },
    )
  }

  if (response.ok) return leerConTope(response, maxBytes)

  if (frenadoPorGithub(response)) {
    throw new PublicRepoError(
      'demasiados_intentos',
      `GitHub respondió ${response.status} por límite de consultas anónimas al pedir ${target.owner}/${target.repo}.`,
    )
  }

  if (response.status === 404 || response.status === 403 || response.status === 451) {
    // GitHub responde 404 tanto si el repositorio no existe como si es privado:
    // no distingue, a propósito, para no filtrar qué repositorios privados hay.
    // La única evidencia que podemos juntar es si la cuenta dueña existe. Si
    // existe, lo honesto es tratarlo como un problema de permisos (y ofrecer
    // conectar la cuenta); si no existe, la dirección está mal escrita.
    const dueno = await existeElDueno(target.owner)
    throw new PublicRepoError(
      dueno ? 'privado' : 'no_existe',
      `GitHub respondió ${response.status} al pedir el archivo de ${target.owner}/${target.repo}` +
        `${target.ref ? ` (rama ${target.ref})` : ''}. La cuenta ${target.owner} ${dueno ? 'existe' : 'no existe'}.`,
    )
  }

  throw new PublicRepoError(
    'red',
    `GitHub respondió ${response.status} al pedir el archivo de ${target.owner}/${target.repo}.`,
  )
}

/* ── Webhooks ─────────────────────────────────────────────────────────────── */

/**
 * Verifica la firma de un webhook de GitHub.
 * Compara en tiempo constante: una comparación normal filtra información.
 */
export function verifyWebhookSignature(rawBody: string | Buffer, signatureHeader: string | null): boolean {
  const secret = env.github().webhookSecret
  if (!secret) return false
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false

  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex')
  const received = Buffer.from(signatureHeader, 'utf8')
  const computed = Buffer.from(expected, 'utf8')
  if (received.length !== computed.length) return false
  return timingSafeEqual(received, computed)
}

/* ── Credenciales guardadas ───────────────────────────────────────────────── */

export interface StoredGithubConnection {
  installationId: number
  owner: string
  repo: string
}

/** Lo que se guarda en `project_connections.credentials_ref`, siempre cifrado. */
export function encodeConnection(connection: StoredGithubConnection): string {
  return encryptSecret(JSON.stringify(connection))
}

export function decodeConnection(credentialsRef: string): StoredGithubConnection {
  const parsed = JSON.parse(decryptSecret(credentialsRef)) as StoredGithubConnection
  if (typeof parsed.installationId !== 'number' || !parsed.owner || !parsed.repo) {
    throw new Error('La conexión con GitHub guardada está incompleta. Volvé a conectar el repositorio.')
  }
  return parsed
}

/** Permisos que pide la App. Solo lectura, sin excepciones. */
export const REQUIRED_PERMISSIONS = {
  contents: 'read',
  metadata: 'read',
} as const
