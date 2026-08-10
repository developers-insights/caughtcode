import 'server-only'

/**
 * Orquestador del motor de análisis.
 *
 * Orden obligatorio (D13): primero lo estructural y determinístico, el modelo de
 * lenguaje al final y solo sobre lo ya filtrado.
 *
 * Etapas reanudables: cada una guarda su resultado en `IndexStages`. Si una
 * corrida se cae en la etapa 4, la siguiente arranca desde ahí en vez de volver a
 * empezar. Los repos grandes rompen el procesamiento monolítico (MEMORY.md), así
 * que esto no es una optimización: es lo que hace que terminen.
 *
 * El progreso se informa por `onProgress`, que llega por parámetro. Este módulo
 * no sabe que existe una cola de trabajos y no debe saberlo.
 */

import pLimit from 'p-limit'

import type { CodeIndex, DbSchemaSnapshot, RouteInfo, StackInfo, SymbolEdge, SymbolNode } from '@/lib/types/domain'
import { detectStack } from '@/server/ingest/stack'
import { languageBreakdown, readTextFile, walkFiles, type WalkedFile } from './files'
import { rankFiles } from './pagerank'
import {
  analyzeSource,
  languageOf,
  parserCapability,
  warmUpParser,
  type SourceFacts,
  type SourceLanguage,
} from './parser'
import { detectRoutes } from './routes'
import { buildSymbolGraph } from './symbols'

export type StageId =
  | 'descubriendo-archivos'
  | 'detectando-tecnologia'
  | 'mapeando-pantallas'
  | 'leyendo-codigo'
  | 'armando-mapa'
  | 'calculando-importancia'
  | 'leyendo-base-de-datos'

/** Texto que ve el usuario mientras espera. Va a `analysis_runs.stage`. */
export const STAGE_LABEL: Record<StageId, string> = {
  'descubriendo-archivos': 'Abriendo tu proyecto',
  'detectando-tecnologia': 'Reconociendo con qué está hecho',
  'mapeando-pantallas': 'Buscando las pantallas de tu app',
  'leyendo-codigo': 'Leyendo el código',
  'armando-mapa': 'Armando el mapa del proyecto',
  'calculando-importancia': 'Viendo qué partes son las más importantes',
  'leyendo-base-de-datos': 'Revisando dónde se guardan los datos',
}

export const STAGE_ORDER: StageId[] = [
  'descubriendo-archivos',
  'detectando-tecnologia',
  'mapeando-pantallas',
  'leyendo-codigo',
  'armando-mapa',
  'calculando-importancia',
  'leyendo-base-de-datos',
]

/** Porcentaje acumulado al terminar cada etapa. */
const STAGE_END: Record<StageId, number> = {
  'descubriendo-archivos': 12,
  'detectando-tecnologia': 18,
  'mapeando-pantallas': 30,
  'leyendo-codigo': 70,
  'armando-mapa': 80,
  'calculando-importancia': 88,
  'leyendo-base-de-datos': 100,
}

export type ProgressFn = (stage: StageId, percent: number) => void | Promise<void>

/** Resultado de cada etapa. Se persiste para poder reanudar. */
export interface IndexStages {
  files?: { list: WalkedFile[]; totalBytes: number; truncated: boolean; skipped: number }
  stack?: StackInfo
  routes?: RouteInfo[]
  facts?: SourceFacts[]
  graph?: { symbols: SymbolNode[]; edges: SymbolEdge[]; fileEdges: Array<{ from: string; to: string }> }
  dbSchema?: { snapshot: DbSchemaSnapshot; notes: string[] }
}

export const ANALYSIS_LIMITS = {
  /** Arriba de esto el índice se recorta y se avisa. */
  maxAnalyzedFiles: 6000,
  /** Archivos de código que se leen en profundidad. */
  maxParsedFiles: 4000,
  maxFileBytes: 1024 * 1024,
  /** Lecturas en paralelo. Suficiente para aprovechar el disco sin comerse la memoria. */
  concurrency: 12,
} as const

export interface BuildIndexOptions {
  /** Carpeta con el código del usuario. */
  root: string
  onProgress?: ProgressFn
  /** Cadena de conexión de solo lectura a la base del usuario, si la conectó. */
  databaseUrl?: string | null
  /** Etapas ya resueltas en un intento anterior. */
  resumeFrom?: IndexStages
  limits?: Partial<typeof ANALYSIS_LIMITS>
  signal?: AbortSignal
}

