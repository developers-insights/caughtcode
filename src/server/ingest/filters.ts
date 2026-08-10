import 'server-only'

/**
 * Reglas compartidas de ingesta: qué entra, qué se descarta y con qué límites.
 *
 * Lo usan `zip.ts` (al descomprimir), `stack.ts` (al buscar archivos marcadores)
 * y `analysis/index.ts` (al recorrer el código ya en disco). Un solo lugar para
 * que el descarte sea idéntico en los tres.
 */

export const INGEST_LIMITS = {
  /** Un archivo de código nunca pesa esto. Arriba de acá es un asset disfrazado. */
  maxFileBytes: 5 * 1024 * 1024,
  /** Tamaño máximo del zip subido. */
  maxArchiveBytes: 200 * 1024 * 1024,
  /** Cantidad máxima de archivos aceptados. */
  maxFiles: 20_000,
  /** Suma máxima de lo descomprimido. Corta bombas que pasan los otros filtros. */
  maxTotalExtractedBytes: 150 * 1024 * 1024,
  /** Relación descomprimido/comprimido a partir de la cual sospechamos una bomba. */
  maxCompressionRatio: 120,
  /**
   * Un archivo solo se considera bomba si además de comprimir rarísimo es
   * enorme. Sin este piso, un archivo de código legítimo lleno de repeticiones
   * (que comprime muy bien) se confundiría con un ataque: ese caso se descarta
   * por tamaño, no acusando al usuario.
   */
  bombMinBytes: 25 * 1024 * 1024,
  /** Suma de todo lo que el zip *dice* que ocupa. Corta ataques de muchas entradas chicas. */
  maxDeclaredUncompressedBytes: 2 * 1024 * 1024 * 1024,
  /** Un lockfile más grande que esto no aporta nada al análisis. */
  maxLockfileBytes: 2 * 1024 * 1024,
  /** Rutas absurdamente largas suelen ser intentos de romper el extractor. */
  maxPathLength: 400,
  /** Profundidad máxima de carpetas. */
  maxPathDepth: 40,
} as const

export type IgnoreCode =
  | 'dependencias'
  | 'control_versiones'
  | 'compilado'
  | 'binario'
  | 'lockfile_grande'
  | 'archivo_pesado'
  | 'ruta_insegura'
  | 'enlace_simbolico'
  | 'demasiados_archivos'
  | 'demasiado_contenido'
  | 'archivo_comprimido_sospechoso'

/** Texto para mostrarle al usuario. Español, sin jerga. */
export const IGNORE_MESSAGE: Record<IgnoreCode, string> = {
  dependencias: 'Son librerías de terceros, no código tuyo.',
  control_versiones: 'Es el historial de Git, no código de la app.',
  compilado: 'Es el resultado de compilar, no el código original.',
  binario: 'Es una imagen, fuente o archivo binario: no hay nada que leer.',
  lockfile_grande: 'Es la lista de versiones de las librerías y pesa demasiado para leerla entera.',
  archivo_pesado: 'Pesa más de 5 MB. Un archivo de código nunca pesa tanto.',
  ruta_insegura: 'La ubicación del archivo apunta fuera de la carpeta del proyecto.',
  enlace_simbolico: 'Es un acceso directo a otra ubicación del disco.',
  demasiados_archivos: 'El proyecto supera los 20.000 archivos y se analizó una parte.',
  demasiado_contenido: 'El contenido descomprimido supera el máximo permitido.',
  archivo_comprimido_sospechoso:
    'Al descomprimirse crece muchísimo más de lo normal. Puede ser un archivo preparado para saturar el servidor.',
}

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'bower_components',
  'vendor',
  'Pods',
  '.yarn',
  '.pnpm-store',
  '.venv',
  'venv',
  'env',
  '__pycache__',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  '.dart_tool',
  '.gradle',
  '.terraform',
  '.idea',
  '.vscode',
  '.cache',
  '.parcel-cache',
  '.turbo',
  '.vercel',
  '.netlify',
  '.expo',
  '.serverless',
])

const BUILD_DIRS = new Set([
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
  '.astro',
  '.angular',
  'coverage',
  'storybook-static',
  '.docusaurus',
  'target',
  'DerivedData',
])

const IGNORED_FILES = new Set([
  '.DS_Store',
  'Thumbs.db',
  '.gitattributes',
  '.gitkeep',
])

const BINARY_EXTENSIONS = new Set([
  // imágenes
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'icns', 'tiff', 'heic', 'psd', 'ai',
  // fuentes
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  // audio y video
  'mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'mp4', 'webm', 'mov', 'avi', 'mkv', 'wmv',
  // comprimidos
  'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'jar', 'war',
  // binarios y bases
  'wasm', 'exe', 'dll', 'so', 'dylib', 'bin', 'o', 'a', 'class', 'pyc', 'pyo',
  'db', 'sqlite', 'sqlite3', 'mdb', 'pdb', 'dat',
  // documentos
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  // móvil / escritorio
  'apk', 'aab', 'ipa', 'dmg', 'pkg', 'deb', 'rpm', 'msi', 'app', 'xcarchive',
  // modelos y mapas
  'glb', 'gltf', 'fbx', 'obj', 'blend', 'map',
])

