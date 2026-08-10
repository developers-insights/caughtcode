import 'server-only'

/**
 * Descubrimiento de pantallas.
 *
 * Las rutas **ya son** las funcionalidades: en Next.js App Router cada `page.tsx`
 * es una pantalla real de la app. No hace falta que un modelo las adivine, es
 * mirar la carpeta (D13 / MEMORY). Determinístico y gratis.
 */

import path from 'node:path'

import type { RouteInfo, StackInfo } from '@/lib/types/domain'
import { readTextFile, walkFiles, type WalkedFile } from './files'

const PAGE_FILES = new Set(['page.tsx', 'page.ts', 'page.jsx', 'page.js'])
const LAYOUT_FILES = new Set(['layout.tsx', 'layout.ts', 'layout.jsx', 'layout.js'])
const ROUTE_FILES = new Set(['route.ts', 'route.js'])
const TEMPLATE_FILES = new Set(['template.tsx', 'template.jsx'])

/**
 * Señales de que una pantalla exige estar logueado.
 *
 * La heurística es a propósito explícita y conservadora: preferimos no marcar
 * una pantalla protegida antes que decir que lo está sin fundamento. Se usa como
 * pista para el agente de navegación, nunca como afirmación en un hallazgo.
 */
export const AUTH_CODE_SIGNALS = [
  'auth.getUser',
  'auth.getSession',
  'getServerSession',
  'getSession(',
  'currentUser(',
  'requireAuth',
  'requireUser',
  'useSession',
  'useUser',
  'withAuth',
  'redirect(\'/login\')',
  'redirect("/login")',
  'redirect(\'/ingresar\')',
  'protectedProcedure',
  'ensureAuthenticated',
] as const

/** Palabras que, como segmento de la URL, casi siempre indican zona privada. */
export const PROTECTED_PATH_WORDS = [
  'dashboard', 'panel', 'admin', 'account', 'cuenta', 'settings', 'configuracion', 'ajustes',
  'profile', 'perfil', 'billing', 'facturacion', 'suscripcion', 'onboarding',
  'private', 'privado', 'miembros', 'members', 'inbox', 'workspace',
] as const

/** Rutas que son públicas por naturaleza aunque toquen sesión (login, registro...). */
export const PUBLIC_PATH_WORDS = [
  'login', 'ingresar', 'signup', 'registro', 'register', 'signin', 'sign-in', 'sign-up',
  'reset', 'recuperar', 'olvide', 'forgot', 'verify', 'confirmar', 'callback',
  'pricing', 'precios', 'blog', 'legal', 'terminos', 'terms', 'privacidad', 'privacy',
] as const

/** Grupos de rutas que agrupan pantallas públicas, no privadas. */
const PUBLIC_GROUPS = new Set(['auth', 'marketing', 'public', 'legal', 'landing', 'site'])

export interface DetectRoutesOptions {
  stack?: StackInfo
  /** Se puede pasar el listado ya recorrido para no leer el disco dos veces. */
  files?: WalkedFile[]
}

interface FileInfo {
  relative: string
  absolute: string
  source: string
}

/* ── Derivación de la URL pública ─────────────────────────────────────────── */

function isRouteGroup(segment: string): boolean {
  return segment.startsWith('(') && segment.endsWith(')')
}

function isParallelSlot(segment: string): boolean {
  return segment.startsWith('@')
}

function isPrivateFolder(segment: string): boolean {
  return segment.startsWith('_')
}

function isInterceptor(segment: string): boolean {
  return segment.startsWith('(.)') || segment.startsWith('(..)') || segment.startsWith('(...)')
}

/**
 * Convierte la carpeta de un archivo del App Router en su URL.
 * `(marketing)/precios/page.tsx` → `/precios`. `blog/[slug]/page.tsx` → `/blog/[slug]`.
 */
export function appRoutePath(segments: string[]): { path: string; isDynamic: boolean } | null {
  const parts: string[] = []
  let isDynamic = false
  for (const segment of segments) {
    if (segment === '') continue
    if (isPrivateFolder(segment)) return null
    if (isInterceptor(segment)) continue
    if (isRouteGroup(segment)) continue
    if (isParallelSlot(segment)) continue
    if (segment.startsWith('[')) isDynamic = true
    parts.push(segment)
  }
  return { path: '/' + parts.join('/'), isDynamic }
}

