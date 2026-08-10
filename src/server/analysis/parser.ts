import 'server-only'

/**
 * Lectura de archivos TypeScript / TSX / JavaScript.
 *
 * Devuelve siempre los mismos "hechos" (`SourceFacts`) sin importar qué motor los
 * sacó. Hay dos:
 *
 *  1. **tree-sitter** (el camino querido, D13): AST real, gramáticas `.wasm`.
 *  2. **lector directo**: recorre el archivo carácter por carácter sacando
 *     comentarios, textos entre comillas y expresiones regulares, y recién
 *     entonces busca imports, exports y componentes.
 *
 * El segundo no es un parche improvisado: es lo que mantiene la corrida en pie
 * cuando un archivo rompe el AST cerca del final, que es exactamente lo que está
 * documentado en MEMORY.md. Cada archivo elige motor por su cuenta, así que un
 * archivo roto no voltea la corrida: queda anotado y se sigue.
 *
 * Qué motor se usó queda registrado en `SourceFacts.engine` y sube hasta
 * `CodeIndex.notes`. Nunca decimos que leímos con AST algo que leímos de otra forma.
 */

import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

import { env } from '@/lib/env'
import type { SymbolNode } from '@/lib/types/domain'

export type SourceLanguage = 'typescript' | 'tsx' | 'javascript'

export type AnalysisEngine = 'tree-sitter' | 'lector-directo'

export interface ImportFact {
  /** Lo que está escrito entre comillas: './cosas', '@/lib/x', 'react'. */
  source: string
  /** Nombres importados. '*' = todo el módulo, 'default' = la exportación principal. */
  names: string[]
  line: number
  kind: 'static' | 'dynamic' | 'require' | 'reexport'
}

export interface ExportFact {
  name: string
  kind: SymbolNode['kind']
  line: number
  isDefault: boolean
}

export interface SourceFacts {
  file: string
  language: SourceLanguage
  engine: AnalysisEngine
  /** El archivo declara 'use client'. */
  isClient: boolean
  /** El archivo declara 'use server'. */
  isServerAction: boolean
  imports: ImportFact[]
  exports: ExportFact[]
  /** Componentes usados en el JSX de este archivo (los que empiezan en mayúscula). */
  jsxUsages: Array<{ name: string; line: number }>
  lineCount: number
  bytes: number
  /** Motivo por el que el AST no pudo con el archivo. El archivo igual se leyó. */
  parseError?: string
}

/* ── Motor 1: tree-sitter ─────────────────────────────────────────────────── */

const GRAMMAR_FILES: Record<SourceLanguage, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
}

