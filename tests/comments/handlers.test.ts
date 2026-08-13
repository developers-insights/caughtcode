/**
 * El handler de `scan_comments`: de comentarios sueltos a fila guardada.
 *
 * Lo que se prueba, en orden de importancia:
 *
 *  1. **Idempotencia.** Correrlo dos veces deja UNA fila en `comment_scans`,
 *     no dos — con y sin `analysis_run_id` (esta revisión no siempre está
 *     atada a una auditoría completa).
 *  2. **Persistencia correcta.** Lo que guarda la fila es lo que devolvió el
 *     motor, ni más ni menos.
 *  3. **Un repo inexistente falla alto y claro**, en castellano llano, sin
 *     reintentar a ciegas.
 *  4. **Costo en unidades concretas**, nunca "créditos".
 *  5. **Etapas legibles**, sin jerga.
 *  6. **Defensa por si el motor se cuelga o el repo es enorme**: tiempo
 *     máximo y tope de filas guardadas.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { T } from '@/lib/db/tablas'
import type { CommentHit, CommentScanResult } from '@/lib/types/domain'
import { detectarJerga } from '@/content/lenguaje'
import { scanProject } from '@/server/comments'
import {
  crearHandlerScanComments,
  MAX_HITS_GUARDADOS,
  TIEMPO_MAXIMO_ESCANEO_MS,
} from '@/server/comments/handlers'
import type { ScanCommentsPayload } from '@/server/comments/handlers'
import { DEFAULT_LEASE_SECONDS } from '@/server/jobs'

import { almacenEnMemoria, contextoDeTrabajo, DbFalsa } from '../fixtures/checks/db-falsa'

/* ── Andamiaje ────────────────────────────────────────────────────────── */

