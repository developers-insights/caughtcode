/**
 * El disco del worker crece sin tope si nadie barre.
 *
 * `reconcileRunStatus()` ya borra la carpeta de la corrida cuando la corrida
 * cierra (ver `reconcile.test.ts`), pero eso solo alcanza si el borrado pasa en
 * la misma máquina que bajó el código. Y no siempre pasa: el worker largo
 * (Railway, disco `/data`) puede bajar el repo y ser el tick de Vercel —otro
 * proceso, otro disco— el que cierre la corrida. Ahí el `rm` corre sobre el
 * disco equivocado y la carpeta del worker queda para siempre.
 *
 * Estos tests encierran el barrido que tapa ese agujero: cada proceso limpia SU
 * disco, y solo borra lo que ya nadie puede necesitar.
 */

import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { F, T } from '@/lib/db/tablas'
import { setJobsDb } from '@/server/jobs/db'
import { toJobRecord } from '@/server/jobs/queue'
import { registerHandler, resetHandlers } from '@/server/jobs/registry'
import { runClaimedJob } from '@/server/jobs/runner'
import {
  barrerCodigoHuerfano,
  barrerCodigoHuerfanoSiToca,
  reiniciarRelojDeLimpieza,
} from '@/server/jobs/limpieza'
import { pathExists, workspacePathFor } from '@/server/ingest/workspace'
import { FakeDb, jobRow } from './fake-db'

let db: FakeDb
let raiz: string

/** Hace que una carpeta parezca vieja sin tener que esperar seis horas. */
async function envejecer(target: string, horas = 48): Promise<void> {
  const cuando = new Date(Date.now() - horas * 60 * 60_000)
  await utimes(target, cuando, cuando)
}

/** Deja código en disco como lo dejaría una corrida real. */
async function sembrarCodigoEnDisco(projectId: string, runId: string): Promise<string> {
  const carpeta = workspacePathFor(projectId, runId)
  await mkdir(path.join(carpeta, 'code'), { recursive: true })
  await writeFile(path.join(carpeta, 'code', 'index.ts'), 'export const hola = 1\n')
  return carpeta
}

beforeEach(async () => {
  db = new FakeDb()
  setJobsDb(db)
  raiz = await mkdtemp(path.join(tmpdir(), 'caughtcode-limpieza-'))
  process.env.CAUGHTCODE_STORAGE_DIR = raiz
  reiniciarRelojDeLimpieza()
})

afterEach(async () => {
  setJobsDb(null)
  delete process.env.CAUGHTCODE_STORAGE_DIR
  reiniciarRelojDeLimpieza()
  await rm(raiz, { recursive: true, force: true })
})