export interface ParserCapability {
  available: boolean
  engine: AnalysisEngine
  /** Explicación en castellano de por qué no está disponible, si es el caso. */
  reason?: string
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyNode = any

interface TreeSitterRuntime {
  /** Carga la gramática si hace falta y devuelve la raíz del árbol. */
  parse: (source: string, language: SourceLanguage) => Promise<AnyNode>
  /** Deja una gramática lista de antemano, para no pagarla por archivo. */
  preload: (language: SourceLanguage) => Promise<void>
}

let runtimePromise: Promise<TreeSitterRuntime | null> | null = null
let capabilityReason: string | undefined

/** Solo para tests: obliga a volver a intentar la carga. */
export function resetParserCache(): void {
  runtimePromise = null
  capabilityReason = undefined
}

function grammarPathCandidates(fileName: string): string[] {
  const candidates: string[] = []
  const configured = env.grammarDir()
  if (configured) candidates.push(path.join(configured, fileName))
  try {
    // Se resuelve el `package.json` y se arma la ruta a mano, en vez de pedir
    // el `.wasm` directo. Suena rebuscado y no lo es: `require.resolve()` con
    // el nombre del archivo interpolado hace que el empaquetador de Next se
    // trague TODA la carpeta `out/`, y ahí adentro hay gramáticas cuyo cargador
    // importa un módulo `env` que solo existe dentro del runtime de
    // WebAssembly. El build entero se cae por gramáticas que ni usamos.
    const require = createRequire(import.meta.url)
    const raizDelPaquete = path.dirname(require.resolve('tree-sitter-wasms/package.json'))
    candidates.push(path.join(raizDelPaquete, 'out', fileName))
  } catch {
    // El paquete puede no resolverse en un bundle serverless: seguimos con el resto.
  }
  candidates.push(path.join(process.cwd(), 'node_modules', 'tree-sitter-wasms', 'out', fileName))
  return candidates
}

async function readGrammar(fileName: string): Promise<Uint8Array> {
  const tried: string[] = []
  for (const candidate of grammarPathCandidates(fileName)) {
    try {
      return new Uint8Array(await readFile(candidate))
    } catch {
      tried.push(candidate)
    }
  }
  throw new Error(`no encontramos la gramática ${fileName} (probamos en ${tried.length} ubicaciones)`)
}

/**
 * Carga tree-sitter tolerando las dos formas de su API:
 * la moderna (>= 0.22) exporta `Parser` y `Language`; la vieja (0.20/0.21)
 * exporta la clase por default y cuelga `Language` de ella.
 */
async function loadRuntime(): Promise<TreeSitterRuntime | null> {
  let mod: any
  try {
    mod = await import('web-tree-sitter')
  } catch (error) {
    capabilityReason = `no se pudo cargar web-tree-sitter (${describe(error)})`
    return null
  }

  const ParserCtor = mod.Parser ?? mod.default
  if (typeof ParserCtor !== 'function') {
    capabilityReason = 'la versión instalada de web-tree-sitter no expone la clase Parser'
    return null
  }

  try {
    await ParserCtor.init()
  } catch (error) {
    capabilityReason = `no se pudo iniciar tree-sitter (${describe(error)})`
    return null
  }

  // `Language` se resuelve DESPUÉS de init a propósito: en la API vieja (0.20/0.21)
  // `Parser.Language` recién existe una vez que arrancó el runtime de WebAssembly.
  // Buscarlo antes daba siempre "no disponible" y tiraba todo al lector directo.
  const LanguageApi = mod.Language ?? ParserCtor.Language
  if (typeof LanguageApi?.load !== 'function') {
    capabilityReason = 'la versión instalada de web-tree-sitter no expone Language.load'
    return null
  }

  // Se cachea la *promesa*, no el parser: dos archivos leídos en paralelo no
  // pueden terminar cargando la misma gramática dos veces.
  const parsers = new Map<SourceLanguage, Promise<AnyNode>>()

  function parserFor(language: SourceLanguage): Promise<AnyNode> {
    const cached = parsers.get(language)
    if (cached) return cached
    const creating = (async () => {
      const bytes = await readGrammar(GRAMMAR_FILES[language])
      const grammar = await LanguageApi.load(bytes)
      const parser = new ParserCtor()
      parser.setLanguage(grammar)
      return parser
    })()
    parsers.set(language, creating)
    // Una gramática que falla no queda cacheada como rota para siempre.
    creating.catch(() => parsers.delete(language))
    return creating
  }

  // Prueba real: si la gramática no es compatible con esta versión de
  // web-tree-sitter, revienta acá y no en medio de una corrida del usuario.
  try {
    const probe = await parserFor('tsx')
    const tree = probe.parse('export const Ok = () => <div />')
    if (!tree?.rootNode) throw new Error('el parser devolvió un árbol vacío')
  } catch (error) {
    capabilityReason = `las gramáticas .wasm instaladas no son compatibles con esta versión de web-tree-sitter (${describe(error)})`
    return null
  }

  return {
    preload: async (language) => {
      await parserFor(language)
    },
    parse: async (source, language) => {
      const parser = await parserFor(language)
      const tree = parser.parse(source)
      if (!tree?.rootNode) throw new Error('el parser devolvió un árbol vacío')
      return tree.rootNode
    },
  }
}

async function getRuntime(): Promise<TreeSitterRuntime | null> {
  if (!runtimePromise) {
    runtimePromise = loadRuntime().catch((error) => {
      capabilityReason = describe(error)
      return null
    })
  }
  return runtimePromise
}

/** Estado del motor de AST. Se reporta en `CodeIndex.notes`, no se esconde. */
export async function parserCapability(): Promise<ParserCapability> {
  const runtime = await getRuntime()
  if (runtime) return { available: true, engine: 'tree-sitter' }
  return {
    available: false,
    engine: 'lector-directo',
    reason: capabilityReason ?? 'tree-sitter no está disponible en este entorno',
  }
}

/**
 * Precarga las gramáticas de los lenguajes que se van a usar.
 * Se llama una vez por corrida para no pagar la carga por archivo.
 */
export async function warmUpParser(languages: SourceLanguage[]): Promise<ParserCapability> {
  const capability = await parserCapability()
  if (!capability.available) return capability
  const runtime = await getRuntime()
  for (const language of new Set(languages)) {
    try {
      await runtime?.preload(language)
    } catch {
      // Si una gramática puntual falla, ese lenguaje cae al lector directo.
    }
  }
  return capability
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  return String(error)
}

export function languageOf(file: string): SourceLanguage | null {
  const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase()
  if (ext === 'tsx' || ext === 'jsx') return 'tsx'
  if (ext === 'ts' || ext === 'mts' || ext === 'cts') return 'typescript'
  if (ext === 'js' || ext === 'mjs' || ext === 'cjs') return 'javascript'
  return null
}

/* ── Extracción desde el AST ──────────────────────────────────────────────── */

function nodeText(node: AnyNode): string {
  return typeof node?.text === 'string' ? node.text : ''
}

function nodeLine(node: AnyNode): number {
  const row = node?.startPosition?.row
  return typeof row === 'number' ? row + 1 : 1
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' || first === "'" || first === '`') && first === last) return value.slice(1, -1)
  }
  return value
}

