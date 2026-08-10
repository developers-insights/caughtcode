import 'server-only'

/**
 * Grafo de símbolos y referencias.
 *
 * Convención de identificadores (la usan el chat y los tutoriales):
 *  - Un archivo entero se identifica por su ruta:            `src/app/page.tsx`
 *  - Una cosa exportada, con almohadilla:                    `src/lib/auth.ts#getUser`
 *
 * Aristas emitidas:
 *  - `imports`: archivo → archivo. Es lo que alimenta el cálculo de importancia.
 *  - `renders`: archivo → componente concreto que ese archivo dibuja en pantalla.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NO EMITIMOS ARISTAS `calls`. Decisión tomada y confirmada — no la "mejores".
 *
 * `SymbolEdge` admite el tipo `calls`, y es tentador completarlo emparejando
 * nombres de funciones. No se hace. Sin resolución de tipos no se puede saber si
 * `guardar()` es la del archivo importado, una homónima local o un método de otro
 * objeto: emparejar por nombre produce aristas que *parecen* ciertas y no lo son.
 *
 * Ese grafo alimenta el chat y los tutoriales, o sea que una arista inventada
 * termina siendo una afirmación falsa mostrada a alguien que no puede detectarla
 * (CONTRACTS §4.1, DECISIONS D14). Un grafo incompleto es honesto; uno inventado
 * rompe lo único que nos hace confiables.
 *
 * Si algún día se quiere `calls`, el precio de entrada es resolución real de
 * símbolos, no coincidencia de nombres.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import path from 'node:path'

import type { RouteInfo, SymbolEdge, SymbolNode } from '@/lib/types/domain'
import type { SourceFacts } from './parser'

const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']
const INDEX_FILES = EXTENSIONS.map((extension) => `/index${extension}`)

export interface SymbolGraph {
  symbols: SymbolNode[]
  edges: SymbolEdge[]
  /** Aristas archivo → archivo, sin repetir. Entrada del cálculo de importancia. */
  fileEdges: Array<{ from: string; to: string }>
  /** Paquetes de terceros más usados, ordenados por cantidad de archivos que los importan. */
  externalPackages: Array<{ name: string; usedBy: number }>
}

export interface BuildGraphOptions {
  /** Atajos de importación configurados en el proyecto. Por defecto `@/` → `src/`. */
  aliases?: Record<string, string[]>
  routes?: RouteInfo[]
}

const DEFAULT_ALIASES: Record<string, string[]> = {
  '@/': ['src/', ''],
  '~/': ['src/', ''],
}

