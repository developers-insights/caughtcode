import 'server-only'

/**
 * Detección de stack por lockfiles y archivos marcadores.
 *
 * Todo lo que devuelve queda justificado en `evidence`: cada línea dice qué
 * archivo probó qué. Sin adivinanzas y sin LLM — esto es un `stat` del disco.
 */

import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

import type { StackFramework, StackInfo } from '@/lib/types/domain'

interface PackageJson {
  name?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  packageManager?: string
}

export interface DetectStackOptions {
  /**
   * Rutas que existen en el proyecto pero cuyo contenido no guardamos
   * (por ejemplo un lockfile enorme). Cuentan para la detección por nombre.
   */
  extraPaths?: string[]
}

async function exists(root: string, relative: string): Promise<boolean> {
  try {
    await stat(path.join(root, relative))
    return true
  } catch {
    return false
  }
}

async function readText(root: string, relative: string): Promise<string | null> {
  try {
    return await readFile(path.join(root, relative), 'utf8')
  } catch {
    return null
  }
}

async function firstExisting(
  root: string,
  candidates: string[],
  extra: Set<string>,
): Promise<string | null> {
  for (const candidate of candidates) {
    if (extra.has(candidate)) return candidate
    if (await exists(root, candidate)) return candidate
  }
  return null
}

const NEXT_CONFIGS = ['next.config.ts', 'next.config.js', 'next.config.mjs', 'next.config.cjs']
const VITE_CONFIGS = ['vite.config.ts', 'vite.config.js', 'vite.config.mjs']
const ASTRO_CONFIGS = ['astro.config.mjs', 'astro.config.ts', 'astro.config.js']
const TAILWIND_CONFIGS = ['tailwind.config.ts', 'tailwind.config.js', 'tailwind.config.mjs', 'tailwind.config.cjs']

