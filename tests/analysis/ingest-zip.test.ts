import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ZipRejectedError, extractZip, readCentralDirectory } from '@/server/ingest/zip'
import { safeRelativePath } from '@/server/ingest/filters'
import { detectStack } from '@/server/ingest/stack'
import {
  zipBomba,
  zipConArchivoPesado,
  zipConBasura,
  zipConPathTraversal,
  zipConRutaAbsoluta,
  zipConSymlink,
  zipLimpio,
} from '../fixtures/zips'

let dest: string

/** Corre la extracción esperando que la rechace, y devuelve el error tipado. */
async function capturarRechazo(promise: Promise<unknown>): Promise<ZipRejectedError> {
  let capturado: unknown
  try {
    await promise
  } catch (error) {
    capturado = error
  }
  expect(capturado).toBeInstanceOf(ZipRejectedError)
  return capturado as ZipRejectedError
}

beforeEach(async () => {
  dest = await mkdtemp(path.join(tmpdir(), 'caughtcode-unzip-'))
})

afterEach(async () => {
  await rm(dest, { recursive: true, force: true })
})

describe('normalización de rutas', () => {
  it('rechaza cualquier forma de salirse de la carpeta', () => {
    expect(safeRelativePath('../fuera')).toBeNull()
    expect(safeRelativePath('a/../../fuera')).toBeNull()
    expect(safeRelativePath('/absoluto')).toBeNull()
    expect(safeRelativePath('C:\\windows\\system32')).toBeNull()
    expect(safeRelativePath('..\\..\\fuera')).toBeNull()
    expect(safeRelativePath('con\0nulo')).toBeNull()
  })

  it('acepta rutas normales y normaliza los separadores', () => {
    expect(safeRelativePath('src/app/page.tsx')).toBe('src/app/page.tsx')
    expect(safeRelativePath('src\\app\\page.tsx')).toBe('src/app/page.tsx')
    expect(safeRelativePath('./src/./a.ts')).toBe('src/a.ts')
  })
})

describe('lectura del índice del zip sin descomprimir', () => {
  it('encuentra todas las entradas con sus tamaños', () => {
    const entries = readCentralDirectory(zipLimpio())
    expect(entries).toHaveLength(3)
    for (const entry of entries) {
      expect(entry.uncompressedSize).toBeGreaterThan(0)
      expect(entry.isSymlink).toBe(false)
    }
  })

  it('reconoce un enlace simbólico por sus permisos', () => {
    const entries = readCentralDirectory(zipConSymlink())
    expect(entries.find((entry) => entry.rawName.endsWith('atajo'))?.isSymlink).toBe(true)
  })

  it('rechaza algo que no es un zip', () => {
    expect(() => readCentralDirectory(new TextEncoder().encode('esto no es un zip'))).toThrow(ZipRejectedError)
  })
})

describe('extractZip', () => {
  it('extrae un proyecto normal y le saca la carpeta contenedora', async () => {
    const result = await extractZip(zipLimpio(), dest)
    expect(result.files).toContain('package.json')
    expect(result.files).toContain('src/app/page.tsx')
    expect(result.files.some((file) => file.startsWith('mi-app/'))).toBe(false)
  })

  it('RECHAZA el zip con path traversal', async () => {
    await expect(extractZip(zipConPathTraversal(), dest)).rejects.toThrowError(ZipRejectedError)

    // Y no dejó nada escrito.
    const entries = await readdir(dest)
    expect(entries).toHaveLength(0)
  })

  it('el mensaje del rechazo se entiende sin ser técnico', async () => {
    const error = await capturarRechazo(extractZip(zipConPathTraversal(), dest))
    expect(error.code).toBe('ruta_insegura')
    expect(error.message).toMatch(/fuera de la carpeta del proyecto/i)
    expect(error.message).not.toMatch(/traversal|slip|ENOENT|undefined/i)
  })

  it('rechaza rutas absolutas', async () => {
    await expect(extractZip(zipConRutaAbsoluta(), dest)).rejects.toThrowError(ZipRejectedError)
  })

  it('rechaza la bomba de descompresión antes de gastar memoria', async () => {
    const error = await capturarRechazo(extractZip(zipBomba(), dest))
    expect(error.code).toBe('archivo_comprimido_sospechoso')
    expect(await readdir(dest)).toHaveLength(0)
  })

  it('saltea el enlace simbólico pero extrae el resto', async () => {
    const result = await extractZip(zipConSymlink(), dest)
    expect(result.files).toContain('package.json')
    expect(result.files).not.toContain('atajo')
    expect(result.skipped.some((item) => item.code === 'enlace_simbolico')).toBe(true)
    expect(result.warnings.join(' ')).toMatch(/acceso/i)

    // Y en disco no quedó ningún enlace.
    const written = await stat(path.join(dest, 'package.json'))
    expect(written.isSymbolicLink()).toBe(false)
  })

  it('saltea el archivo de más de 5 MB y sigue con los demás', async () => {
    const result = await extractZip(zipConArchivoPesado(), dest)
    expect(result.files).toContain('src/index.ts')
    expect(result.files).not.toContain('src/enorme.ts')
    expect(result.skipped.some((item) => item.code === 'archivo_pesado')).toBe(true)
  })

  it('deja afuera dependencias, compilados, git y binarios', async () => {
    const result = await extractZip(zipConBasura(), dest)
    expect(result.files).toEqual(['package.json', 'src/index.ts'])
    const codigos = result.skipped.map((item) => item.code)
    expect(codigos).toContain('dependencias')
    expect(codigos).toContain('compilado')
    expect(codigos).toContain('control_versiones')
    expect(codigos).toContain('binario')
  })

  it('cada descarte trae un motivo en castellano', async () => {
    const result = await extractZip(zipConBasura(), dest)
    for (const item of result.skipped) {
      expect(item.message.length).toBeGreaterThan(10)
      expect(item.message).not.toMatch(/undefined|null|Error:/)
    }
  })

  it('rechaza un archivo vacío', async () => {
    await expect(extractZip(new Uint8Array(0), dest)).rejects.toThrowError(ZipRejectedError)
  })

  it('rechaza un zip más grande que el máximo', async () => {
    const error = await capturarRechazo(extractZip(zipLimpio(), dest, { maxArchiveBytes: 10 }))
    expect(error.code).toBe('zip_demasiado_grande')
    expect(error.message).toMatch(/MB/)
  })
})

describe('el stack se detecta sobre lo extraído', () => {
  it('reconoce Next.js con App Router después de descomprimir', async () => {
    await extractZip(zipLimpio(), dest)
    const stack = await detectStack(dest)
    expect(stack.framework).toBe('nextjs')
    expect(stack.routerKind).toBe('app')
    expect(stack.evidence.length).toBeGreaterThan(0)
    expect(stack.evidence.join(' ')).toMatch(/package\.json/)
  })
})
