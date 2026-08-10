import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { setJobsDb } from '@/server/jobs/db'
import {
  cancel,
  claim,
  enqueue,
  fail,
  heartbeat,
  releaseLease,
  requeueExpired,
  succeed,
  toJobRecord,
} from '@/server/jobs/queue'
import { JobError } from '@/server/jobs/errors'
import { FakeDb, filaFantasma, jobRow } from './fake-db'
import { F, T } from '@/lib/db/tablas'

let db: FakeDb

beforeEach(() => {
  db = new FakeDb()
  setJobsDb(db)
})

afterEach(() => {
  setJobsDb(null)
})

describe('enqueue', () => {
  it('encola con los valores por defecto y devuelve el id', async () => {
    const id = await enqueue({
      orgId: 'org-1',
      projectId: 'proj-1',
      analysisRunId: 'run-1',
      kind: 'index_code',
      payload: { repoPath: '/tmp/x' },
    })

    expect(id).toMatch(/^fake-/)
    const fila = db.row(T.jobs, id)!
    expect(fila.status).toBe('queued')
    expect(fila.attempts).toBe(0)
    expect(fila.max_attempts).toBe(3)
    expect(fila.progress).toBe(0)
    expect(fila.payload).toEqual({ repoPath: '/tmp/x' })
    expect(typeof fila.run_after).toBe('string')
  })

  it('respeta runAfter y maxAttempts', async () => {
    const cuando = new Date('2026-09-01T10:00:00.000Z')
    const id = await enqueue({
      orgId: 'org-1',
      kind: 'generate_video',
      payload: {},
      runAfter: cuando,
      maxAttempts: 5,
    })

    const fila = db.row(T.jobs, id)!
    expect(fila.run_after).toBe('2026-09-01T10:00:00.000Z')
    expect(fila.max_attempts).toBe(5)
  })

  it('no deja encolar sin organización', async () => {
    await expect(enqueue({ orgId: '', kind: 'index_code', payload: {} })).rejects.toThrow(
      /sin organización/i,
    )
  })
})