/** `pages/blog/[slug].tsx` → `/blog/[slug]`; `pages/index.tsx` → `/`. */
export function pagesRoutePath(relativeToPagesDir: string): { path: string; isDynamic: boolean } | null {
  const withoutExtension = relativeToPagesDir.replace(/\.(tsx|ts|jsx|js)$/, '')
  const segments = withoutExtension.split('/')
  const last = segments[segments.length - 1]
  if (segments.some((segment) => segment.startsWith('_'))) return null
  if (last === 'index') segments.pop()
  const isDynamic = segments.some((segment) => segment.startsWith('['))
  return { path: '/' + segments.join('/'), isDynamic }
}

/* ── Heurística de "parece protegida" ─────────────────────────────────────── */

function looksProtectedFrom(
  routePath: string,
  groups: string[],
  sources: string[],
): boolean {
  const lower = routePath.toLowerCase()
  const segments = lower.split('/').filter(Boolean)

  if (segments.some((segment) => PUBLIC_PATH_WORDS.some((word) => segment === word))) return false
  if (groups.some((group) => PUBLIC_GROUPS.has(group.toLowerCase()))) return false
  if (routePath === '/') return false

  if (segments.some((segment) => PROTECTED_PATH_WORDS.some((word) => segment === word))) return true
  if (groups.some((group) => ['app', 'dashboard', 'protected', 'private', 'privado'].includes(group.toLowerCase()))) {
    return true
  }
  return sources.some((source) => AUTH_CODE_SIGNALS.some((signal) => source.includes(signal)))
}

function groupsOf(segments: string[]): string[] {
  return segments.filter(isRouteGroup).map((segment) => segment.slice(1, -1))
}

/* ── App Router ───────────────────────────────────────────────────────────── */

async function loadFile(root: string, relative: string): Promise<FileInfo> {
  const absolute = path.join(root, relative)
  return { relative, absolute, source: (await readTextFile(absolute)) ?? '' }
}

