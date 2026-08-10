/**
 * Recorrido del repo del usuario.
 *
 * Se saltea lo que no es código suyo (dependencias, builds), lo que no se puede
 * leer como texto (binarios) y lo que es demasiado grande para tratar en
 * memoria. El `.gitignore` se respeta porque lo ignorado normalmente es
 * generado: limpiarle comentarios a un artefacto de build no sirve de nada.
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

/** Archivos más grandes que esto no se analizan. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024

const ALWAYS_SKIP = new Set([
  '.git',
  'node_modules',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.vercel',
  '.cache',
  'dist',
  'build',
  'out',
  'coverage',
  'vendor',
  '.venv',
  'venv',
  '__pycache__',
  'Pods',
  '.dart_tool',
  '.gradle',
])

const SUPPORTED = /\.(m|c)?[jt]sx?$|\.(css|scss|sass|less|styl)$|\.html?$/i

export interface WalkedFile {
  /** Ruta relativa al repo, siempre con `/`. */
  rel: string
  text: string
}

/** Una regla de `.gitignore` ya convertida a expresión regular. */
interface IgnoreRule {
  re: RegExp
  negated: boolean
  dirOnly: boolean
}

function globToRegExp(pattern: string): RegExp {
  let p = pattern
  const anchored = p.startsWith('/')
  if (anchored) p = p.slice(1)

  let re = ''
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!
    if (c === '*') {
      if (p[i + 1] === '*') {
        re += '.*'
        i++
        if (p[i + 1] === '/') i++
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') re += '[^/]'
    else if ('\\^$.|+()[]{}'.includes(c)) re += `\\${c}`
    else re += c
  }

  return new RegExp(anchored ? `^${re}$` : `(^|/)${re}$`)
}

export function parseGitignore(content: string): IgnoreRule[] {
  const rules: IgnoreRule[] = []
  for (const raw of content.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const negated = line.startsWith('!')
    let body = negated ? line.slice(1) : line
    const dirOnly = body.endsWith('/')
    if (dirOnly) body = body.slice(0, -1)
    if (body === '') continue
    rules.push({ re: globToRegExp(body), negated, dirOnly })
  }
  return rules
}

function isIgnored(rel: string, isDir: boolean, rules: IgnoreRule[]): boolean {
  let ignored = false
  for (const r of rules) {
    if (r.dirOnly && !isDir && !r.re.test(rel)) continue
    if (r.dirOnly && !isDir) {
      // Una regla `dir/` también tapa lo que está adentro.
      const parts = rel.split('/')
      const anyParent = parts.slice(0, -1).some((_, i) => r.re.test(parts.slice(0, i + 1).join('/')))
      if (!anyParent) continue
      ignored = !r.negated
      continue
    }
    if (r.re.test(rel)) ignored = !r.negated
  }
  return ignored
}

/** Un byte nulo en la cabecera es la señal clásica de que no es texto. */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

export async function walkRepo(repoPath: string): Promise<WalkedFile[]> {
  let rules: IgnoreRule[] = []
  try {
    rules = parseGitignore(await readFile(join(repoPath, '.gitignore'), 'utf8'))
  } catch {
    rules = []
  }

  const found: WalkedFile[] = []

  async function visit(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (ALWAYS_SKIP.has(entry.name)) continue
      const abs = join(dir, entry.name)
      const rel = relative(repoPath, abs).split(sep).join('/')

      if (entry.isDirectory()) {
        if (isIgnored(rel, true, rules)) continue
        await visit(abs)
        continue
      }
      if (!entry.isFile()) continue
      if (!SUPPORTED.test(entry.name)) continue
      if (isIgnored(rel, false, rules)) continue

      try {
        const info = await stat(abs)
        if (info.size > MAX_FILE_BYTES) continue
        const buf = await readFile(abs)
        if (looksBinary(buf)) continue
        found.push({ rel, text: buf.toString('utf8') })
      } catch {
        continue
      }
    }
  }

  await visit(repoPath)
  found.sort((a, b) => a.rel.localeCompare(b.rel))
  return found
}