describe('claim', () => {
  it('llama al RPC con los tipos y el lease, y mapea la fila', async () => {
    db.rpcHandlers[F.claimJob] = () => ({
      data: jobRow({ id: 'job-9', status: 'running', attempts: 1, stage: 'Revisando' }),
    })

    const job = await claim(['run_checks', 'index_code'], 180)

    expect(db.rpcCalls[0]).toEqual({
      fn: F.claimJob,
      args: { p_kinds: ['run_checks', 'index_code'], p_lease_seconds: 180 },
    })
    expect(job).not.toBeNull()
    expect(job!.id).toBe('job-9')
    expect(job!.analysisRunId).toBe('run-1')
    expect(job!.maxAttempts).toBe(3)
    expect(job!.attempts).toBe(1)
    expect(job!.stage).toBe('Revisando')
  })

  it('acepta que el RPC devuelva un arreglo', async () => {
    db.rpcHandlers[F.claimJob] = () => ({ data: [jobRow({ id: 'job-7' })] })
    const job = await claim(['run_checks'])
    expect(job!.id).toBe('job-7')
  })

  it('devuelve null cuando no hay nada para hacer', async () => {
    db.rpcHandlers[F.claimJob] = () => ({ data: null })
    expect(await claim(['run_checks'])).toBeNull()
  })

  it('devuelve null ante un arreglo vacío', async () => {
    db.rpcHandlers[F.claimJob] = () => ({ data: [] })
    expect(await claim(['run_checks'])).toBeNull()
  })

  // Esto pasó en producción: un RPC declarado `returns jobs_caughtcode` (tipo
  // compuesto, no `setof`) que hace `return null` materializa UNA fila con todas
  // las columnas en null. El worker la tomaba como trabajo real y ciclaba.
  it('descarta la fila fantasma con todas las columnas en null', async () => {
    db.rpcHandlers[F.claimJob] = () => ({ data: filaFantasma() })
    expect(await claim(['run_checks'])).toBeNull()
  })

  it('descarta la fila fantasma aunque venga adentro de un arreglo', async () => {
    db.rpcHandlers[F.claimJob] = () => ({ data: [filaFantasma()] })
    expect(await claim(['run_checks'])).toBeNull()
  })

  it('descarta una fila con id vacío o en blanco', async () => {
    db.rpcHandlers[F.claimJob] = () => ({ data: jobRow({ id: '' }) })
    expect(await claim(['run_checks'])).toBeNull()

    db.rpcHandlers[F.claimJob] = () => ({ data: jobRow({ id: '   ' }) })
    expect(await claim(['run_checks'])).toBeNull()
  })

  it('devuelve un JobRecord completo ante una fila real', async () => {
    db.rpcHandlers[F.claimJob] = () => ({
      data: jobRow({
        id: '6f1c9f0e-1111-4222-8333-444455556666',
        status: 'running',
        attempts: 2,
        max_attempts: 5,
        progress: 30,
        lease_until: '2026-08-09T12:05:00.000Z',
      }),
    })

    const job = await claim(['run_checks'])

    expect(job).toEqual({
      id: '6f1c9f0e-1111-4222-8333-444455556666',
      orgId: 'org-1',
      projectId: 'proj-1',
      analysisRunId: 'run-1',
      kind: 'run_checks',
      status: 'running',
      payload: {},
      attempts: 2,
      maxAttempts: 5,
      lastError: null,
      stage: null,
      progress: 30,
      leaseUntil: '2026-08-09T12:05:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
  })

  it('sin tipos no molesta a la base', async () => {
    expect(await claim([])).toBeNull()
    expect(db.rpcCalls).toHaveLength(0)
  })
})

describe('transiciones de estado', () => {
  beforeEach(() => {
    db.seed(T.jobs, [jobRow({ id: 'job-1', status: 'running', attempts: 1 })])
  })

  it('succeed deja el trabajo terminado y al 100%', async () => {
    await succeed('job-1')
    const fila = db.row(T.jobs, 'job-1')!
    expect(fila.status).toBe('succeeded')
    expect(fila.progress).toBe(100)
    expect(fila.lease_until).toBeNull()
    expect(fila.last_error).toBeNull()
  })

  it('heartbeat extiende el lease y publica etapa y progreso', async () => {
    const antes = Date.now()
    await heartbeat('job-1', { stage: 'Revisando quién puede ver qué', progress: 42, leaseSeconds: 120 })

    const fila = db.row(T.jobs, 'job-1')!
    expect(fila.stage).toBe('Revisando quién puede ver qué')
    expect(fila.progress).toBe(42)
    expect(new Date(fila.lease_until).getTime()).toBeGreaterThan(antes + 100_000)
  })

  it('heartbeat recorta el progreso a 0–100', async () => {
    await heartbeat('job-1', { progress: 1000 })
    expect(db.row(T.jobs, 'job-1')!.progress).toBe(100)
    await heartbeat('job-1', { progress: -5 })
    expect(db.row(T.jobs, 'job-1')!.progress).toBe(0)
  })

  it('fail con intentos disponibles vuelve a la cola con backoff', async () => {
    const ahora = new Date('2026-08-09T12:00:00.000Z')
    const resultado = await fail('job-1', new Error('se cayó la red'), {
      attempts: 1,
      maxAttempts: 3,
      backoff: { jitterRatio: 0 },
      now: ahora,
    })

    expect(resultado.status).toBe('queued')
    expect(resultado.runAfter).toBe('2026-08-09T12:01:00.000Z')

    const fila = db.row(T.jobs, 'job-1')!
    expect(fila.status).toBe('queued')
    expect(fila.lease_until).toBeNull()
    expect(fila.last_error).toContain('se cayó la red')
    expect(fila.run_after).toBe('2026-08-09T12:01:00.000Z')
  })

  it('fail en el último intento marca failed y no reprograma', async () => {
    const resultado = await fail('job-1', new Error('otra vez'), { attempts: 3, maxAttempts: 3 })

    expect(resultado.status).toBe('failed')
    expect(resultado.runAfter).toBeNull()
    expect(db.row(T.jobs, 'job-1')!.status).toBe('failed')
  })

  it('fail con retry:false no gasta los intentos que quedaban', async () => {
    const resultado = await fail('job-1', new JobError('falta el handler', { retryable: false }), {
      retry: false,
      attempts: 1,
      maxAttempts: 3,
    })

    expect(resultado.status).toBe('failed')
    expect(db.row(T.jobs, 'job-1')!.status).toBe('failed')
  })

  it('fail lee intentos de la base si no se los pasan', async () => {
    db.seed(T.jobs, [jobRow({ id: 'job-2', status: 'running', attempts: 3, max_attempts: 3 })])
    const resultado = await fail('job-2', new Error('sin datos'))
    expect(resultado.attempts).toBe(3)
    expect(resultado.status).toBe('failed')
  })

  it('releaseLease devuelve el trabajo a la cola sin marcarlo fallido', async () => {
    await releaseLease('job-1', 'el worker se apagó')
    const fila = db.row(T.jobs, 'job-1')!
    expect(fila.status).toBe('queued')
    expect(fila.lease_until).toBeNull()
    expect(fila.last_error).toBe('el worker se apagó')
  })

  it('cancel solo toca trabajos que todavía no empezaron', async () => {
    db.seed(T.jobs, [jobRow({ id: 'job-3', status: 'queued' })])
    await cancel('job-3', 'lo canceló el usuario')
    expect(db.row(T.jobs, 'job-3')!.status).toBe('cancelled')

    db.seed(T.jobs, [jobRow({ id: 'job-4', status: 'running' })])
    await cancel('job-4')
    expect(db.row(T.jobs, 'job-4')!.status).toBe('running')
  })
})

describe('requeueExpired', () => {
  it('devuelve cuántos rescató', async () => {
    db.rpcHandlers[F.requeueExpiredJobs] = () => ({ data: 4 })
    expect(await requeueExpired()).toBe(4)

    db.rpcHandlers[F.requeueExpiredJobs] = () => ({ data: [{ id: 'a' }, { id: 'b' }] })
    expect(await requeueExpired()).toBe(2)

    db.rpcHandlers[F.requeueExpiredJobs] = () => ({ data: null })
    expect(await requeueExpired()).toBe(0)
  })

  it('explica el error en castellano', async () => {
    db.rpcHandlers[F.requeueExpiredJobs] = () => ({ error: { message: 'boom', code: '42883' } })
    await expect(requeueExpired()).rejects.toThrow(/No se pudieron recuperar los trabajos vencidos/)
  })
})

describe('toJobRecord', () => {
  it('pasa de snake_case a los tipos del dominio', () => {
    const record = toJobRecord(jobRow({ analysis_run_id: null, project_id: null }))
    expect(record.analysisRunId).toBeNull()
    expect(record.projectId).toBeNull()
    expect(record.orgId).toBe('org-1')
    expect(record.leaseUntil).toBeNull()
  })
})