function isClientSource(source: string): boolean {
  return /^\s*(['"])use client\1\s*;?\s*$/m.test(source.slice(0, 2000))
}

async function detectAppRoutes(root: string, appDir: string, files: WalkedFile[]): Promise<RouteInfo[]> {
  const inside = files.filter((file) => file.relative.startsWith(appDir + '/'))
  if (inside.length === 0) return []

  const cache = new Map<string, FileInfo>()
  const read = async (relative: string): Promise<FileInfo> => {
    const cached = cache.get(relative)
    if (cached) return cached
    const info = await loadFile(root, relative)
    cache.set(relative, info)
    return info
  }

  // Layouts por carpeta: hacen falta para heredar 'use client' y las señales de sesión.
  const layoutByDir = new Map<string, string>()
  for (const file of inside) {
    const base = path.posix.basename(file.relative)
    if (LAYOUT_FILES.has(base) || TEMPLATE_FILES.has(base)) {
      layoutByDir.set(path.posix.dirname(file.relative), file.relative)
    }
  }

  const ancestorsOf = (dir: string): string[] => {
    const result: string[] = []
    let current = dir
    while (current.startsWith(appDir)) {
      const layout = layoutByDir.get(current)
      if (layout) result.push(layout)
      const parent = path.posix.dirname(current)
      if (parent === current) break
      current = parent
    }
    return result
  }

  const routes: RouteInfo[] = []

  for (const file of inside) {
    const base = path.posix.basename(file.relative)
    const isPage = PAGE_FILES.has(base)
    const isApi = ROUTE_FILES.has(base)
    const isLayout = LAYOUT_FILES.has(base)
    if (!isPage && !isApi && !isLayout) continue

    const dir = path.posix.dirname(file.relative)
    const segments = dir.slice(appDir.length).split('/').filter(Boolean)
    const derived = appRoutePath(segments)
    if (!derived) continue

    const own = await read(file.relative)
    const ancestorLayouts = await Promise.all(ancestorsOf(dir).map((relative) => read(relative)))

    const isClient =
      isApi ? false : isClientSource(own.source) || ancestorLayouts.some((layout) => isClientSource(layout.source))

    const sources = [own.source, ...ancestorLayouts.map((layout) => layout.source)]
    const looksProtected = looksProtectedFrom(derived.path, groupsOf(segments), sources)

    routes.push({
      path: derived.path,
      file: file.relative,
      kind: isApi ? 'api' : isLayout ? 'layout' : 'page',
      isDynamic: derived.isDynamic,
      isClient,
      looksProtected,
    })
  }

  return routes
}

/* ── Pages Router ─────────────────────────────────────────────────────────── */

async function detectPagesRoutes(root: string, pagesDir: string, files: WalkedFile[]): Promise<RouteInfo[]> {
  const inside = files.filter(
    (file) => file.relative.startsWith(pagesDir + '/') && /\.(tsx|ts|jsx|js)$/.test(file.relative),
  )
  const routes: RouteInfo[] = []

  for (const file of inside) {
    const relativeToPages = file.relative.slice(pagesDir.length + 1)
    const derived = pagesRoutePath(relativeToPages)
    if (!derived) continue

    const isApi = relativeToPages.startsWith('api/')
    const source = (await readTextFile(file.absolute)) ?? ''

    routes.push({
      path: derived.path === '' ? '/' : derived.path,
      file: file.relative,
      kind: isApi ? 'api' : 'page',
      isDynamic: derived.isDynamic,
      // En el Pages Router todo lo que no es API corre también en el navegador.
      isClient: !isApi,
      looksProtected: looksProtectedFrom(derived.path, [], [source]),
    })
  }

  return routes
}

/* ── react-router ─────────────────────────────────────────────────────────── */

const RE_ROUTE_ELEMENT = /<Route\s[^>]*?path\s*=\s*["'`]([^"'`]+)["'`]/g
const RE_ROUTE_OBJECT = /(?:^|[,{[])\s*path\s*:\s*["'`]([^"'`]+)["'`]/g

async function detectReactRouterRoutes(files: WalkedFile[]): Promise<RouteInfo[]> {
  const candidates = files.filter((file) => /\.(tsx|ts|jsx|js)$/.test(file.relative))
  const routes: RouteInfo[] = []
  const seen = new Set<string>()

  for (const file of candidates) {
    const source = await readTextFile(file.absolute)
    if (!source) continue
    if (!/from\s+['"]react-router(-dom)?['"]/.test(source)) continue

    const found = new Set<string>()
    for (const regex of [RE_ROUTE_ELEMENT, RE_ROUTE_OBJECT]) {
      regex.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = regex.exec(source)) !== null) found.add(match[1])
    }

    for (const raw of found) {
      const normalized = raw.startsWith('/') ? raw : `/${raw}`
      const key = `${normalized}::${file.relative}`
      if (seen.has(key)) continue
      seen.add(key)
      routes.push({
        path: normalized === '/*' ? '/*' : normalized,
        file: file.relative,
        kind: 'page',
        isDynamic: normalized.includes(':') || normalized.includes('*'),
        isClient: true,
        looksProtected: looksProtectedFrom(normalized, [], [source]),
      })
    }
  }

  return routes
}

/* ── Entrada pública ──────────────────────────────────────────────────────── */

function sortRoutes(routes: RouteInfo[]): RouteInfo[] {
  return routes.sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1
    return a.file < b.file ? -1 : a.file > b.file ? 1 : 0
  })
}

export async function detectRoutes(root: string, options: DetectRoutesOptions = {}): Promise<RouteInfo[]> {
  const files = options.files ?? (await walkFiles(root)).files
  const dirs = new Set(files.map((file) => file.relative.split('/').slice(0, -1).join('/')))

  const routes: RouteInfo[] = []

  for (const appDir of ['app', 'src/app']) {
    if ([...dirs].some((dir) => dir === appDir || dir.startsWith(appDir + '/'))) {
      routes.push(...(await detectAppRoutes(root, appDir, files)))
    }
  }

  for (const pagesDir of ['pages', 'src/pages']) {
    if ([...dirs].some((dir) => dir === pagesDir || dir.startsWith(pagesDir + '/'))) {
      routes.push(...(await detectPagesRoutes(root, pagesDir, files)))
    }
  }

  if (routes.length === 0 || options.stack?.routerKind === 'react-router') {
    routes.push(...(await detectReactRouterRoutes(files)))
  }

  return sortRoutes(routes)
}

/** Solo las pantallas visitables: lo que le sirve al agente de navegación. */
export function visitableRoutes(routes: RouteInfo[]): RouteInfo[] {
  return routes.filter((route) => route.kind === 'page' || route.kind === 'screen')
}
