/**
 * `build_tutorials` es una capacidad **declarada y todavía no construida**.
 *
 * Existe como `JobKind` desde el día uno (está en `domain.ts`, en el `check` de
 * la migración `0003` y en el catálogo de la cola), pero su motor no está
 * escrito: son los videos de "cómo funciona mi proyecto", distintos de los
 * videos de hallazgo. No hay especificación, así que inventarla sería fabricar
 * producto.
 *
 * Lo que sí tiene que estar garantizado es que el agujero se comporte con
 * honestidad. Estos tests encierran tres cosas:
 *
 *   1. hoy **nadie lo encola** (por eso el agujero no se nota);
 *   2. si alguien lo encolara, **falla rápido y la corrida cierra igual** — no
 *      hay forma de que deje la pantalla girando;
 *   3. el motivo que le queda al usuario **se entiende sin ser programador**.
 *
 * Cuando alguien construya la función, el punto 1 va a fallar y este archivo es
 * el lugar donde se lee qué había que hacer antes de encolarla.
 */

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { F, T } from '@/lib/db/tablas'
import { setJobsDb } from '@/server/jobs/db'
import { HandlerNotRegisteredError, isRetryable } from '@/server/jobs/errors'
import { ESPERA_MAXIMA_EN_COLA_MS, vencerEncoladosDesatendidos } from '@/server/jobs/encolados'
import { toJobRecord } from '@/server/jobs/queue'
import {
  CAPACIDADES_SIN_MOTOR,
  JOB_KINDS,
  JOB_KIND_LABEL,
  getHandler,
  hasRealHandler,
  registerHandler,
  resetHandlers,
} from '@/server/jobs/registry'
import { runClaimedJob } from '@/server/jobs/runner'
import { FakeDb, jobRow } from './fake-db'

const RAIZ_SRC = fileURLToPath(new URL('../../src', import.meta.url))

let db: FakeDb

beforeEach(() => {
  db = new FakeDb()
  setJobsDb(db)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  setJobsDb(null)
  resetHandlers()
  vi.restoreAllMocks()
})

async function archivosDeCodigo(dir: string): Promise<string[]> {
  const encontrados: string[] = []
  for (const entrada of await readdir(dir, { withFileTypes: true })) {
    const completo = path.join(dir, entrada.name)
    if (entrada.isDirectory()) encontrados.push(...(await archivosDeCodigo(completo)))
    else if (/\.tsx?$/.test(entrada.name)) encontrados.push(completo)
  }
  return encontrados
}