function namedChildren(node: AnyNode): AnyNode[] {
  const children = node?.namedChildren
  return Array.isArray(children) ? children : []
}

function field(node: AnyNode, name: string): AnyNode | null {
  try {
    return node?.childForFieldName?.(name) ?? null
  } catch {
    return null
  }
}

function kindForDeclaration(type: string, name: string, language: SourceLanguage): SymbolNode['kind'] {
  if (type === 'class_declaration') return 'class'
  if (type === 'type_alias_declaration' || type === 'interface_declaration') return 'type'
  const looksComponent = /^[A-Z]/.test(name) && language === 'tsx'
  if (type === 'function_declaration' || type === 'generator_function_declaration') {
    return looksComponent ? 'component' : 'function'
  }
  if (looksComponent) return 'component'
  return 'const'
}

function collectImportNames(clause: AnyNode): string[] {
  const names: string[] = []
  const walk = (node: AnyNode) => {
    const type = node?.type
    if (type === 'namespace_import') {
      names.push('*')
      return
    }
    if (type === 'import_specifier') {
      const nameNode = field(node, 'name')
      names.push(nodeText(nameNode) || nodeText(node))
      return
    }
    if (type === 'identifier' && node?.parent?.type === 'import_clause') {
      names.push('default')
      return
    }
    for (const child of namedChildren(node)) walk(child)
  }
  // El identificador suelto del clause es la importación por defecto.
  for (const child of namedChildren(clause)) {
    if (child?.type === 'identifier') names.push('default')
    else walk(child)
  }
  return names
}

function declaredNames(declaration: AnyNode): Array<{ name: string; type: string }> {
  const type = declaration?.type
  if (!type) return []
  if (type === 'function_declaration' || type === 'generator_function_declaration' || type === 'class_declaration') {
    const name = nodeText(field(declaration, 'name'))
    return name ? [{ name, type }] : []
  }
  if (type === 'type_alias_declaration' || type === 'interface_declaration' || type === 'enum_declaration') {
    const name = nodeText(field(declaration, 'name'))
    return name ? [{ name, type }] : []
  }
  if (type === 'lexical_declaration' || type === 'variable_declaration') {
    const result: Array<{ name: string; type: string }> = []
    for (const child of namedChildren(declaration)) {
      if (child?.type !== 'variable_declarator') continue
      const name = nodeText(field(child, 'name'))
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) result.push({ name, type })
    }
    return result
  }
  return []
}

