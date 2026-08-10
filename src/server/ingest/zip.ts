import 'server-only'

/**
 * Descompresión defensiva de zips subidos por el usuario.
 *
 * El zip es un camino de ingesta de primera: mucha gente que armó su app con IA
 * no tiene GitHub. También es la vía por donde entra el archivo de GitHub
 * (`zipball`), así que este es el único extractor del producto.
 *
 * Antes de descomprimir nada leemos el directorio central del zip: ahí están los
 * tamaños reales y los permisos de cada entrada. Eso permite frenar bombas de
 * descompresión, rutas que se escapan de la carpeta y enlaces simbólicos *antes*
 * de gastar memoria o tocar el disco.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { unzipSync } from 'fflate'

import {
  INGEST_LIMITS,
  IGNORE_MESSAGE,
  classifyPath,
  isLockfile,
  safeRelativePath,
  type IgnoreCode,
} from './filters'
import { resolveInside } from './workspace'

const SIG_EOCD = 0x06054b50
const SIG_ZIP64_LOCATOR = 0x07064b50
const SIG_ZIP64_EOCD = 0x06064b50
const SIG_CENTRAL = 0x02014b50

const MAX_U32 = 0xffffffff

export type ZipRejectionCode =
  | IgnoreCode
  | 'zip_invalido'
  | 'zip_vacio'
  | 'zip_demasiado_grande'
  | 'zip_cifrado'

/** Error con mensaje ya escrito para mostrarle al usuario. */
export class ZipRejectedError extends Error {
  readonly code: ZipRejectionCode

  constructor(code: ZipRejectionCode, message: string) {
    super(message)
    this.name = 'ZipRejectedError'
    this.code = code
  }
}

export interface ZipEntry {
  /** Nombre tal cual aparece en el zip. */
  rawName: string
  compressedSize: number
  uncompressedSize: number
  compressionMethod: number
  isDirectory: boolean
  isSymlink: boolean
  isEncrypted: boolean
}

function u16(view: DataView, offset: number): number {
  return view.getUint16(offset, true)
}

function u32(view: DataView, offset: number): number {
  return view.getUint32(offset, true)
}

function u64(view: DataView, offset: number): number {
  const value = view.getBigUint64(offset, true)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ZipRejectedError('zip_invalido', 'El archivo declara tamaños imposibles.')
  }
  return Number(value)
}

