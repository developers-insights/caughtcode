import 'server-only'

/**
 * La **única** parte del motor que usa un modelo de lenguaje, y va al final
 * (D13): sobre el subgrafo ya filtrado, no sobre el repositorio entero.
 *
 * El cliente del modelo entra por parámetro (`complete`). Así este módulo se
 * puede probar sin red y el proveedor se cambia sin tocar el motor.
 *
 * Si el modelo falla, se devuelve igual un resumen armado con los datos
 * estructurales. Nunca se inventa: lo que no se sabe, no se dice.
 */

import type { CodeIndex, RouteInfo, StackInfo } from '@/lib/types/domain'

/** Función que le habla al modelo. La inyecta quien llama. */
export type CompleteFn = (prompt: string) => Promise<string>

export interface ProjectModule {
  /** Nombre en castellano, entendible: "Cuentas y sesión", no "auth module". */
  name: string
  /** Qué hace, en una o dos oraciones sin jerga. */
  purpose: string
  /** Archivos que respaldan esta descripción. Sin esto el módulo no se emite. */
  files: string[]
}

export interface ProjectSummary {
  /** Qué es la app, en dos o tres oraciones. */
  overview: string
  modules: ProjectModule[]
  /** De dónde salió: del modelo o armado con los datos del análisis. */
  source: 'modelo' | 'estructura'
  notes: string[]
}

const MAX_ROUTES_IN_PROMPT = 40
const MAX_FILES_IN_PROMPT = 30