function extractWithAst(file: string, source: string, root: AnyNode, language: SourceLanguage): SourceFacts {
  const imports: ImportFact[] = []
  const exports: ExportFact[] = []
  const jsxUsages: Array<{ name: string; line: number }> = []

  const stack: AnyNode[] = [root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (!node) continue
    const type = node.type as string

    if (type === 'import_statement') {
      const sourceNode = field(node, 'source')
      const specifier = unquote(nodeText(sourceNode))
      if (specifier) {
        const clause = namedChildren(node).find((child) => child?.type === 'import_clause')
        imports.push({
          source: specifier,
          names: clause ? collectImportNames(clause) : [],
          line: nodeLine(node),
          kind: 'static',
        })
      }
    } else if (type === 'export_statement') {
      const sourceNode = field(node, 'source')
      if (sourceNode) {
        imports.push({
          source: unquote(nodeText(sourceNode)),
          names: ['*'],
          line: nodeLine(node),
          kind: 'reexport',
        })
      }
      const isDefault = nodeText(node).trimStart().startsWith('export default')
      const declaration = field(node, 'declaration')
      if (declaration) {
        for (const declared of declaredNames(declaration)) {
          exports.push({
            name: isDefault ? 'default' : declared.name,
            kind: kindForDeclaration(declared.type, declared.name, language),
            line: nodeLine(node),
            isDefault,
          })
        }
        if (isDefault && declaredNames(declaration).length === 0) {
          exports.push({ name: 'default', kind: 'component', line: nodeLine(node), isDefault: true })
        }
      } else if (isDefault) {
        exports.push({ name: 'default', kind: 'component', line: nodeLine(node), isDefault: true })
      } else {
        for (const child of namedChildren(node)) {
          if (child?.type !== 'export_clause') continue
          for (const specifier of namedChildren(child)) {
            const alias = nodeText(field(specifier, 'alias'))
            const name = alias || nodeText(field(specifier, 'name'))
            if (name) exports.push({ name, kind: 'const', line: nodeLine(specifier), isDefault: name === 'default' })
          }
        }
      }
    } else if (type === 'call_expression') {
      const callee = field(node, 'function')
      const calleeText = nodeText(callee)
      if (calleeText === 'import' || calleeText === 'require') {
        const args = field(node, 'arguments')
        const first = namedChildren(args ?? {})[0]
        const specifier = unquote(nodeText(first))
        if (specifier && !specifier.includes('\n')) {
          imports.push({
            source: specifier,
            names: ['*'],
            line: nodeLine(node),
            kind: calleeText === 'import' ? 'dynamic' : 'require',
          })
        }
      }
    } else if (type === 'jsx_opening_element' || type === 'jsx_self_closing_element') {
      // `<Menu.Item />` se atribuye a `Menu`, que es lo que se importó.
      const base = nodeText(field(node, 'name')).split('.')[0]
      if (base && /^[A-Z]/.test(base)) jsxUsages.push({ name: base, line: nodeLine(node) })
    }

    for (const child of namedChildren(node)) stack.push(child)
  }

  const directives = readDirectives(source)
  return {
    file,
    language,
    engine: 'tree-sitter',
    isClient: directives.isClient,
    isServerAction: directives.isServerAction,
    imports,
    exports,
    jsxUsages,
    lineCount: countLines(source),
    bytes: Buffer.byteLength(source, 'utf8'),
  }
}

/* ── Motor 2: lector directo ──────────────────────────────────────────────── */

interface Preprocessed {
  /** Mismo largo que el original: comentarios y textos reemplazados por espacios. */
  clean: string
  /** Rangos [inicio, fin) que eran texto entre comillas. */
  stringRanges: Array<[number, number]>
  lineStarts: number[]
}

const REGEX_ALLOWED_BEFORE = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>',
])
const REGEX_ALLOWED_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'do', 'else', 'yield', 'await', 'case',
])

/**
 * Deja el archivo listo para buscar: saca comentarios y vacía los textos, pero
 * conserva las posiciones exactas para poder reportar la línea correcta.
 *
 * Distingue expresión regular de división mirando el carácter anterior. Sin eso,
 * algo tan común como `/https:\/\//` haría creer que empieza un comentario y se
 * perdería medio archivo.
 */