function normalize(relative: string): string {
  return relative.split(path.sep).join('/').replace(/^\.\//, '')
}

/**
 * Traduce lo que está escrito en el `import` a un archivo del proyecto.
 * Devuelve `null` cuando es un paquete de terceros.
 */
export function resolveSpecifier(
  fromFile: string,
  specifier: string,
  known: Set<string>,
  aliases: Record<string, string[]> = DEFAULT_ALIASES,
): string | null {
  const tryCandidates = (base: string): string | null => {
    const cleaned = base.replace(/\/+$/, '')
    if (known.has(cleaned)) return cleaned
    for (const extension of EXTENSIONS) {
      if (known.has(cleaned + extension)) return cleaned + extension
    }
    for (const index of INDEX_FILES) {
      if (known.has(cleaned + index)) return cleaned + index
    }
    // Import con extensión .js que en realidad apunta a un .ts (práctica común en ESM).
    const swapped = cleaned.replace(/\.(js|jsx)$/, '')
    if (swapped !== cleaned) {
      for (const extension of EXTENSIONS) {
        if (known.has(swapped + extension)) return swapped + extension
      }
    }
    return null
  }

  if (specifier.startsWith('.')) {
    const resolved = normalize(path.posix.join(path.posix.dirname(fromFile), specifier))
    return tryCandidates(resolved)
  }

  for (const [prefix, replacements] of Object.entries(aliases)) {
    if (!specifier.startsWith(prefix)) continue
    const rest = specifier.slice(prefix.length)
    for (const replacement of replacements) {
      const found = tryCandidates(normalize(replacement + rest))
      if (found) return found
    }
  }

  // Import absoluto desde la raíz del proyecto (baseUrl).
  if (!specifier.startsWith('@') && !specifier.includes(':')) {
    const found = tryCandidates(specifier) ?? tryCandidates(`src/${specifier}`)
    if (found) return found
  }

  return null
}

/** Nombre del paquete de terceros: `@scope/pkg/sub` → `@scope/pkg`, `react-dom/client` → `react-dom`. */
export function packageNameOf(specifier: string): string | null {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return null
  if (specifier.startsWith('node:')) return null
  const parts = specifier.split('/')
  if (specifier.startsWith('@')) return parts.slice(0, 2).join('/')
  return parts[0]
}

function moduleKind(file: string, routeFiles: Set<string>): SymbolNode['kind'] {
  return routeFiles.has(file) ? 'route' : 'const'
}

export function buildSymbolGraph(
  facts: SourceFacts[],
  allFiles: string[],
  options: BuildGraphOptions = {},
): SymbolGraph {
  const aliases = options.aliases ?? DEFAULT_ALIASES
  const known = new Set(allFiles.map(normalize))
  const routeFiles = new Set((options.routes ?? []).map((route) => normalize(route.file)))

  const symbols: SymbolNode[] = []
  const symbolIds = new Set<string>()
  const edgeKeys = new Set<string>()
  const edges: SymbolEdge[] = []
  const fileEdgeKeys = new Set<string>()
  const fileEdges: Array<{ from: string; to: string }> = []
  const externalUsage = new Map<string, Set<string>>()

  const addSymbol = (node: SymbolNode) => {
    if (symbolIds.has(node.id)) return
    symbolIds.add(node.id)
    symbols.push(node)
  }
  const addEdge = (edge: SymbolEdge) => {
    const key = `${edge.kind}|${edge.from}|${edge.to}`
    if (edgeKeys.has(key)) return
    edgeKeys.add(key)
    edges.push(edge)
  }

  // Nodo por archivo. Sirve de ancla aunque el archivo no exporte nada con nombre.
  for (const fact of facts) {
    const file = normalize(fact.file)
    addSymbol({
      id: file,
      name: path.posix.basename(file),
      kind: moduleKind(file, routeFiles),
      file,
      line: 1,
      exported: false,
    })
  }

  // Nodo por cosa exportada.
  const exportsByFile = new Map<string, Map<string, string>>() // archivo -> nombre -> id
  for (const fact of facts) {
    const file = normalize(fact.file)
    const map = new Map<string, string>()
    for (const item of fact.exports) {
      const id = `${file}#${item.name}`
      addSymbol({
        id,
        name: item.name,
        kind: item.kind,
        file,
        line: item.line,
        exported: true,
      })
      map.set(item.name, id)
    }
    exportsByFile.set(file, map)
  }

  // Aristas de importación.
  for (const fact of facts) {
    const file = normalize(fact.file)
    for (const item of fact.imports) {
      const target = resolveSpecifier(file, item.source, known, aliases)
      if (!target) {
        const pkg = packageNameOf(item.source)
        if (pkg) {
          const set = externalUsage.get(pkg) ?? new Set<string>()
          set.add(file)
          externalUsage.set(pkg, set)
        }
        continue
      }
      if (target === file) continue
      addEdge({ from: file, to: target, kind: 'imports' })
      const key = `${file}|${target}`
      if (!fileEdgeKeys.has(key)) {
        fileEdgeKeys.add(key)
        fileEdges.push({ from: file, to: target })
      }
    }
  }

  // Aristas de renderizado: qué componente dibuja a cuál.
  for (const fact of facts) {
    const file = normalize(fact.file)
    if (fact.jsxUsages.length === 0) continue

    // De dónde vino cada nombre usado en el JSX.
    const origin = new Map<string, string>()
    for (const item of fact.imports) {
      const target = resolveSpecifier(file, item.source, known, aliases)
      if (!target) continue
      for (const name of item.names) {
        if (name === '*' ) continue
        origin.set(name, target)
      }
      if (item.names.includes('default')) {
        const defaultExport = exportsByFile.get(target)?.get('default')
        if (defaultExport) origin.set('default', target)
      }
    }

    const seen = new Set<string>()
    for (const usage of fact.jsxUsages) {
      if (seen.has(usage.name)) continue
      seen.add(usage.name)
      const target = origin.get(usage.name)
      if (!target) continue
      const symbolId = exportsByFile.get(target)?.get(usage.name) ?? target
      addEdge({ from: file, to: symbolId, kind: 'renders' })
    }
  }

  const externalPackages = [...externalUsage.entries()]
    .map(([name, users]) => ({ name, usedBy: users.size }))
    .sort((a, b) => b.usedBy - a.usedBy || (a.name < b.name ? -1 : 1))

  symbols.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  edges.sort((a, b) => {
    const left = `${a.kind}|${a.from}|${a.to}`
    const right = `${b.kind}|${b.from}|${b.to}`
    return left < right ? -1 : left > right ? 1 : 0
  })
  fileEdges.sort((a, b) => (a.from + a.to < b.from + b.to ? -1 : 1))

  return { symbols, edges, fileEdges, externalPackages }
}