describe('la capacidad está declarada, no construida', () => {
  it('sigue siendo un tipo de trabajo válido, con etiqueta sin jerga', () => {
    expect(JOB_KINDS).toContain('build_tutorials')
    expect(JOB_KIND_LABEL.build_tutorials).toBeTruthy()
    expect(CAPACIDADES_SIN_MOTOR).toContain('build_tutorials')
  })

  it('todo lo que figura sin motor es un tipo real y no tiene handler', () => {
    for (const kind of CAPACIDADES_SIN_MOTOR) {
      expect(JOB_KINDS).toContain(kind)
      expect(hasRealHandler(kind)).toBe(false)
    }
  })

  it('nadie lo encola: no hay una sola llamada en todo el código', async () => {
    const archivos = await archivosDeCodigo(RAIZ_SRC)
    const encolan: string[] = []

    for (const archivo of archivos) {
      const contenido = await readFile(archivo, 'utf8')
      // La forma con la que se encola cualquier trabajo: `kind: '<tipo>'`.
      if (/\bkind\s*:\s*['"]build_tutorials['"]/.test(contenido)) {
        encolan.push(path.relative(RAIZ_SRC, archivo))
      }
    }

    // Si esto falla, alguien conectó la función: antes de encolarla hay que
    // registrarle un handler y sacarla de `CAPACIDADES_SIN_MOTOR`.
    expect(encolan).toEqual([])
    expect(archivos.length).toBeGreaterThan(50)
  })
})

describe('si alguien lo encolara igual', () => {
  function corridaConTutoriales() {
    db.seed(T.analysisRuns, [
      { id: 'run-1', project_id: 'proj-1', status: 'running', stage: null, progress: 0 },
    ])
    const fila = jobRow({
      id: 'job-tuto',
      kind: 'build_tutorials',
      status: 'running',
      attempts: 1,
      max_attempts: 3,
    })
    db.seed(T.jobs, [
      jobRow({ id: 'job-checks', kind: 'run_checks', status: 'succeeded' }),
      fila,
    ])
    db.rpcHandlers[F.claimJob] = () => ({ data: fila })
    return toJobRecord(fila)
  }

  it('falla en el primer intento y no gasta reintentos', async () => {
    const job = corridaConTutoriales()

    const outcome = await runClaimedJob(job, { log: () => {} })

    expect(outcome.outcome).toBe('failed')
    expect(outcome.attempts).toBe(1)
    expect(db.row(T.jobs, 'job-tuto')!.status).toBe('failed')
  })

  it('la corrida cierra y no queda teñida: no es un trabajo de revisión', async () => {
    const job = corridaConTutoriales()

    await runClaimedJob(job, { log: () => {} })

    const corrida = db.row(T.analysisRuns, 'run-1')!
    expect(corrida.status).toBe('succeeded')
    expect(corrida.error).toBeNull()
    expect(corrida.finished_at).toBeTruthy()
  })

  it('el motivo que le queda al usuario se entiende sin ser programador', async () => {
    const job = corridaConTutoriales()

    const outcome = await runClaimedJob(job, { log: () => {} })
    const motivo = String(outcome.error)

    expect(motivo).toContain(JOB_KIND_LABEL.build_tutorials)
    // Ni jerga de la cola, ni el nombre interno del tipo de trabajo.
    expect(motivo).not.toMatch(/handler|stub|registrad|módulo|build_tutorials/i)
    expect(db.row(T.jobs, 'job-tuto')!.last_error).toBe(motivo)
  })

  it('el error dice que la capacidad no está construida, no que algo se rompió', async () => {
    const error = await getHandler('build_tutorials')({}, {} as any).catch((e) => e)

    expect(error).toBeInstanceOf(HandlerNotRegisteredError)
    expect(error.kind).toBe('build_tutorials')
    expect(error.code).toBe('capacidad_no_construida')
    // No se reintenta: reintentar algo que no existe es quemar intentos.
    expect(isRetryable(error)).toBe(false)
  })

  it('si nadie lo toma, la cola lo da por perdido y la corrida cierra igual', async () => {
    const ahora = new Date('2026-08-12T12:00:00.000Z')
    const haceRato = new Date(ahora.getTime() - ESPERA_MAXIMA_EN_COLA_MS - 60_000).toISOString()

    db.seed(T.analysisRuns, [{ id: 'run-1', project_id: 'proj-1', status: 'running' }])
    db.seed(T.jobs, [
      jobRow({ id: 'job-checks', kind: 'run_checks', status: 'succeeded', updated_at: haceRato }),
      jobRow({ id: 'job-tuto', kind: 'build_tutorials', status: 'queued', run_after: haceRato }),
    ])

    const resultado = await vencerEncoladosDesatendidos({ now: ahora })

    expect(resultado.vencidos).toBe(1)
    expect(db.row(T.jobs, 'job-tuto')!.status).toBe('failed')
    expect(db.row(T.analysisRuns, 'run-1')!.status).toBe('succeeded')
  })
})

describe('el día que se construya', () => {
  it('registrar el handler real reemplaza el stub sin tocar nada más', async () => {
    const handler = vi.fn(async () => {})
    registerHandler('build_tutorials', handler)

    await getHandler('build_tutorials')({ moduleId: 'm1' }, {} as any)

    expect(hasRealHandler('build_tutorials')).toBe(true)
    expect(handler).toHaveBeenCalledTimes(1)
  })
})