export function preprocess(source: string): Preprocessed {
  const chars = source.split('')
  const clean = chars.slice()
  const stringRanges: Array<[number, number]> = []
  const lineStarts: number[] = [0]

  const blank = (from: number, to: number) => {
    for (let i = from; i < to && i < clean.length; i++) {
      if (clean[i] !== '\n') clean[i] = ' '
    }
  }

  let index = 0
  let lastSignificant = ''
  let lastWord = ''

  const templateStack: number[] = [] // profundidad de `${ }` por template abierto

  while (index < source.length) {
    const char = source[index]
    if (char === '\n') lineStarts.push(index + 1)

    if (char === '/' && templateStack.length === 0) {
      const next = source[index + 1]
      if (next === '*') {
        const end = source.indexOf('*/', index + 2)
        const stop = end === -1 ? source.length : end + 2
        for (let i = index; i < stop; i++) if (source[i] === '\n') lineStarts.push(i + 1)
        blank(index, stop)
        index = stop
        lastSignificant = ''
        continue
      }
      if (next === '/') {
        let end = source.indexOf('\n', index)
        if (end === -1) end = source.length
        blank(index, end)
        index = end
        continue
      }
      const allowsRegex =
        lastSignificant === '' ||
        REGEX_ALLOWED_BEFORE.has(lastSignificant) ||
        REGEX_ALLOWED_KEYWORDS.has(lastWord)
      if (allowsRegex) {
        let i = index + 1
        let inClass = false
        while (i < source.length) {
          const c = source[i]
          if (c === '\\') {
            i += 2
            continue
          }
          if (c === '\n') break
          if (c === '[') inClass = true
          else if (c === ']') inClass = false
          else if (c === '/' && !inClass) break
          i++
        }
        const stop = Math.min(i + 1, source.length)
        blank(index + 1, stop - 1)
        index = stop
        lastSignificant = '/'
        lastWord = ''
        continue
      }
    }

    if (char === '"' || char === "'") {
      let i = index + 1
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2
          continue
        }
        if (source[i] === char || source[i] === '\n') break
        i++
      }
      const stop = Math.min(i + 1, source.length)
      stringRanges.push([index + 1, stop - 1])
      index = stop
      lastSignificant = char
      lastWord = ''
      continue
    }

    if (char === '`') {
      // Los template literals pueden anidar expresiones: se recorren enteros.
      let i = index + 1
      let depth = 0
      while (i < source.length) {
        const c = source[i]
        if (c === '\\') {
          i += 2
          continue
        }
        if (c === '\n') lineStarts.push(i + 1)
        if (c === '$' && source[i + 1] === '{') {
          depth++
          i += 2
          continue
        }
        if (c === '}' && depth > 0) {
          depth--
          i++
          continue
        }
        if (c === '`' && depth === 0) break
        i++
      }
      const stop = Math.min(i + 1, source.length)
      stringRanges.push([index + 1, stop - 1])
      index = stop
      lastSignificant = '`'
      lastWord = ''
      continue
    }

    if (!/\s/.test(char)) {
      lastSignificant = char
      if (/[A-Za-z_$]/.test(char)) {
        let end = index
        while (end < source.length && /[\w$]/.test(source[end])) end++
        lastWord = source.slice(index, end)
      } else {
        lastWord = ''
      }
    }

    index++
  }

  return { clean: clean.join(''), stringRanges, lineStarts }
}

function lineAt(lineStarts: number[], index: number): number {
  let low = 0
  let high = lineStarts.length - 1
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (lineStarts[mid] <= index) low = mid
    else high = mid - 1
  }
  return low + 1
}

function countLines(source: string): number {
  if (source.length === 0) return 0
  let count = 1
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') count++
  return count
}

/**
 * Sin AST no se puede afirmar que un archivo no compila, pero sí se puede notar
 * que le faltan llaves. Se cuentan `{}`, `()` y `[]` fuera de comentarios y de
 * textos entre comillas; si no cierran, el archivo casi seguro está roto.
 *
 * Se usa para no perder el aviso de "este archivo tiene un problema" cuando el
 * analizador de sintaxis no está disponible. El texto que devuelve es una
 * sospecha y está redactado como tal.
 */