function topDirectories(files: string[], limit = 12): Array<{ dir: string; count: number }> {
  const counts = new Map<string, number>()
  for (const file of files) {
    const parts = file.split('/')
    const dir = parts.length > 2 ? parts.slice(0, 2).join('/') : parts[0]
    counts.set(dir, (counts.get(dir) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([dir, count]) => ({ dir, count }))
    .sort((a, b) => b.count - a.count || (a.dir < b.dir ? -1 : 1))
    .slice(0, limit)
}

function describeRoutes(routes: RouteInfo[]): string {
  const pages = routes.filter((route) => route.kind === 'page').slice(0, MAX_ROUTES_IN_PROMPT)
  if (pages.length === 0) return '(no se detectaron pantallas)'
  return pages
    .map((route) => `- ${route.path}${route.looksProtected ? ' (parece requerir cuenta)' : ''} → ${route.file}`)
    .join('\n')
}

export function buildPrompt(index: CodeIndex, stack: StackInfo): string {
  const topFiles = index.rankedFiles.slice(0, MAX_FILES_IN_PROMPT)
  const directories = topDirectories(index.rankedFiles.map((file) => file.file))

  return [
    'Sos parte de una herramienta que le explica a alguien SIN conocimientos técnicos qué hace la app que construyó con inteligencia artificial.',
    '',
    'Datos del proyecto (obtenidos leyendo el código, no inventados):',
    `- Tecnología: ${stack.framework}, lenguaje ${stack.language}.`,
    `- Servicios de datos detectados: ${stack.backends.join(', ')}.`,
    `- Cantidad de archivos analizados: ${index.fileCount}.`,
    '',
    'Pantallas encontradas:',
    describeRoutes(index.routes),
    '',
    'Archivos más centrales (calculados matemáticamente, no estimados):',
    ...topFiles.map((file) => `- ${file.file} — ${file.reason}`),
    '',
    'Carpetas con más archivos:',
    ...directories.map((entry) => `- ${entry.dir} (${entry.count} archivos)`),
    '',
    'Devolvé SOLO un JSON con esta forma exacta, sin texto alrededor y sin bloques de código:',
    '{"overview": "...", "modules": [{"name": "...", "purpose": "...", "files": ["..."]}]}',
    '',
    'Reglas que no se negocian:',
    '- Escribí en español rioplatense, claro y directo. Nada de "vos deberías"; hablale de igual a igual.',
    '- CERO jerga. Nada de "endpoint", "middleware", "RLS", "ORM", "backend". Si hay que nombrar algo técnico, explicalo con palabras comunes.',
    '- "overview": 2 o 3 oraciones sobre qué hace la app y para quién.',
    '- Máximo 6 módulos. Cada uno tiene que corresponder a archivos que aparecen arriba; poné esos archivos en "files".',
    '- Si algo no se puede saber con estos datos, no lo menciones. Está prohibido suponer.',
    '- Nada de opiniones sobre el diseño ni sobre si el código está bien o mal hecho.',
  ].join('\n')
}

function extractJson(raw: string): unknown {
  const trimmed = raw.trim()
  const withoutFence = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const start = withoutFence.indexOf('{')
  const end = withoutFence.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) throw new Error('la respuesta no trae un JSON')
  return JSON.parse(withoutFence.slice(start, end + 1))
}

/**
 * Descarta cualquier módulo que cite archivos que no existen en el índice.
 * Es la regla de "nada sin evidencia" aplicada al resumen.
 */
function keepGrounded(modules: unknown, knownFiles: Set<string>): { modules: ProjectModule[]; dropped: number } {
  if (!Array.isArray(modules)) return { modules: [], dropped: 0 }
  const result: ProjectModule[] = []
  let dropped = 0

  for (const raw of modules.slice(0, 12)) {
    if (typeof raw !== 'object' || raw === null) continue
    const candidate = raw as Record<string, unknown>
    const name = typeof candidate.name === 'string' ? candidate.name.trim() : ''
    const purpose = typeof candidate.purpose === 'string' ? candidate.purpose.trim() : ''
    const files = Array.isArray(candidate.files)
      ? candidate.files.filter((file): file is string => typeof file === 'string' && knownFiles.has(file))
      : []

    if (!name || !purpose || files.length === 0) {
      dropped++
      continue
    }
    result.push({ name, purpose, files: files.slice(0, 8) })
  }
  return { modules: result.slice(0, 6), dropped }
}

/** Resumen sin modelo: sale de las pantallas y las carpetas. Se usa si el modelo falla. */
export function structuralSummary(index: CodeIndex, stack: StackInfo): ProjectSummary {
  const pages = index.routes.filter((route) => route.kind === 'page')
  const protectedPages = pages.filter((route) => route.looksProtected)

  const overviewParts: string[] = []
  if (pages.length > 0) {
    overviewParts.push(
      `El proyecto tiene ${pages.length} pantalla${pages.length === 1 ? '' : 's'}${
        protectedPages.length > 0
          ? `, de las cuales ${protectedPages.length} parece${protectedPages.length === 1 ? '' : 'n'} necesitar una cuenta para entrar`
          : ''
      }.`,
    )
  }
  if (stack.backends.length > 0 && stack.backends[0] !== 'none') {
    overviewParts.push(`Los datos se guardan con ${stack.backends.join(' y ')}.`)
  }
  overviewParts.push(`Analizamos ${index.fileCount} archivos de código.`)

  const modules = topDirectories(index.rankedFiles.map((file) => file.file), 6).map((entry) => ({
    name: entry.dir,
    purpose: `Agrupa ${entry.count} archivo${entry.count === 1 ? '' : 's'} del proyecto.`,
    files: index.rankedFiles
      .filter((file) => file.file.startsWith(entry.dir + '/'))
      .slice(0, 5)
      .map((file) => file.file),
  }))

  return {
    overview: overviewParts.join(' '),
    modules: modules.filter((module) => module.files.length > 0),
    source: 'estructura',
    notes: [],
  }
}

export interface SummarizeOptions {
  /** Si no se pasa, se devuelve directamente el resumen estructural. */
  complete?: CompleteFn
}

export async function summarizeProject(
  index: CodeIndex,
  stack: StackInfo,
  options: SummarizeOptions = {},
): Promise<ProjectSummary> {
  const fallback = structuralSummary(index, stack)
  if (!options.complete) return fallback

  const knownFiles = new Set(index.rankedFiles.map((file) => file.file))

  try {
    const raw = await options.complete(buildPrompt(index, stack))
    const parsed = extractJson(raw) as Record<string, unknown>
    const overview = typeof parsed.overview === 'string' ? parsed.overview.trim() : ''
    const { modules, dropped } = keepGrounded(parsed.modules, knownFiles)

    if (!overview || modules.length === 0) {
      return {
        ...fallback,
        notes: ['El resumen automático no cumplió el formato esperado, así que lo armamos con los datos del análisis.'],
      }
    }

    const notes: string[] = []
    if (dropped > 0) {
      notes.push(
        `Descartamos ${dropped} parte${dropped === 1 ? '' : 's'} del resumen porque mencionaba archivos que no están en el proyecto.`,
      )
    }
    return { overview, modules, source: 'modelo', notes }
  } catch (error) {
    return {
      ...fallback,
      notes: [
        `No pudimos generar el resumen escrito (${error instanceof Error ? error.message : 'error desconocido'}). Mostramos lo que sacamos del código.`,
      ],
    }
  }
}