export async function detectStack(root: string, options: DetectStackOptions = {}): Promise<StackInfo> {
  const extra = new Set(options.extraPaths ?? [])
  const evidence: string[] = []

  const packageJsonRaw = await readText(root, 'package.json')
  let pkg: PackageJson = {}
  if (packageJsonRaw) {
    try {
      pkg = JSON.parse(packageJsonRaw) as PackageJson
      evidence.push('package.json → es un proyecto de JavaScript o TypeScript')
    } catch {
      evidence.push('package.json → está presente pero tiene un error de formato y no se pudo leer')
    }
  }

  const deps: Record<string, string> = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
    ...(pkg.peerDependencies ?? {}),
  }
  const hasDep = (name: string) => Object.prototype.hasOwnProperty.call(deps, name)

  /* ── Framework ────────────────────────────────────────────────────────── */

  let framework: StackFramework = 'unknown'
  let routerKind: StackInfo['routerKind'] = 'unknown'

  const pubspec = await readText(root, 'pubspec.yaml')
  const nextConfig = await firstExisting(root, NEXT_CONFIGS, extra)

  if (pubspec !== null) {
    framework = 'flutter'
    evidence.push('pubspec.yaml → es un proyecto Flutter o Dart')
    if (/\bgo_router\s*:/.test(pubspec)) {
      routerKind = 'go_router'
      evidence.push('pubspec.yaml declara go_router → las pantallas se definen con go_router')
    }
  } else if (nextConfig || hasDep('next')) {
    framework = 'nextjs'
    evidence.push(
      nextConfig
        ? `${nextConfig} → es una app Next.js`
        : 'package.json declara la dependencia next → es una app Next.js',
    )
  } else if (hasDep('@remix-run/react') || hasDep('@remix-run/node')) {
    framework = 'remix'
    evidence.push('package.json declara @remix-run → es una app Remix')
  } else if (hasDep('astro') || (await firstExisting(root, ASTRO_CONFIGS, extra))) {
    framework = 'astro'
    evidence.push('astro.config → es un sitio Astro')
  } else if (await firstExisting(root, VITE_CONFIGS, extra)) {
    framework = 'vite'
    evidence.push('vite.config → el proyecto se compila con Vite')
    if (hasDep('react')) evidence.push('package.json declara react → la interfaz está hecha con React')
  } else if (hasDep('react')) {
    framework = 'react'
    evidence.push('package.json declara react → la interfaz está hecha con React')
  } else if (
    (await exists(root, 'pyproject.toml')) ||
    (await exists(root, 'requirements.txt')) ||
    (await exists(root, 'manage.py'))
  ) {
    framework = 'python'
    evidence.push('pyproject.toml o requirements.txt → es un proyecto Python')
  } else if (packageJsonRaw !== null) {
    framework = 'node'
    evidence.push('package.json sin framework de interfaz conocido → es un proyecto Node')
  }

  /* ── Tipo de ruteo ────────────────────────────────────────────────────── */

  if (routerKind === 'unknown') {
    const appDir = await firstExisting(root, ['app/layout.tsx', 'app/layout.js', 'src/app/layout.tsx', 'src/app/layout.js'], extra)
    const pagesDir = await firstExisting(root, ['pages/_app.tsx', 'pages/_app.js', 'src/pages/_app.tsx', 'src/pages/_app.js'], extra)
    const appDirLoose = appDir ?? (await firstExisting(root, ['app/page.tsx', 'app/page.js', 'src/app/page.tsx', 'src/app/page.js'], extra))
    const pagesDirLoose = pagesDir ?? (await firstExisting(root, ['pages/index.tsx', 'pages/index.js', 'src/pages/index.tsx', 'src/pages/index.js'], extra))

    if (appDirLoose) {
      routerKind = 'app'
      evidence.push(`${appDirLoose} → las pantallas se definen con la carpeta app`)
    } else if (pagesDirLoose) {
      routerKind = 'pages'
      evidence.push(`${pagesDirLoose} → las pantallas se definen con la carpeta pages`)
    } else if (hasDep('react-router-dom') || hasDep('react-router')) {
      routerKind = 'react-router'
      evidence.push('package.json declara react-router → las pantallas se definen en código con react-router')
    }
  }

  /* ── Lenguaje ─────────────────────────────────────────────────────────── */

  let language: StackInfo['language'] = 'unknown'
  const hasTsconfig = (await exists(root, 'tsconfig.json')) || extra.has('tsconfig.json')
  if (framework === 'flutter') {
    language = 'dart'
    evidence.push('pubspec.yaml → el código está en Dart')
  } else if (framework === 'python') {
    language = 'python'
  } else if (hasTsconfig || hasDep('typescript')) {
    language = 'typescript'
    evidence.push(hasTsconfig ? 'tsconfig.json → el código está en TypeScript' : 'package.json declara typescript → el código está en TypeScript')
  } else if (packageJsonRaw !== null) {
    language = 'javascript'
  }

  /* ── Gestor de paquetes ───────────────────────────────────────────────── */

  let packageManager: StackInfo['packageManager'] = 'unknown'
  const lockfile = await firstExisting(
    root,
    ['pnpm-lock.yaml', 'bun.lockb', 'bun.lock', 'yarn.lock', 'package-lock.json', 'pubspec.lock', 'poetry.lock'],
    extra,
  )
  if (lockfile === 'pnpm-lock.yaml') packageManager = 'pnpm'
  else if (lockfile === 'bun.lockb' || lockfile === 'bun.lock') packageManager = 'bun'
  else if (lockfile === 'yarn.lock') packageManager = 'yarn'
  else if (lockfile === 'package-lock.json') packageManager = 'npm'
  else if (lockfile === 'pubspec.lock') packageManager = 'pub'
  else if (lockfile === 'poetry.lock') packageManager = 'pip'
  else if (framework === 'python') packageManager = 'pip'
  else if (framework === 'flutter') packageManager = 'pub'
  else if (pkg.packageManager?.startsWith('pnpm')) packageManager = 'pnpm'
  else if (pkg.packageManager?.startsWith('yarn')) packageManager = 'yarn'
  else if (packageJsonRaw !== null) packageManager = 'npm'

  if (lockfile) evidence.push(`${lockfile} → las dependencias se instalan con ${packageManager}`)

  /* ── Backends ─────────────────────────────────────────────────────────── */

  const backends: StackInfo['backends'] = []
  const addBackend = (backend: StackInfo['backends'][number], why: string) => {
    if (!backends.includes(backend)) {
      backends.push(backend)
      evidence.push(why)
    }
  }

  if (hasDep('@supabase/supabase-js') || hasDep('@supabase/ssr')) {
    addBackend('supabase', 'package.json declara @supabase → los datos y las cuentas viven en Supabase')
  } else if (await exists(root, 'supabase/config.toml')) {
    addBackend('supabase', 'supabase/config.toml → el proyecto usa Supabase')
  } else if (pubspec !== null && /\bsupabase_flutter\s*:/.test(pubspec)) {
    addBackend('supabase', 'pubspec.yaml declara supabase_flutter → los datos viven en Supabase')
  }

  if (hasDep('firebase') || hasDep('firebase-admin') || (await exists(root, 'firebase.json'))) {
    addBackend('firebase', 'firebase.json o la dependencia firebase → el proyecto usa Firebase')
  } else if (pubspec !== null && /\bfirebase_core\s*:/.test(pubspec)) {
    addBackend('firebase', 'pubspec.yaml declara firebase_core → el proyecto usa Firebase')
  }

  if ((await exists(root, 'prisma/schema.prisma')) || hasDep('@prisma/client') || hasDep('prisma')) {
    addBackend('prisma', 'prisma/schema.prisma → la base de datos se define con Prisma')
  }
  if (hasDep('drizzle-orm')) {
    addBackend('drizzle', 'package.json declara drizzle-orm → la base de datos se define con Drizzle')
  }
  if (hasDep('pg') || hasDep('postgres') || hasDep('@neondatabase/serverless')) {
    addBackend('postgres', 'package.json declara un cliente de Postgres → hay una base Postgres directa')
  }
  if (hasDep('mongodb') || hasDep('mongoose')) {
    addBackend('mongodb', 'package.json declara mongodb o mongoose → los datos viven en MongoDB')
  }
  if (backends.length === 0) backends.push('none')

  /* ── Extras ───────────────────────────────────────────────────────────── */

  const tailwindConfig = await firstExisting(root, TAILWIND_CONFIGS, extra)
  const hasTailwind =
    hasDep('tailwindcss') || hasDep('@tailwindcss/postcss') || tailwindConfig !== null
  if (hasTailwind) {
    evidence.push(
      tailwindConfig ? `${tailwindConfig} → los estilos usan Tailwind` : 'package.json declara tailwindcss → los estilos usan Tailwind',
    )
  }

  if (evidence.length === 0) {
    evidence.push('No encontramos archivos que identifiquen la tecnología del proyecto.')
  }

  return {
    framework,
    language,
    packageManager,
    backends,
    hasTypescript: language === 'typescript' || hasTsconfig,
    hasTailwind,
    routerKind,
    evidence,
  }
}