export function findSyntaxImbalance(
  clean: string,
  ranges: Array<[number, number]>,
): string | null {
  const closing: Record<string, string> = { '}': '{', ')': '(', ']': '[' }
  const stack: string[] = []
  let rangeIndex = 0

  for (let i = 0; i < clean.length; i++) {
    while (rangeIndex < ranges.length && ranges[rangeIndex][1] <= i) rangeIndex++
    if (rangeIndex < ranges.length && i >= ranges[rangeIndex][0] && i < ranges[rangeIndex][1]) continue

    const char = clean[i]
    if (char === '{' || char === '(' || char === '[') {
      stack.push(char)
    } else if (closing[char]) {
      if (stack.length === 0 || stack[stack.length - 1] !== closing[char]) {
        return `parece sobrar un "${char}"`
      }
      stack.pop()
    }
  }

  if (stack.length > 0) return `parece faltar el cierre de un "${stack[stack.length - 1]}"`
  return null
}

function insideString(ranges: Array<[number, number]>, index: number): boolean {
  for (const [start, end] of ranges) {
    if (index >= start && index < end) return true
    if (start > index) break
  }
  return false
}

const RE_IMPORT_FROM = /(^|[\n;{}()])\s*import\s+(type\s+)?([^'"();]*?)\s*from\s*(['"])([^'"\n]+)\4/g
const RE_IMPORT_BARE = /(^|[\n;{}()])\s*import\s*(['"])([^'"\n]+)\2/g
const RE_IMPORT_DYNAMIC = /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g
const RE_REQUIRE = /\brequire\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g
const RE_REEXPORT = /(^|[\n;{}])\s*export\s+(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*(['"])([^'"\n]+)\2/g
const RE_EXPORT_FUNCTION = /(^|[\n;{}])\s*export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g
const RE_EXPORT_CLASS = /(^|[\n;{}])\s*export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g
const RE_EXPORT_BINDING = /(^|[\n;{}])\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g
const RE_EXPORT_TYPE = /(^|[\n;{}])\s*export\s+(?:type|interface|enum)\s+([A-Za-z_$][\w$]*)/g
const RE_EXPORT_LIST = /(^|[\n;{}])\s*export\s*\{([^}]*)\}\s*(?![^;\n]*from)/g
const RE_EXPORT_DEFAULT = /(^|[\n;{}])\s*export\s+default\s+(?:(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)?|class\s+([A-Za-z_$][\w$]*)?)?/g
const RE_JSX = /<([A-Z][\w$]*(?:\.[A-Za-z_$][\w$]*)*)[\s/>]/g

function parseImportNames(clause: string): string[] {
  const names: string[] = []
  const trimmed = clause.trim()
  if (!trimmed) return names
  const namespace = trimmed.match(/\*\s+as\s+[\w$]+/)
  if (namespace) names.push('*')
  const braces = trimmed.match(/\{([^}]*)\}/)
  if (braces) {
    for (const piece of braces[1].split(',')) {
      const name = piece.trim().split(/\s+as\s+/)[0].replace(/^type\s+/, '').trim()
      if (name) names.push(name)
    }
  }
  const beforeBrace = trimmed.split('{')[0].split(',')[0].trim()
  if (beforeBrace && /^[A-Za-z_$][\w$]*$/.test(beforeBrace)) names.unshift('default')
  return names
}

function extractWithReader(file: string, source: string, language: SourceLanguage): SourceFacts {
  const { clean, stringRanges, lineStarts } = preprocess(source)
  const imports: ImportFact[] = []
  const exports: ExportFact[] = []
  const jsxUsages: Array<{ name: string; line: number }> = []

  const scan = (
    regex: RegExp,
    handle: (match: RegExpExecArray, line: number) => void,
  ) => {
    regex.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = regex.exec(clean)) !== null) {
      if (insideString(stringRanges, match.index)) continue
      handle(match, lineAt(lineStarts, match.index))
    }
  }

  // Los especificadores viven en `stringRanges`, así que se leen del original.
  const at = (start: number, length: number) => source.substr(start, length)

  scan(RE_IMPORT_FROM, (match, line) => {
    const specifierStart = match.index + match[0].length - 1 - match[5].length
    imports.push({
      source: at(specifierStart, match[5].length),
      names: parseImportNames(match[3]),
      line,
      kind: 'static',
    })
  })
  scan(RE_IMPORT_BARE, (match, line) => {
    const specifierStart = match.index + match[0].length - 1 - match[3].length
    imports.push({ source: at(specifierStart, match[3].length), names: [], line, kind: 'static' })
  })
  scan(RE_IMPORT_DYNAMIC, (match, line) => {
    const specifierStart = clean.indexOf(match[1], match.index) + 1
    imports.push({ source: at(specifierStart, match[2].length), names: ['*'], line, kind: 'dynamic' })
  })
  scan(RE_REQUIRE, (match, line) => {
    const specifierStart = clean.indexOf(match[1], match.index) + 1
    imports.push({ source: at(specifierStart, match[2].length), names: ['*'], line, kind: 'require' })
  })
  scan(RE_REEXPORT, (match, line) => {
    const specifierStart = match.index + match[0].length - 1 - match[3].length
    imports.push({ source: at(specifierStart, match[3].length), names: ['*'], line, kind: 'reexport' })
  })

  const pushExport = (name: string, kind: SymbolNode['kind'], line: number, isDefault = false) => {
    if (!name) return
    if (exports.some((item) => item.name === name && item.line === line)) return
    exports.push({ name, kind, line, isDefault })
  }

  scan(RE_EXPORT_FUNCTION, (match, line) =>
    pushExport(match[2], /^[A-Z]/.test(match[2]) && language === 'tsx' ? 'component' : 'function', line),
  )
  scan(RE_EXPORT_CLASS, (match, line) => pushExport(match[2], 'class', line))
  scan(RE_EXPORT_BINDING, (match, line) =>
    pushExport(match[2], /^[A-Z]/.test(match[2]) && language === 'tsx' ? 'component' : 'const', line),
  )
  scan(RE_EXPORT_TYPE, (match, line) => pushExport(match[2], 'type', line))
  scan(RE_EXPORT_LIST, (match, line) => {
    for (const piece of match[2].split(',')) {
      const name = piece.trim().split(/\s+as\s+/).pop()?.replace(/^type\s+/, '').trim()
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) pushExport(name, 'const', line, name === 'default')
    }
  })
  scan(RE_EXPORT_DEFAULT, (match, line) => {
    exports.push({
      name: 'default',
      kind: language === 'tsx' ? 'component' : 'function',
      line,
      isDefault: true,
    })
  })

  scan(RE_JSX, (match, line) => {
    const name = match[1].split('.')[0]
    if (/^[A-Z]/.test(name)) jsxUsages.push({ name, line })
  })

  const directives = readDirectives(source)
  const imbalance = findSyntaxImbalance(clean, stringRanges)

  return {
    file,
    language,
    engine: 'lector-directo',
    isClient: directives.isClient,
    isServerAction: directives.isServerAction,
    imports,
    exports,
    jsxUsages,
    lineCount: countLines(source),
    bytes: Buffer.byteLength(source, 'utf8'),
    parseError: imbalance ? `Puede tener un problema de sintaxis: ${imbalance}.` : undefined,
  }
}

