import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_RETENTION_DAYS,
  MAX_RETENTION_DAYS,
  deleteProjectCode,
  deleteRunCode,
  effectiveRetentionDays,
  isExpired,
  purgeExpired,
  retentionSummary,
} from '@/server/ingest/retention'
import { createWorkspace, pathExists, withWorkspace, workspacePathFor } from '@/server/ingest/workspace'

let storage: string
let previous: string | undefined

beforeEach(async () => {
  storage = await mkdtemp(path.join(tmpdir(), 'caughtcode-storage-'))
  previous = process.env.CAUGHTCODE_STORAGE_DIR
  process.env.CAUGHTCODE_STORAGE_DIR = storage
})

afterEach(async () => {
  if (previous === undefined) delete process.env.CAUGHTCODE_STORAGE_DIR
  else process.env.CAUGHTCODE_STORAGE_DIR = previous
  await rm(storage, { recursive: true, force: true })
})

describe('workspace', () => {
  it('crea la carpeta de la corrida y la borra al terminar', async () => {
    const usado = await withWorkspace('proyecto-1', 'corrida-1', async (workspace) => {
      await writeFile(path.join(workspace.codeDir, 'a.ts'), 'export const a = 1')
      expect(await pathExists(workspace.root)).toBe(true)
      return workspace.root
    })
    expect(await pathExists(usado)).toBe(false)
  })

  it('borra también cuando la corrida falla', async () => {
    const ruta = workspacePathFor('proyecto-2', 'corrida-2')
    await expect(
      withWorkspace('proyecto-2', 'corrida-2', async () => {
        throw new Error('se rompió el análisis')
      }),
    ).rejects.toThrow('se rompió el análisis')
    expect(await pathExists(ruta)).toBe(false)
  })

  it('no deja que una ruta armada con datos externos se escape', async () => {
    const workspace = await createWorkspace('proyecto-3', 'corrida-3')
    expect(() => workspace.resolve('../../fuera')).toThrow(/fuera de la carpeta/i)
    expect(workspace.resolve('code', 'a.ts')).toContain(workspace.root)
    await workspace.cleanup()
  })

  it('un id raro no puede armar una ruta fuera del almacenamiento', () => {
    const ruta = workspacePathFor('../../escapado', 'corrida')
    expect(ruta.startsWith(storage)).toBe(true)
  })
})

describe('política de retención', () => {
  it('usa 30 días por defecto y respeta el techo', () => {
    expect(effectiveRetentionDays(undefined)).toBe(DEFAULT_RETENTION_DAYS)
    expect(effectiveRetentionDays(null)).toBe(DEFAULT_RETENTION_DAYS)
    expect(effectiveRetentionDays(-5)).toBe(DEFAULT_RETENTION_DAYS)
    expect(effectiveRetentionDays(7)).toBe(7)
    expect(effectiveRetentionDays(9999)).toBe(MAX_RETENTION_DAYS)
  })

  it('calcula el vencimiento', () => {
    const hace40dias = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
    expect(isExpired({ projectId: 'p', retentionDays: 30, lastActivityAt: hace40dias })).toBe(true)
    expect(isExpired({ projectId: 'p', retentionDays: 60, lastActivityAt: hace40dias })).toBe(false)
  })

  it('el texto para el usuario no tiene jerga', () => {
    expect(retentionSummary(30)).toMatch(/se borra/i)
    expect(retentionSummary(30)).not.toMatch(/retention|purge|storage/i)
  })
})

describe('borrado verificable', () => {
  it('devuelve un comprobante que confirma que ya no está', async () => {
    const workspace = await createWorkspace('proyecto-4', 'corrida-4')
    await writeFile(path.join(workspace.codeDir, 'a.ts'), 'export const a = 1')

    const receipt = await deleteRunCode('proyecto-4', 'corrida-4')
    expect(receipt.existedBefore).toBe(true)
    expect(receipt.bytesFreed).toBeGreaterThan(0)
    expect(receipt.verified).toBe(true)
    expect(await pathExists(workspace.root)).toBe(false)
  })

  it('borrar algo que no existe no falla', async () => {
    const receipt = await deleteProjectCode('proyecto-que-no-existe')
    expect(receipt.existedBefore).toBe(false)
    expect(receipt.verified).toBe(true)
  })

  it('purga los proyectos vencidos y deja los vigentes', async () => {
    const viejo = await createWorkspace('viejo', 'c1')
    const nuevo = await createWorkspace('nuevo', 'c1')
    await writeFile(path.join(viejo.codeDir, 'a.ts'), 'a')
    await writeFile(path.join(nuevo.codeDir, 'b.ts'), 'b')

    const hace100dias = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000)
    const report = await purgeExpired([
      { projectId: 'viejo', retentionDays: 30, lastActivityAt: hace100dias },
      { projectId: 'nuevo', retentionDays: 30, lastActivityAt: new Date() },
    ])

    expect(report.deleted).toHaveLength(1)
    expect(report.failed).toHaveLength(0)
    expect(report.bytesFreed).toBeGreaterThan(0)
    expect(await pathExists(viejo.root)).toBe(false)
    expect(await pathExists(nuevo.root)).toBe(true)
  })

  it('con purgeOrphans borra lo que ya no pertenece a ningún proyecto', async () => {
    await mkdir(path.join(storage, 'proyecto-fantasma'), { recursive: true })
    await writeFile(path.join(storage, 'proyecto-fantasma', 'x.ts'), 'x')
    const vivo = await createWorkspace('vivo', 'c1')

    const report = await purgeExpired(
      [{ projectId: 'vivo', retentionDays: 30, lastActivityAt: new Date() }],
      { purgeOrphans: true },
    )

    expect(report.orphans).toHaveLength(1)
    expect(await pathExists(path.join(storage, 'proyecto-fantasma'))).toBe(false)
    expect(await pathExists(vivo.root)).toBe(true)
  })
})
