import 'server-only'

/**
 * Recorrido del código ya en disco. Aplica las mismas reglas de descarte que la
 * ingesta, así lo que se analiza es exactamente lo que se guardó.
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'

import { INGEST_LIMITS, classifyPath, isIgnoredDirName } from '@/server/ingest/filters'

export interface WalkedFile {
  /** Ruta relativa a la raíz, siempre con "/". */
  relative: string
  absolute: string
  bytes: number
  extension: string
}

export interface WalkResult {
  files: WalkedFile[]
  totalBytes: number
  /** true si se cortó por límite de cantidad. */
  truncated: boolean
  skipped: number
}

export interface WalkOptions {
  maxFiles?: number
  maxFileBytes?: number
}

export async function walkFiles(root: string, options: WalkOptions = {}): Promise<WalkResult> {
  const maxFiles = options.maxFiles ?? INGEST_LIMITS.maxFiles
  const maxFileBytes = options.maxFileBytes ?? INGEST_LIMITS.maxFileBytes

  const files: WalkedFile[] = []
  let totalBytes = 0
  let skipped = 0
  let truncated = false

  // Recorrido iterativo y ordenado: el índice tiene que salir igual en cada corrida.
  const queue: string[] = ['']
  while (queue.length > 0) {
    const relativeDir = queue.shift() as string
    const absoluteDir = relativeDir ? path.join(root, relativeDir) : root

    let entries
    try {
      entries = await readdir(absoluteDir, { withFileTypes: true })
    } catch {
      continue
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

    for (const entry of entries) {
      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name

      if (entry.isSymbolicLink()) {
        skipped++
        continue
      }
      if (entry.isDirectory()) {
        if (isIgnoredDirName(entry.name)) continue
        queue.push(relative)
        continue
      }
      if (!entry.isFile()) continue

      if (files.length >= maxFiles) {
        truncated = true
        continue
      }

      let size = 0
      try {
        size = (await stat(path.join(root, relative))).size
      } catch {
        continue
      }

      const verdict = classifyPath(relative, size)
      if (verdict.ignore) {
        skipped++
        continue
      }
      if (size > maxFileBytes) {
        skipped++
        continue
      }

      files.push({
        relative,
        absolute: path.join(root, relative),
        bytes: size,
        extension: entry.name.slice(entry.name.lastIndexOf('.') + 1).toLowerCase(),
      })
      totalBytes += size
    }
  }

  files.sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0))
  return { files, totalBytes, truncated, skipped }
}

export async function readTextFile(absolute: string): Promise<string | null> {
  try {
    return await readFile(absolute, 'utf8')
  } catch {
    return null
  }
}

/** Cuenta de archivos por lenguaje, para `CodeIndex.languages`. */
export function languageBreakdown(files: WalkedFile[]): Record<string, number> {
  const map: Record<string, number> = {}
  for (const file of files) {
    const key = file.extension || 'sin extensión'
    map[key] = (map[key] ?? 0) + 1
  }
  return map
}