describe('barrerCodigoHuerfano', () => {
  it('borra el código de una corrida que ya terminó y nadie está usando', async () => {
    const carpeta = await sembrarCodigoEnDisco('proj-1', 'run-1')
    await envejecer(carpeta)
    db.seed(T.analysisRuns, [{ id: 'run-1', status: 'succeeded' }])
    db.seed(T.jobs, [jobRow({ id: 'job-1', analysis_run_id: 'run-1', status: 'succeeded' })])

    const informe = await barrerCodigoHuerfano()

    expect(await pathExists(carpeta)).toBe(false)
    expect(informe.borradas).toHaveLength(1)
    expect(informe.borradas[0].verified).toBe(true)
    expect(informe.bytesLiberados).toBeGreaterThan(0)
  })

  it('no toca el código de una corrida en marcha', async () => {
    const carpeta = await sembrarCodigoEnDisco('proj-1', 'run-1')
    await envejecer(carpeta)
    db.seed(T.analysisRuns, [{ id: 'run-1', status: 'running' }])

    const informe = await barrerCodigoHuerfano()

    expect(await pathExists(carpeta)).toBe(true)
    expect(informe.borradas).toHaveLength(0)
    expect(informe.protegidas).toBe(1)
  })

  it('no toca el código que un trabajo en vuelo todavía va a leer', async () => {
    // La corrida ya cerró (`scan_comments` no la compone), pero el trabajo sigue
    // encolado y lee `payload.repoPath`. Borrarle el código abajo sería romperlo.
    const carpeta = await sembrarCodigoEnDisco('proj-1', 'run-1')
    await envejecer(carpeta)
    db.seed(T.analysisRuns, [{ id: 'run-1', status: 'succeeded' }])
    db.seed(T.jobs, [
      jobRow({ id: 'job-1', analysis_run_id: 'run-1', kind: 'scan_comments', status: 'queued' }),
    ])

    const informe = await barrerCodigoHuerfano()

    expect(await pathExists(carpeta)).toBe(true)
    expect(informe.protegidas).toBe(1)
  })

  it('no toca lo que se escribió recién, aunque la corrida figure cerrada', async () => {
    // Piso de seguridad independiente de la base: entre que un handler escribe y
    // la fila se actualiza pasan segundos, y en esos segundos el código está vivo.
    const carpeta = await sembrarCodigoEnDisco('proj-1', 'run-1')
    db.seed(T.analysisRuns, [{ id: 'run-1', status: 'succeeded' }])

    const informe = await barrerCodigoHuerfano()

    expect(await pathExists(carpeta)).toBe(true)
    expect(informe.protegidas).toBe(1)
    expect(informe.borradas).toHaveLength(0)
  })

  it('si la base no contesta no borra nada: sin evidencia no se toca el disco', async () => {
    const carpeta = await sembrarCodigoEnDisco('proj-1', 'run-1')
    await envejecer(carpeta)
    db.errors[`${T.analysisRuns}.select`] = { message: 'se cayó la base' }

    const informe = await barrerCodigoHuerfano()

    expect(await pathExists(carpeta)).toBe(true)
    expect(informe.borradas).toHaveLength(0)
    expect(informe.motivo).toBe('sin_evidencia')
  })

  it('la basura que no corresponde a ninguna corrida también se va', async () => {
    // `createWorkspace(nanoid(), 'onboarding')`: carpetas que no tienen fila en
    // la base y que nadie borra si el request se cortó a la mitad.
    const carpeta = path.join(raiz, 'V1StGXR8Z5jdHi6BmyT', 'onboarding')
    await mkdir(path.join(carpeta, 'code'), { recursive: true })
    await writeFile(path.join(carpeta, 'code', 'a.ts'), 'x')
    await envejecer(carpeta)

    await barrerCodigoHuerfano()

    expect(await pathExists(carpeta)).toBe(false)
  })

  it('deja la raíz sin carpetas de proyecto vacías', async () => {
    const carpeta = await sembrarCodigoEnDisco('proj-1', 'run-1')
    await envejecer(carpeta)
    db.seed(T.analysisRuns, [{ id: 'run-1', status: 'succeeded' }])

    await barrerCodigoHuerfano()

    expect(await readdir(raiz)).toEqual([])
  })

  it('no explota si la raíz de almacenamiento todavía no existe', async () => {
    process.env.CAUGHTCODE_STORAGE_DIR = path.join(raiz, 'no-existe')

    const informe = await barrerCodigoHuerfano()

    expect(informe.motivo).toBe('sin_raiz')
    expect(informe.borradas).toHaveLength(0)
  })

  it('barrer dos veces no rompe: es idempotente', async () => {
    const carpeta = await sembrarCodigoEnDisco('proj-1', 'run-1')
    await envejecer(carpeta)
    db.seed(T.analysisRuns, [{ id: 'run-1', status: 'succeeded' }])

    await barrerCodigoHuerfano()
    const segunda = await barrerCodigoHuerfano()

    expect(segunda.borradas).toHaveLength(0)
    expect(await pathExists(carpeta)).toBe(false)
  })
})

describe('barrerCodigoHuerfanoSiToca', () => {
  it('sin disco propio configurado no mira el disco siquiera', async () => {
    delete process.env.CAUGHTCODE_STORAGE_DIR

    expect(await barrerCodigoHuerfanoSiToca()).toBeNull()
  })

  it('no barre dos veces seguidas: es una tarea de fondo, no del trabajo', async () => {
    const primera = await barrerCodigoHuerfanoSiToca()
    const segunda = await barrerCodigoHuerfanoSiToca()

    expect(primera).not.toBeNull()
    expect(segunda).toBeNull()
  })
})

describe('está enganchado al worker, no solo escrito', () => {
  it('el proceso que ejecuta un trabajo barre su propio disco', async () => {
    // Este es el caso que el borrado por corrida no puede cubrir: la carpeta es
    // de OTRA corrida, que cerró en otra máquina y por eso nadie borró acá.
    const abandonada = await sembrarCodigoEnDisco('proj-viejo', 'run-viejo')
    await envejecer(abandonada)
    db.seed(T.analysisRuns, [
      { id: 'run-viejo', status: 'succeeded' },
      { id: 'run-1', status: 'running', stage: null, progress: 0 },
    ])

    const fila = jobRow({ id: 'job-1', status: 'running', attempts: 1 })
    db.seed(T.jobs, [fila])
    db.rpcHandlers[F.claimJob] = () => ({ data: fila })
    registerHandler('run_checks', async () => {})

    await runClaimedJob(toJobRecord(fila), { log: () => {} })

    expect(await pathExists(abandonada)).toBe(false)
    resetHandlers()
  })
})