export interface BuildIndexResult {
  index: CodeIndex
  stack: StackInfo
  /** Para persistir y reanudar si la corrida se corta. */
  stages: IndexStages
}

const CODE_EXTENSIONS = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts'])

function ensureAlive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('El análisis se canceló.')
}

/**
 * Cuando hay que recortar, se recorta con criterio: primero el código de la app,
 * después el resto. Nunca al azar.
 */
function prioritizeFiles(files: WalkedFile[], limit: number): { kept: WalkedFile[]; dropped: number } {
  if (files.length <= limit) return { kept: files, dropped: 0 }

  const weight = (file: WalkedFile): number => {
    const relative = file.relative
    if (/(^|\/)(app|src\/app|pages|src\/pages)\//.test(relative)) return 0
    if (relative.startsWith('src/')) return 1
    if (CODE_EXTENSIONS.has(file.extension)) return 2
    if (relative.endsWith('.sql') || relative.endsWith('.prisma')) return 2
    if (/(^|\/)(test|tests|__tests__|spec|e2e|stories)\//.test(relative)) return 5
    return 4
  }

  const sorted = [...files].sort((a, b) => weight(a) - weight(b) || (a.relative < b.relative ? -1 : 1))
  return { kept: sorted.slice(0, limit), dropped: files.length - limit }
}

export async function buildCodeIndex(options: BuildIndexOptions): Promise<BuildIndexResult> {
  const limits = { ...ANALYSIS_LIMITS, ...options.limits }
  const stages: IndexStages = { ...options.resumeFrom }
  const notes: string[] = []
  let truncated = false

  const report = async (stage: StageId) => {
    await options.onProgress?.(stage, STAGE_END[stage])
  }

  /* Etapa 1 — qué archivos hay. */
  ensureAlive(options.signal)
  if (!stages.files) {
    const walked = await walkFiles(options.root, {
      maxFiles: limits.maxAnalyzedFiles * 2,
      maxFileBytes: limits.maxFileBytes,
    })
    stages.files = {
      list: walked.files,
      totalBytes: walked.totalBytes,
      truncated: walked.truncated,
      skipped: walked.skipped,
    }
  }
  const walkedFiles = stages.files.list
  if (stages.files.truncated) {
    truncated = true
    notes.push('El proyecto tiene muchísimos archivos y analizamos los más relevantes.')
  }
  if (walkedFiles.length === 0) {
    notes.push('No encontramos archivos de código para analizar.')
  }
  await report('descubriendo-archivos')

  /* Etapa 2 — con qué está hecho. */
  ensureAlive(options.signal)
  if (!stages.stack) {
    stages.stack = await detectStack(options.root)
  }
  const stack = stages.stack
  await report('detectando-tecnologia')

  /* Etapa 3 — las pantallas. Salen del filesystem, sin modelo de por medio. */
  ensureAlive(options.signal)
  if (!stages.routes) {
    stages.routes = await detectRoutes(options.root, { stack, files: walkedFiles })
  }
  const routes = stages.routes
  await report('mapeando-pantallas')

  /* Etapa 4 — leer el código. Es la etapa larga, informa progreso fino. */
  ensureAlive(options.signal)
  const { kept: analyzable, dropped } = prioritizeFiles(
    walkedFiles.filter((file) => CODE_EXTENSIONS.has(file.extension)),
    limits.maxParsedFiles,
  )
  if (dropped > 0) {
    truncated = true
    notes.push(
      `El proyecto tiene ${dropped} archivo${dropped === 1 ? '' : 's'} de código más de los que analizamos en profundidad. Priorizamos las pantallas y el código de la app.`,
    )
  }

  if (!stages.facts) {
    // Las gramáticas se cargan una vez por corrida, no una vez por archivo.
    await warmUpParser(
      [...new Set(analyzable.map((file) => languageOf(file.relative)).filter(Boolean))] as SourceLanguage[],
    )

    const limit = pLimit(limits.concurrency)
    const facts: SourceFacts[] = []
    let done = 0
    const stageStart = STAGE_END['mapeando-pantallas']
    const stageSpan = STAGE_END['leyendo-codigo'] - stageStart

    await Promise.all(
      analyzable.map((file) =>
        limit(async () => {
          ensureAlive(options.signal)
          const source = await readTextFile(file.absolute)
          if (source !== null && languageOf(file.relative)) {
            facts.push(await analyzeSource(file.relative, source, { maxBytes: limits.maxFileBytes }))
          }
          done++
          if (done % 25 === 0 || done === analyzable.length) {
            await options.onProgress?.(
              'leyendo-codigo',
              Math.round(stageStart + (stageSpan * done) / Math.max(analyzable.length, 1)),
            )
          }
        }),
      ),
    )

    facts.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
    stages.facts = facts
  }
  const facts = stages.facts

  /*
   * Constancia obligatoria del motor.
   *
   * Se calcula desde los hechos ya obtenidos, no desde una sonda aparte: así la
   * nota describe lo que efectivamente pasó, incluso al reanudar una corrida. El
   * motor no puede pasar a heurístico en silencio — es la diferencia entre un
   * análisis estructural y uno adivinado, y el usuario tiene derecho a saberlo.
   */
  const conAst = facts.filter((fact) => fact.engine === 'tree-sitter').length
  const conLector = facts.filter((fact) => fact.engine === 'lector-directo').length

  if (facts.length === 0) {
    notes.push('No encontramos archivos de código para leer.')
  } else if (conLector === 0) {
    notes.push(
      `Leímos ${conAst} archivo${conAst === 1 ? '' : 's'} de código con el analizador de sintaxis, que entiende la estructura real de cada archivo.`,
    )
  } else if (conAst === 0) {
    const capability = await parserCapability()
    notes.push(
      `Leímos ${conLector} archivo${conLector === 1 ? '' : 's'} de código con el lector simple, no con el analizador de sintaxis${
        capability.reason ? ` (${capability.reason})` : ''
      }. Los resultados valen igual, pero el mapa puede quedar un poco menos detallado.`,
    )
  } else {
    notes.push(
      `Leímos ${conAst} archivo${conAst === 1 ? '' : 's'} de código con el analizador de sintaxis y ${conLector} con el lector simple, porque el analizador no pudo con ${conLector === 1 ? 'ese' : 'esos'}.`,
    )
  }

  const broken = facts.filter((fact) => fact.parseError)
  if (broken.length > 0) {
    notes.push(
      `${broken.length} archivo${broken.length === 1 ? '' : 's'} parece${broken.length === 1 ? '' : 'n'} tener un problema de sintaxis. Los leímos igual y seguimos con el resto: ${broken
        .slice(0, 3)
        .map((fact) => fact.file)
        .join(', ')}${broken.length > 3 ? ' y otros' : ''}.`,
    )
  }
  await report('leyendo-codigo')

  /* Etapa 5 — el mapa de quién usa a quién. */
  ensureAlive(options.signal)
  if (!stages.graph) {
    const graph = buildSymbolGraph(
      facts,
      walkedFiles.map((file) => file.relative),
      { routes },
    )
    stages.graph = { symbols: graph.symbols, edges: graph.edges, fileEdges: graph.fileEdges }
  }
  const graph = stages.graph
  await report('armando-mapa')

  /* Etapa 6 — qué archivos son centrales. Es una cuenta, no una opinión. */
  ensureAlive(options.signal)
  const exportCounts = new Map(facts.map((fact) => [fact.file, fact.exports.length]))
  const lineCounts = new Map(facts.map((fact) => [fact.file, fact.lineCount]))
  const rankedFiles = rankFiles({
    files: facts.map((fact) => fact.file),
    edges: graph.fileEdges,
    context: { routes, exportCounts, lineCounts },
  })
  await report('calculando-importancia')

  /* Etapa 7 — la base de datos. Se carga acá para no arrastrar `pg` si no hace falta. */
  ensureAlive(options.signal)
  if (!stages.dbSchema) {
    const { readSchema } = await import('./db-schema')
    stages.dbSchema = await readSchema(options.root, {
      databaseUrl: options.databaseUrl,
      files: walkedFiles,
      stack,
    })
  }
  notes.push(...stages.dbSchema.notes)
  await report('leyendo-base-de-datos')

  const index: CodeIndex = {
    fileCount: walkedFiles.length,
    totalBytes: stages.files.totalBytes,
    languages: languageBreakdown(walkedFiles),
    routes,
    symbols: graph.symbols,
    edges: graph.edges,
    rankedFiles,
    dbSchema: stages.dbSchema.snapshot,
    truncated,
    notes,
  }

  return { index, stack, stages }
}

export { STAGE_LABEL as ETAPAS }
export type { SourceFacts } from './parser'
export { detectRoutes } from './routes'
export { buildSymbolGraph } from './symbols'
export { pageRank, rankFiles } from './pagerank'
export { summarizeProject, structuralSummary } from './summarize'