async function conRepo<T2>(fn: (repoPath: string) => Promise<T2>): Promise<T2> {
  const dir = await mkdtemp(path.join(tmpdir(), 'caughtcode-scan-comments-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function baseVacia(): DbFalsa {
  const db = new DbFalsa()
  db.sembrar(T.commentScans, [])
  return db
}

function escaneos(db: DbFalsa) {
  return db.filasDe(T.commentScans)
}

function hitDeEjemplo(parciales: Partial<CommentHit> = {}): CommentHit {
  return {
    file: 'app/page.tsx',
    line: 3,
    endLine: 3,
    text: 'nota interna, no tocar',
    syntax: 'line',
    reach: 'ships_to_browser',
    risk: 'none',
    functional: false,
    ...parciales,
  }
}

function resultadoDeEjemplo(parciales: Partial<CommentScanResult> = {}): CommentScanResult {
  return {
    scannedFiles: 5,
    hits: [hitDeEjemplo()],
    exposedCount: 1,
    riskyCount: 0,
    removableCount: 1,
    ...parciales,
  }
}

const PAYLOAD_BASE: ScanCommentsPayload = { repoPath: '' } // se completa con un repo real por test

/* ── 1. Idempotencia ──────────────────────────────────────────────────── */

describe('idempotencia: una revisión, una fila', () => {
  it('correr el mismo trabajo dos veces no duplica la fila (con corrida asociada)', async () => {
    await conRepo(async (repoPath) => {
      const db = baseVacia()
      const handler = crearHandlerScanComments({
        db: async () => db,
        store: almacenEnMemoria().store,
        escanear: async () => resultadoDeEjemplo(),
      })
      const payload: ScanCommentsPayload = { ...PAYLOAD_BASE, repoPath }

      await handler(payload, contextoDeTrabajo({ jobId: 'trabajo-1', analysisRunId: 'corrida-1' }))
      expect(escaneos(db)).toHaveLength(1)

      // Otro trabajo (otro jobId, otro almacén de etapas): vuelve a correr
      // todo desde cero, que es el caso que de verdad prueba la idempotencia.
      await handler(payload, contextoDeTrabajo({ jobId: 'trabajo-2', analysisRunId: 'corrida-1' }))

      expect(escaneos(db), 'se reemplazó la fila, no se acumuló').toHaveLength(1)
      expect(escaneos(db)[0]!.project_id).toBe('proyecto-1')
    })
  })

  it('también es idempotente sin corrida asociada (analysis_run_id nulo)', async () => {
    await conRepo(async (repoPath) => {
      const db = baseVacia()
      const handler = crearHandlerScanComments({
        db: async () => db,
        store: almacenEnMemoria().store,
        escanear: async () => resultadoDeEjemplo(),
      })
      const payload: ScanCommentsPayload = { ...PAYLOAD_BASE, repoPath }

      await handler(payload, contextoDeTrabajo({ jobId: 'trabajo-1', analysisRunId: null }))
      await handler(payload, contextoDeTrabajo({ jobId: 'trabajo-2', analysisRunId: null }))

      expect(escaneos(db)).toHaveLength(1)
      expect(escaneos(db)[0]!.analysis_run_id ?? null).toBeNull()
    })
  })

  it('un reintento del MISMO trabajo no vuelve a pagar el escaneo', async () => {
    await conRepo(async (repoPath) => {
      const db = baseVacia()
      const { store } = almacenEnMemoria()
      let llamadas = 0
      const handler = crearHandlerScanComments({
        db: async () => db,
        store,
        escanear: async () => {
          llamadas += 1
          return resultadoDeEjemplo()
        },
      })
      const payload: ScanCommentsPayload = { ...PAYLOAD_BASE, repoPath }
      const ctx = contextoDeTrabajo({ jobId: 'trabajo-1' })

      await handler(payload, ctx)
      expect(llamadas).toBe(1)

      // Mismo jobId, mismo almacén de etapas: la etapa ya hecha se saltea.
      await handler(payload, ctx)
      expect(llamadas, 'un reintento volvió a escanear el proyecto').toBe(1)
      expect(escaneos(db)).toHaveLength(1)
    })
  })

  it('dos proyectos distintos no se pisan', async () => {
    await conRepo(async (repoPath) => {
      const db = baseVacia()
      const handler = crearHandlerScanComments({
        db: async () => db,
        store: almacenEnMemoria().store,
        escanear: async () => resultadoDeEjemplo(),
      })

      await handler(
        { ...PAYLOAD_BASE, repoPath },
        contextoDeTrabajo({ jobId: 'a', projectId: 'proyecto-a', analysisRunId: 'corrida-a' }),
      )
      await handler(
        { ...PAYLOAD_BASE, repoPath },
        contextoDeTrabajo({ jobId: 'b', projectId: 'proyecto-b', analysisRunId: 'corrida-b' }),
      )

      expect(escaneos(db)).toHaveLength(2)
    })
  })
})

/* ── 2. Persistencia correcta ─────────────────────────────────────────── */

describe('lo que se guarda es lo que encontró el motor', () => {
  it('los números y el detalle coinciden con el resultado del escaneo', async () => {
    await conRepo(async (repoPath) => {
      const db = baseVacia()
      const resultado = resultadoDeEjemplo({
        scannedFiles: 12,
        exposedCount: 3,
        riskyCount: 2,
        removableCount: 4,
        hits: [hitDeEjemplo({ file: 'a.ts' }), hitDeEjemplo({ file: 'b.ts', risk: 'secret' })],
      })
      const handler = crearHandlerScanComments({
        db: async () => db,
        store: almacenEnMemoria().store,
        escanear: async () => resultado,
      })

      await handler({ ...PAYLOAD_BASE, repoPath }, contextoDeTrabajo())

      const fila = escaneos(db)[0]!
      expect(fila.project_id).toBe('proyecto-1')
      expect(fila.analysis_run_id).toBe('corrida-1')
      expect(fila.scanned_files).toBe(12)
      expect(fila.exposed_count).toBe(3)
      expect(fila.risky_count).toBe(2)
      expect(fila.removable_count).toBe(4)
      expect(fila.hits).toEqual(resultado.hits)
    })
  })

  it('conectado al motor real, guarda lo que este mismo proyecto de prueba tiene', async () => {
    await conRepo(async (repoPath) => {
      await mkdir(path.join(repoPath, 'app'), { recursive: true })
      await writeFile(
        path.join(repoPath, 'app', 'page.tsx'),
        ["'use client'", '', '// nota que no debería estar acá', 'export default function P() { return null }', ''].join(
          '\n',
        ),
        'utf8',
      )

      const db = baseVacia()
      // Sin `escanear` inyectado: usa el motor real (`scanProject`) importado
      // por el propio handler. Es la prueba de que la conexión funciona.
      const handler = crearHandlerScanComments({ db: async () => db, store: almacenEnMemoria().store })

      await handler({ repoPath }, contextoDeTrabajo())

      const fila = escaneos(db)[0]!
      expect(Number(fila.scanned_files)).toBeGreaterThan(0)
      expect(Array.isArray(fila.hits) && (fila.hits as unknown[]).length).toBeGreaterThan(0)
    })
  })
})

/* ── 3. Un repo inexistente falla alto y claro ────────────────────────── */

describe('un repo inexistente', () => {
  it('falla en vez de decir "cero comentarios", con mensaje llano y sin reintentar a ciegas', async () => {
    const repoPath = path.join(tmpdir(), `caughtcode-nunca-existio-${Date.now()}`)
    const db = baseVacia()
    const handler = crearHandlerScanComments({ db: async () => db, store: almacenEnMemoria().store })

    await expect(handler({ repoPath }, contextoDeTrabajo())).rejects.toMatchObject({ retryable: false })

    // No quedó ninguna fila mintiendo que revisamos algo.
    expect(escaneos(db)).toHaveLength(0)
  })

  it('el mensaje de ese error no tiene jerga técnica', async () => {
    const repoPath = path.join(tmpdir(), `caughtcode-nunca-existio-${Date.now()}-2`)
    const db = baseVacia()
    const handler = crearHandlerScanComments({ db: async () => db, store: almacenEnMemoria().store })

    try {
      await handler({ repoPath }, contextoDeTrabajo())
      expect.unreachable('tenía que fallar')
    } catch (error) {
      const mensaje = error instanceof Error ? error.message : String(error)
      expect(detectarJerga(mensaje), `jerga en: ${mensaje}`).toEqual([])
    }
  })
})

/* ── 4. Costo en unidades concretas ───────────────────────────────────── */

describe('costo', () => {
  it('reporta archivos revisados y comentarios encontrados, nunca créditos', async () => {
    await conRepo(async (repoPath) => {
      const db = baseVacia()
      const ctx = contextoDeTrabajo()
      const handler = crearHandlerScanComments({
        db: async () => db,
        store: almacenEnMemoria().store,
        escanear: async () => resultadoDeEjemplo({ scannedFiles: 8, hits: [hitDeEjemplo(), hitDeEjemplo()] }),
      })

      await handler({ ...PAYLOAD_BASE, repoPath }, ctx)

      const etiquetas = ctx.costos.map((c) => c.unitLabel)
      expect(etiquetas).toContain('archivos revisados')
      expect(etiquetas).toContain('comentarios encontrados')
      for (const c of ctx.costos) {
        expect(c.unitLabel).not.toMatch(/cr[ée]dito/i)
        expect(detectarJerga(c.detail ?? ''), `jerga en: ${c.detail}`).toEqual([])
      }

      const archivos = ctx.costos.find((c) => c.unitLabel === 'archivos revisados')!
      expect(archivos.units).toBe(8)
      const comentarios = ctx.costos.find((c) => c.unitLabel === 'comentarios encontrados')!
      expect(comentarios.units).toBe(2)
    })
  })
})

/* ── 5. Etapas legibles ───────────────────────────────────────────────── */

describe('etapas', () => {
  it('los textos de etapa y los mensajes de registro no tienen jerga', async () => {
    await conRepo(async (repoPath) => {
      const db = baseVacia()
      const ctx = contextoDeTrabajo()
      const handler = crearHandlerScanComments({
        db: async () => db,
        store: almacenEnMemoria().store,
        escanear: async () => resultadoDeEjemplo(),
      })

      await handler({ ...PAYLOAD_BASE, repoPath }, ctx)

      const etiquetas = ctx.etapas.map((e) => e.stage).filter((s): s is string => Boolean(s))
      expect(etiquetas.length).toBeGreaterThan(0)
      for (const etiqueta of etiquetas) {
        expect(detectarJerga(etiqueta), `la etapa "${etiqueta}" tiene jerga`).toEqual([])
      }
      for (const linea of ctx.registro) {
        expect(detectarJerga(linea), `el registro "${linea}" tiene jerga`).toEqual([])
      }

      const progresos = ctx.etapas.map((e) => e.progress).filter((p): p is number => typeof p === 'number')
      expect(Math.max(...progresos)).toBe(100)
    })
  })
})

/* ── 6. Defensa: el proyecto es enorme o el motor no responde ────────── */

describe('defensa en profundidad', () => {
  it('si el resultado trae más comentarios de la cuenta, guarda solo el tope y lo avisa', async () => {
    await conRepo(async (repoPath) => {
      const db = baseVacia()
      const ctx = contextoDeTrabajo()
      const muchos: CommentHit[] = Array.from({ length: MAX_HITS_GUARDADOS + 37 }, (_, i) =>
        hitDeEjemplo({ file: `archivo-${i}.ts`, line: i + 1, endLine: i + 1 }),
      )
      const handler = crearHandlerScanComments({
        db: async () => db,
        store: almacenEnMemoria().store,
        escanear: async () => resultadoDeEjemplo({ scannedFiles: 9999, hits: muchos }),
      })

      await handler({ ...PAYLOAD_BASE, repoPath }, ctx)

      const fila = escaneos(db)[0]!
      expect((fila.hits as unknown[]).length).toBe(MAX_HITS_GUARDADOS)
      // El resumen (lo que no es la lista detallada) sigue contando el total real.
      expect(fila.scanned_files).toBe(9999)
      expect(ctx.registro.some((l) => l.includes(MAX_HITS_GUARDADOS.toLocaleString('es-AR')))).toBe(true)
    })
  })

  /**
   * El tope de tiempo del escaneo tiene que quedar por debajo del arriendo del
   * trabajo. Si se pasa, el permiso vence antes de que el corte llegue: otro
   * worker toma el mismo trabajo y los dos escriben en `comment_scans`.
   *
   * Estuvo mal durante un tiempo y en silencio: el arriendo bajó de 300 s a 90 y
   * este número —120 s— se quedó donde estaba, por encima. Este test es el que
   * avisa si vuelve a pasar.
   */
  it('el tope del escaneo queda por debajo del arriendo del trabajo', () => {
    const arriendoMs = DEFAULT_LEASE_SECONDS * 1000
    expect(TIEMPO_MAXIMO_ESCANEO_MS).toBeLessThan(arriendoMs)
    // Con margen de verdad: el corte tiene que llegar bastante antes, no justo.
    expect(TIEMPO_MAXIMO_ESCANEO_MS).toBeLessThanOrEqual(arriendoMs * 0.75)
  })

  /**
   * El escaneo es trabajo de CPU y `scanFile` es sincrónico: encadenado con
   * microtareas, analizar N archivos era un solo bloque que no soltaba el hilo.
   * Los temporizadores viven en otra fase del event loop, así que mientras
   * duraba no podía dispararse ni el latido que renueva el arriendo ni el tope
   * de tiempo de acá arriba. Los dos controles existían y ninguno servía.
   *
   * Que el turno se ceda **una vez por archivo** es lo que los pone a funcionar.
   */
  it('el escaneo suelta el hilo entre archivo y archivo', async () => {
    await conRepo(async (repoPath) => {
      for (let i = 0; i < 5; i += 1) {
        await writeFile(path.join(repoPath, `archivo-${i}.ts`), '// una nota\nexport const a = 1\n')
      }

      let turnosCedidos = 0
      const resultado = await scanProject(repoPath, {
        ceder: async () => {
          turnosCedidos += 1
        },
      })

      expect(resultado.scannedFiles).toBe(5)
      expect(turnosCedidos, 'el escaneo no le devolvió el turno al event loop').toBe(5)
    })
  })

  it('si el motor no responde, se corta con un error que no invita a reintentar el mismo trabajo', async () => {
    await conRepo(async (repoPath) => {
      const db = baseVacia()
      const handler = crearHandlerScanComments({
        db: async () => db,
        store: almacenEnMemoria().store,
        escanear: () => new Promise<CommentScanResult>(() => {}), // nunca resuelve
        tiempoMaximoMs: 25,
      })

      await expect(
        handler({ ...PAYLOAD_BASE, repoPath }, contextoDeTrabajo()),
      ).rejects.toMatchObject({ retryable: false })

      expect(escaneos(db)).toHaveLength(0)
    })
  })
})