function decodeName(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

/**
 * Lee el directorio central sin descomprimir nada.
 * Es la fuente de verdad para tamaños, permisos y cantidad de entradas.
 */
export function readCentralDirectory(data: Uint8Array): ZipEntry[] {
  if (data.byteLength < 22) {
    throw new ZipRejectedError('zip_invalido', 'El archivo está incompleto o no es un .zip.')
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)

  // El comentario final puede medir hasta 65535 bytes: buscamos la firma hacia atrás.
  const scanStart = Math.max(0, data.byteLength - 22 - 0xffff)
  let eocd = -1
  for (let i = data.byteLength - 22; i >= scanStart; i--) {
    if (u32(view, i) === SIG_EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) {
    throw new ZipRejectedError('zip_invalido', 'No pudimos leer el archivo: no parece un .zip válido.')
  }

  let totalEntries = u16(view, eocd + 10)
  let centralOffset = u32(view, eocd + 16)
  let centralSize = u32(view, eocd + 12)

  // Zip64: los campos de 32 bits quedan saturados y los verdaderos están en otro registro.
  if (totalEntries === 0xffff || centralOffset === MAX_U32 || centralSize === MAX_U32) {
    const locator = eocd - 20
    if (locator >= 0 && u32(view, locator) === SIG_ZIP64_LOCATOR) {
      const zip64Offset = u64(view, locator + 8)
      if (zip64Offset >= 0 && zip64Offset + 56 <= data.byteLength && u32(view, zip64Offset) === SIG_ZIP64_EOCD) {
        totalEntries = u64(view, zip64Offset + 32)
        centralSize = u64(view, zip64Offset + 40)
        centralOffset = u64(view, zip64Offset + 48)
      }
    }
  }

  if (centralOffset + centralSize > data.byteLength) {
    throw new ZipRejectedError('zip_invalido', 'El archivo está truncado: le falta información al final.')
  }
  if (totalEntries > INGEST_LIMITS.maxFiles) {
    throw new ZipRejectedError(
      'demasiados_archivos',
      `El proyecto tiene ${totalEntries.toLocaleString('es-AR')} archivos y el máximo es ${INGEST_LIMITS.maxFiles.toLocaleString('es-AR')}. Probá subiendo solo la carpeta de la app, sin dependencias ni compilados.`,
    )
  }

  const entries: ZipEntry[] = []
  let offset = centralOffset
  for (let index = 0; index < totalEntries; index++) {
    if (offset + 46 > data.byteLength || u32(view, offset) !== SIG_CENTRAL) {
      throw new ZipRejectedError('zip_invalido', 'El archivo está dañado: no pudimos leer su índice interno.')
    }
    const versionMadeBy = u16(view, offset + 4)
    const flags = u16(view, offset + 8)
    const compressionMethod = u16(view, offset + 10)
    let compressedSize = u32(view, offset + 20)
    let uncompressedSize = u32(view, offset + 24)
    const nameLength = u16(view, offset + 28)
    const extraLength = u16(view, offset + 30)
    const commentLength = u16(view, offset + 32)
    const externalAttributes = u32(view, offset + 38)

    const nameStart = offset + 46
    const rawName = decodeName(data.subarray(nameStart, nameStart + nameLength))

    // Campo extra Zip64 (id 0x0001): reemplaza los tamaños saturados.
    if (compressedSize === MAX_U32 || uncompressedSize === MAX_U32) {
      let extraOffset = nameStart + nameLength
      const extraEnd = extraOffset + extraLength
      while (extraOffset + 4 <= extraEnd) {
        const fieldId = u16(view, extraOffset)
        const fieldSize = u16(view, extraOffset + 2)
        if (fieldId === 0x0001) {
          let cursor = extraOffset + 4
          if (uncompressedSize === MAX_U32 && cursor + 8 <= extraEnd) {
            uncompressedSize = u64(view, cursor)
            cursor += 8
          }
          if (compressedSize === MAX_U32 && cursor + 8 <= extraEnd) {
            compressedSize = u64(view, cursor)
          }
          break
        }
        extraOffset += 4 + fieldSize
      }
    }

    const madeByUnix = versionMadeBy >>> 8
    const unixMode = (externalAttributes >>> 16) & 0xffff
    const looksUnix = madeByUnix === 3 || madeByUnix === 19
    const isSymlink = looksUnix && (unixMode & 0xf000) === 0xa000
    const isDirectory =
      rawName.endsWith('/') || (looksUnix && (unixMode & 0xf000) === 0x4000)

    entries.push({
      rawName,
      compressedSize,
      uncompressedSize,
      compressionMethod,
      isDirectory,
      isSymlink,
      // Bit 0 de los flags generales = contenido cifrado con contraseña.
      isEncrypted: (flags & 0x0001) !== 0,
    })

    offset = nameStart + nameLength + extraLength + commentLength
  }

  return entries
}

export interface SkippedEntry {
  path: string
  code: IgnoreCode
  message: string
}

export interface ExtractResult {
  /** Rutas relativas efectivamente escritas en disco. */
  files: string[]
  totalBytes: number
  skipped: SkippedEntry[]
  /**
   * Archivos que existen en el proyecto pero cuyo contenido no guardamos.
   * Sirven para detectar el stack por nombre (por ejemplo un lockfile enorme).
   */
  presentButSkipped: string[]
  /** Mensajes para mostrarle al usuario. */
  warnings: string[]
}

export interface ExtractOptions {
  /** Los zips de GitHub traen todo dentro de una carpeta con el hash del commit. */
  stripTopLevelDir?: boolean | 'auto'
  maxArchiveBytes?: number
  maxFiles?: number
  maxTotalExtractedBytes?: number
}

function commonTopLevelDir(paths: string[]): string | null {
  if (paths.length === 0) return null
  let candidate: string | null = null
  for (const relative of paths) {
    const slash = relative.indexOf('/')
    if (slash <= 0) return null
    const top = relative.slice(0, slash)
    if (candidate === null) candidate = top
    else if (candidate !== top) return null
  }
  return candidate
}

/**
 * Descomprime en `destDir` aplicando todos los límites.
 * Tira `ZipRejectedError` (con mensaje listo para mostrar) ante algo peligroso.
 */
export async function extractZip(
  data: Uint8Array,
  destDir: string,
  options: ExtractOptions = {},
): Promise<ExtractResult> {
  const maxArchiveBytes = options.maxArchiveBytes ?? INGEST_LIMITS.maxArchiveBytes
  const maxFiles = options.maxFiles ?? INGEST_LIMITS.maxFiles
  const maxTotalExtractedBytes = options.maxTotalExtractedBytes ?? INGEST_LIMITS.maxTotalExtractedBytes

  if (data.byteLength === 0) {
    throw new ZipRejectedError('zip_vacio', 'El archivo está vacío.')
  }
  if (data.byteLength > maxArchiveBytes) {
    const mb = Math.round(maxArchiveBytes / (1024 * 1024))
    throw new ZipRejectedError(
      'zip_demasiado_grande',
      `El archivo pesa más de ${mb} MB. Subí solo la carpeta de tu app, sin la carpeta de dependencias ni los compilados.`,
    )
  }

  const entries = readCentralDirectory(data)
  if (entries.length === 0) {
    throw new ZipRejectedError('zip_vacio', 'El archivo no tiene nada adentro.')
  }

  // Cuánto dice el zip que ocupa todo junto. Corta el ataque de muchísimas
  // entradas chicas, donde ninguna sola llama la atención.
  const declaredTotal = entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0)
  if (declaredTotal > INGEST_LIMITS.maxDeclaredUncompressedBytes) {
    throw new ZipRejectedError(
      'archivo_comprimido_sospechoso',
      `${IGNORE_MESSAGE.archivo_comprimido_sospechoso} El contenido declarado supera los ${Math.round(INGEST_LIMITS.maxDeclaredUncompressedBytes / (1024 * 1024 * 1024))} GB.`,
    )
  }

  const skipped: SkippedEntry[] = []
  const warnings: string[] = []
  const presentButSkipped: string[] = []

  // Paso 1: normalizar rutas. Cualquier intento de salirse de la carpeta corta todo.
  const normalized: Array<{ entry: ZipEntry; relative: string }> = []
  for (const entry of entries) {
    if (entry.isDirectory) continue
    const relative = safeRelativePath(entry.rawName)
    if (relative === null) {
      throw new ZipRejectedError(
        'ruta_insegura',
        `El archivo contiene una ruta que apunta fuera de la carpeta del proyecto ("${entry.rawName}"). No lo abrimos por seguridad.`,
      )
    }
    normalized.push({ entry, relative })
  }

  if (normalized.length === 0) {
    throw new ZipRejectedError('zip_vacio', 'El archivo solo tiene carpetas vacías.')
  }

  // Paso 2: sacar la carpeta contenedora si todo cuelga de una sola.
  const strip = options.stripTopLevelDir ?? 'auto'
  let prefix: string | null = null
  if (strip === true || strip === 'auto') {
    prefix = commonTopLevelDir(normalized.map((item) => item.relative))
  }
  const relativeOf = (value: string) => (prefix ? value.slice(prefix.length + 1) : value)

  // Paso 3: decidir qué se descomprime, mirando tamaños reales sin descomprimir.
  const accepted = new Map<string, string>() // nombre crudo -> ruta relativa final
  let acceptedBytes = 0

  for (const { entry, relative } of normalized) {
    const target = relativeOf(relative)
    if (target.length === 0) continue

    if (entry.isEncrypted) {
      throw new ZipRejectedError(
        'zip_cifrado',
        'El archivo tiene contraseña y no podemos abrirlo. Subí una versión sin contraseña.',
      )
    }

    if (entry.isSymlink) {
      skipped.push({ path: target, code: 'enlace_simbolico', message: IGNORE_MESSAGE.enlace_simbolico })
      continue
    }

    // Bomba de descompresión: enorme *y* comprimiendo mucho más de lo normal.
    // Las dos condiciones juntas, para no acusar a un archivo grande legítimo.
    if (
      entry.uncompressedSize > INGEST_LIMITS.bombMinBytes &&
      entry.compressedSize > 0 &&
      entry.uncompressedSize / entry.compressedSize > INGEST_LIMITS.maxCompressionRatio
    ) {
      throw new ZipRejectedError(
        'archivo_comprimido_sospechoso',
        `${IGNORE_MESSAGE.archivo_comprimido_sospechoso} Lo detectamos en "${target}".`,
      )
    }

    const verdict = classifyPath(target, entry.uncompressedSize)
    if (verdict.ignore) {
      const code = verdict.code as IgnoreCode
      skipped.push({ path: target, code, message: verdict.message ?? IGNORE_MESSAGE[code] })
      if (isLockfile(target) || code === 'archivo_pesado') presentButSkipped.push(target)
      continue
    }

    // fflate solo sabe leer "sin comprimir" (0) y "deflate" (8).
    if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
      skipped.push({
        path: target,
        code: 'binario',
        message: 'Está comprimido con un formato que no sabemos leer.',
      })
      continue
    }

    if (accepted.size >= maxFiles) {
      throw new ZipRejectedError(
        'demasiados_archivos',
        `El proyecto supera los ${maxFiles.toLocaleString('es-AR')} archivos. Probá subiendo solo la carpeta de la app.`,
      )
    }

    acceptedBytes += entry.uncompressedSize
    if (acceptedBytes > maxTotalExtractedBytes) {
      const mb = Math.round(maxTotalExtractedBytes / (1024 * 1024))
      throw new ZipRejectedError(
        'demasiado_contenido',
        `El código descomprimido supera los ${mb} MB. Subí solo la carpeta de la app, sin dependencias ni compilados.`,
      )
    }

    accepted.set(entry.rawName, target)
  }

  if (accepted.size === 0) {
    throw new ZipRejectedError(
      'zip_vacio',
      'No encontramos archivos de código adentro. Fijate de subir la carpeta del proyecto, no la carpeta compilada.',
    )
  }

  // Paso 4: recién ahora descomprimimos, y solo lo aceptado.
  let unzipped: Record<string, Uint8Array>
  try {
    unzipped = unzipSync(data, { filter: (file) => accepted.has(file.name) })
  } catch (error) {
    throw new ZipRejectedError(
      'zip_invalido',
      `No pudimos abrir el archivo: está dañado o incompleto. (${error instanceof Error ? error.message : 'error desconocido'})`,
    )
  }

  const files: string[] = []
  let totalBytes = 0
  for (const [rawName, contents] of Object.entries(unzipped)) {
    const target = accepted.get(rawName)
    if (!target) continue
    // Última barrera antes de tocar el disco.
    const absolute = resolveInside(destDir, target)
    await mkdir(path.dirname(absolute), { recursive: true })
    await writeFile(absolute, contents)
    files.push(target)
    totalBytes += contents.byteLength
  }

  files.sort()

  const symlinkCount = skipped.filter((item) => item.code === 'enlace_simbolico').length
  if (symlinkCount > 0) {
    warnings.push(
      `Salteamos ${symlinkCount} acceso${symlinkCount === 1 ? '' : 's'} directo${symlinkCount === 1 ? '' : 's'} a otras ubicaciones del disco.`,
    )
  }
  const heavyCount = skipped.filter((item) => item.code === 'archivo_pesado').length
  if (heavyCount > 0) {
    warnings.push(`Salteamos ${heavyCount} archivo${heavyCount === 1 ? '' : 's'} de más de 5 MB.`)
  }

  return { files, totalBytes, skipped, presentButSkipped, warnings }
}