const LOCKFILES = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
  'Cargo.lock',
  'poetry.lock',
  'Pipfile.lock',
  'Gemfile.lock',
  'composer.lock',
  'pubspec.lock',
  'Podfile.lock',
])

/** Extensiones cuyo contenido nos sirve para el análisis. */
const TEXT_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts',
  'json', 'jsonc', 'json5',
  'css', 'scss', 'sass', 'less', 'postcss',
  'html', 'htm', 'vue', 'svelte', 'astro',
  'md', 'mdx', 'txt',
  'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'properties',
  'sql', 'prisma', 'graphql', 'gql',
  'dart', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'php', 'cs', 'sh', 'bash', 'zsh',
  'env', 'example', 'sample', 'lock', 'xml', 'plist', 'gradle', 'podspec', 'gemspec',
])

/** Archivos sin extensión que igual queremos leer. */
const KNOWN_EXTENSIONLESS = new Set([
  'Dockerfile',
  'Procfile',
  'Makefile',
  'LICENSE',
  'README',
  'CHANGELOG',
  'CODEOWNERS',
])

export function extensionOf(filePath: string): string {
  const base = filePath.slice(filePath.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return ''
  return base.slice(dot + 1).toLowerCase()
}

export function baseNameOf(filePath: string): string {
  return filePath.slice(filePath.lastIndexOf('/') + 1)
}

export function isLockfile(filePath: string): boolean {
  return LOCKFILES.has(baseNameOf(filePath))
}

export function isBinaryExtension(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(extensionOf(filePath))
}

/** true si el contenido nos sirve para analizar (no es binario ni desconocido enorme). */
export function isReadableText(filePath: string): boolean {
  const base = baseNameOf(filePath)
  if (KNOWN_EXTENSIONLESS.has(base)) return true
  if (base.startsWith('.env')) return true
  const ext = extensionOf(filePath)
  if (!ext) return false
  if (BINARY_EXTENSIONS.has(ext)) return false
  return TEXT_EXTENSIONS.has(ext)
}

/**
 * Normaliza el nombre de una entrada de zip a una ruta relativa segura.
 * Devuelve `null` si la ruta intenta salirse de la carpeta destino.
 */
export function safeRelativePath(rawName: string): string | null {
  if (!rawName) return null
  if (rawName.includes('\0')) return null
  if (rawName.length > INGEST_LIMITS.maxPathLength) return null

  // Windows y algunos zips usan backslash como separador.
  let name = rawName.replace(/\\/g, '/')

  // Rutas absolutas (unix, UNC o con letra de unidad) quedan afuera.
  if (name.startsWith('/')) return null
  if (/^[a-zA-Z]:/.test(name)) return null

  const segments: string[] = []
  for (const segment of name.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') return null
    segments.push(segment)
  }
  if (segments.length === 0) return null
  if (segments.length > INGEST_LIMITS.maxPathDepth) return null

  name = segments.join('/')
  return name
}

export interface IgnoreVerdict {
  ignore: boolean
  code?: IgnoreCode
  message?: string
}

const KEEP: IgnoreVerdict = { ignore: false }

function reject(code: IgnoreCode): IgnoreVerdict {
  return { ignore: true, code, message: IGNORE_MESSAGE[code] }
}

/**
 * Decide si una ruta relativa entra al análisis, mirando solo el nombre.
 * `sizeBytes` es opcional: si se conoce, aplica también los límites de tamaño.
 */
export function classifyPath(relativePath: string, sizeBytes?: number): IgnoreVerdict {
  const segments = relativePath.split('/')
  const base = segments[segments.length - 1] ?? ''

  for (const segment of segments.slice(0, -1)) {
    if (IGNORED_DIRS.has(segment)) {
      return reject(segment === '.git' ? 'control_versiones' : 'dependencias')
    }
    if (BUILD_DIRS.has(segment)) return reject('compilado')
  }

  if (IGNORED_FILES.has(base)) return reject('binario')
  if (isBinaryExtension(relativePath)) return reject('binario')

  if (isLockfile(relativePath)) {
    if (sizeBytes !== undefined && sizeBytes > INGEST_LIMITS.maxLockfileBytes) {
      return reject('lockfile_grande')
    }
    return KEEP
  }

  if (sizeBytes !== undefined && sizeBytes > INGEST_LIMITS.maxFileBytes) {
    return reject('archivo_pesado')
  }

  if (!isReadableText(relativePath)) return reject('binario')

  return KEEP
}

/** Carpetas que nunca hay que recorrer al caminar el árbol ya extraído. */
export function isIgnoredDirName(name: string): boolean {
  return IGNORED_DIRS.has(name) || BUILD_DIRS.has(name)
}