/**
 * `'use client'` y `'use server'` solo valen arriba de todo, antes de cualquier
 * código. Se miran las primeras líneas útiles, salteando comentarios.
 */
export function readDirectives(source: string): { isClient: boolean; isServerAction: boolean } {
  let isClient = false
  let isServerAction = false
  const head = source.slice(0, 2000)
  const withoutComments = head.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  for (const rawLine of withoutComments.split('\n')) {
    const line = rawLine.trim()
    if (line === '') continue
    const directive = line.match(/^(['"])(use client|use server)\1\s*;?$/)
    if (!directive) break
    if (directive[2] === 'use client') isClient = true
    else isServerAction = true
  }
  return { isClient, isServerAction }
}

/**
 * Une lo que sacó el AST con lo que sacó el lector directo.
 *
 * Existe por un caso medido, no por precaución: ante un archivo roto tree-sitter
 * arma un nodo `ERROR` y se traga las declaraciones enteras — en el archivo de
 * prueba el árbol no contenía **ningún** `export_statement` ni
 * `function_declaration`, así que el `export function seRompe()` desaparecía. El
 * lector directo sí lo encuentra. Sin esta unión, encender el analizador de
 * sintaxis hacía que recuperáramos *menos* de un archivo roto que sin él.
 *
 * El AST manda cuando el archivo compila; el lector solo aporta lo que faltaba.
 */
function mergeFacts(fromAst: SourceFacts, fromReader: SourceFacts): SourceFacts {
  let recovered = 0

  const imports = [...fromAst.imports]
  const importKeys = new Set(imports.map((item) => `${item.kind}|${item.source}`))
  for (const item of fromReader.imports) {
    const key = `${item.kind}|${item.source}`
    if (importKeys.has(key)) continue
    importKeys.add(key)
    imports.push(item)
    recovered++
  }

  const exports = [...fromAst.exports]
  const exportNames = new Set(exports.map((item) => item.name))
  for (const item of fromReader.exports) {
    if (exportNames.has(item.name)) continue
    exportNames.add(item.name)
    exports.push(item)
    recovered++
  }

  const jsxUsages = [...fromAst.jsxUsages]
  const jsxNames = new Set(jsxUsages.map((item) => item.name))
  for (const item of fromReader.jsxUsages) {
    if (jsxNames.has(item.name)) continue
    jsxNames.add(item.name)
    jsxUsages.push(item)
    recovered++
  }

  imports.sort((a, b) => a.line - b.line)
  exports.sort((a, b) => a.line - b.line)
  jsxUsages.sort((a, b) => a.line - b.line)

  return {
    ...fromAst,
    // Si el lector tuvo que aportar algo, el resultado ya no es puramente
    // estructural y así se informa. Mentir acá contamina la nota de la corrida.
    engine: recovered > 0 ? 'lector-directo' : 'tree-sitter',
    imports,
    exports,
    jsxUsages,
  }
}

/* ── Entrada pública ──────────────────────────────────────────────────────── */

export interface AnalyzeOptions {
  /** Archivos más grandes que esto no se parsean (se devuelven vacíos y anotados). */
  maxBytes?: number
  /** Fuerza el lector directo. Se usa en los tests. */
  forceReader?: boolean
}

const DEFAULT_MAX_BYTES = 1024 * 1024

/**
 * Lee un archivo y devuelve sus hechos. **Nunca tira**: si algo falla, lo anota
 * en `parseError` y devuelve lo que se pudo sacar. Una corrida no se cae por un
 * archivo roto.
 */
export async function analyzeSource(
  file: string,
  source: string,
  options: AnalyzeOptions = {},
): Promise<SourceFacts> {
  const language = languageOf(file) ?? 'typescript'
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const bytes = Buffer.byteLength(source, 'utf8')

  if (bytes > maxBytes) {
    return {
      file,
      language,
      engine: 'lector-directo',
      isClient: false,
      isServerAction: false,
      imports: [],
      exports: [],
      jsxUsages: [],
      lineCount: countLines(source),
      bytes,
      parseError: 'El archivo es demasiado grande para analizarlo entero.',
    }
  }

  if (!options.forceReader) {
    const runtime = await getRuntime()
    if (runtime) {
      try {
        const root = await runtime.parse(source, language)
        const facts = extractWithAst(file, source, root, language)

        // `hasError` es método en la API vieja y propiedad en la nueva.
        const broken = typeof root.hasError === 'function' ? root.hasError() : Boolean(root.hasError)
        if (!broken) return facts

        // Árbol con errores: el lector directo entra como red de contención.
        const merged = mergeFacts(facts, extractWithReader(file, source, language))
        merged.parseError = 'El archivo tiene errores de sintaxis; se leyó lo que se pudo.'
        return merged
      } catch (error) {
        const fallback = extractWithReader(file, source, language)
        fallback.parseError = `No se pudo armar el árbol de sintaxis (${describe(error)}); se leyó con el lector directo.`
        return fallback
      }
    }
  }

  return extractWithReader(file, source, language)
}
