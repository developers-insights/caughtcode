import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setJobsDb } from '@/server/jobs/db'
import { JobError } from '@/server/jobs/errors'
import { registerHandler, resetHandlers } from '@/server/jobs/registry'
import { processBatch, processNextJob, runClaimedJob } from '@/server/jobs/runner'
import { toJobRecord } from '@/server/jobs/queue'
import { FakeDb, jobRow } from './fake-db'
import { F, T } from '@/lib/db/tablas'

let db: FakeDb

beforeEach(() => {
  db = new FakeDb()
  setJobsDb(db)
  db.seed(T.analysisRuns, [{ id: 'run-1', status: 'running', stage: null, progress: 0 }])
})

afterEach(() => {
  setJobsDb(null)
  resetHandlers()
})

function tomable(overrides = {}) {
  const row = jobRow({ id: 'job-1', status: 'running', attempts: 1, ...overrides })
  db.seed(T.jobs, [row])
  db.rpcHandlers[F.claimJob] = () => ({ data: row })
  return toJobRecord(row)
}

describe('runClaimedJob', () => {
  it('camino feliz: ejecuta, marca terminado y publica avance', async () => {
    const job = tomable()
    const publicado: Array<string | null> = []
    registerHandler('run_checks', async (_payload, ctx) => {
      await ctx.heartbeat('Revisando tu proyecto', 40)
      // El latido llega a la corrida mientras el trabajo todavía corre: es lo
      // que hace que el usuario vea avance en vez de una barra girando.
      publicado.push(db.row(T.analysisRuns, 'run-1')!.stage)
    })

    const outcome = await runClaimedJob(job, { log: () => {} })

    expect(outcome.outcome).toBe('succeeded')
    expect(db.row(T.jobs, 'job-1')!.status).toBe('succeeded')
    expect(db.row(T.jobs, 'job-1')!.progress).toBe(100)
    expect(publicado).toEqual(['Revisando tu proyecto'])
    // Era el último trabajo de la corrida, así que además la cierra.
    expect(db.row(T.analysisRuns, 'run-1')!.status).toBe('succeeded')
  })

  it('registra el costo y lo acumula en la corrida', async () => {
    const job = tomable()
    registerHandler('run_checks', async (_payload, ctx) => {
      await ctx.reportCost({
        category: 'llm',
        units: 1500,
        unitLabel: 'tokens',
        costUsd: 0.0105,
        detail: 'hallazgo',
      })
    })

    const outcome = await runClaimedJob(job, { log: () => {} })

    expect(outcome.costUsd).toBe(0.0105)
    expect(db.rows(T.usageEvents)).toHaveLength(1)
    expect(db.rows(T.usageEvents)[0].analysis_run_id).toBe('run-1')
    expect(db.row(T.analysisRuns, 'run-1')!.cost_breakdown.totalUsd).toBe(0.0105)
  })

  it('un error reintentable devuelve el trabajo a la cola con backoff', async () => {
    const job = tomable({ attempts: 1, max_attempts: 3 })
    registerHandler('run_checks', async () => {
      throw new Error('se cayó la API del modelo')
    })

    const outcome = await runClaimedJob(job, { log: () => {} })

    expect(outcome.outcome).toBe('retrying')
    expect(outcome.error).toContain('se cayó la API del modelo')
    const fila = db.row(T.jobs, 'job-1')!
    expect(fila.status).toBe('queued')
    expect(fila.lease_until).toBeNull()
    expect(new Date(fila.run_after).getTime()).toBeGreaterThan(Date.now())
  })

  it('un error no reintentable falla de una', async () => {
    const job = tomable({ attempts: 1, max_attempts: 3 })
    registerHandler('run_checks', async () => {
      throw new JobError('el payload no tiene repoPath', { retryable: false })
    })

    const outcome = await runClaimedJob(job, { log: () => {} })

    expect(outcome.outcome).toBe('failed')
    expect(db.row(T.jobs, 'job-1')!.status).toBe('failed')
  })

  it('sin handler registrado falla claro y no gasta reintentos', async () => {
    const job = tomable({ attempts: 1, max_attempts: 3 })

    const outcome = await runClaimedJob(job, { log: () => {} })

    expect(outcome.outcome).toBe('failed')
    expect(outcome.error).toContain('handler no registrado todavía')
    expect(db.row(T.jobs, 'job-1')!.status).toBe('failed')
  })

  it('el handler recibe el payload y el contexto del trabajo', async () => {
    const job = tomable({ payload: { repoPath: '/tmp/repo' } })
    const handler = vi.fn(async () => {})
    registerHandler('run_checks', handler)

    await runClaimedJob(job, { log: () => {} })

    const [payload, ctx] = handler.mock.calls[0] as any[]
    expect(payload).toEqual({ repoPath: '/tmp/repo' })
    expect(ctx.jobId).toBe('job-1')
    expect(ctx.orgId).toBe('org-1')
    expect(ctx.analysisRunId).toBe('run-1')
    expect(ctx.attempt).toBe(1)
  })
})

describe('estado de la corrida (regresión de producción)', () => {
  it('una cadena que termina bien deja la corrida en succeeded, no en failed', async () => {
    // La fila tal cual quedó en producción: la corrida arrastra el error del
    // primer intento, que ya se reencoló y corrió perfecto.
    db.seed(T.analysisRuns, [
      {
        id: 'run-1',
        status: 'failed',
        stage: 'Preparando los videos de lo más importante',
        progress: 100,
        error: 'Ese repositorio es privado, así que todavía no podemos entrar...',
        finished_at: '2026-08-10T01:18:54.803Z',
      },
    ])
    const row = jobRow({ id: 'job-3', kind: 'run_checks', status: 'running', attempts: 1 })
    db.seed(T.jobs, [
      jobRow({ id: 'job-1', kind: 'ingest_repo', status: 'succeeded' }),
      jobRow({ id: 'job-2', kind: 'index_code', status: 'succeeded' }),
      row,
    ])
    db.seed(T.findings, [{ id: 'f-1', analysis_run_id: 'run-1' }])
    registerHandler('run_checks', async () => {})

    const outcome = await runClaimedJob(toJobRecord(row), { log: () => {} })

    expect(outcome.outcome).toBe('succeeded')
    const corrida = db.row(T.analysisRuns, 'run-1')!
    expect(corrida.status).toBe('succeeded')
    expect(corrida.error).toBeNull()
    expect(corrida.progress).toBe(100)
  })

  it('el trabajo en marcha reabre la corrida aunque después falle', async () => {
    db.seed(T.analysisRuns, [
      { id: 'run-1', status: 'failed', progress: 100, error: 'algo de un intento viejo' },
    ])
    const row = jobRow({ id: 'job-1', kind: 'ingest_repo', status: 'running', attempts: 1 })
    db.seed(T.jobs, [row])
    registerHandler('ingest_repo', async () => {
      // Mientras el handler corre, la corrida ya no puede decir que falló.
      const corrida = db.row(T.analysisRuns, 'run-1')!
      expect(corrida.status).toBe('running')
      expect(corrida.error).toBeNull()
      throw new JobError('no encontramos el código', { retryable: false })
    })

    const outcome = await runClaimedJob(toJobRecord(row), { log: () => {} })

    // Falló de verdad y sin hallazgos: ahí sí, la corrida falló.
    expect(outcome.outcome).toBe('failed')
    const corrida = db.row(T.analysisRuns, 'run-1')!
    expect(corrida.status).toBe('failed')
    expect(corrida.error).toContain('no encontramos el código')
  })

  it('con trabajos todavía en cola la corrida no se cierra', async () => {
    const row = jobRow({ id: 'job-1', kind: 'ingest_repo', status: 'running', attempts: 1 })
    db.seed(T.jobs, [row, jobRow({ id: 'job-2', kind: 'index_code', status: 'queued' })])
    registerHandler('ingest_repo', async () => {})

    await runClaimedJob(toJobRecord(row), { log: () => {} })

    expect(db.row(T.analysisRuns, 'run-1')!.status).toBe('running')
  })
})

describe('processNextJob / processBatch', () => {
  it('devuelve null cuando la cola está vacía', async () => {
    db.rpcHandlers[F.claimJob] = () => ({ data: null })
    expect(await processNextJob({ log: () => {} })).toBeNull()
  })

  it('la tanda corta cuando no queda nada por hacer', async () => {
    db.rpcHandlers[F.claimJob] = () => ({ data: null })
    const resumen = await processBatch({ max: 5, log: () => {} })

    expect(resumen).toMatchObject({
      procesados: 0,
      exitosos: 0,
      fallidos: 0,
      quedanTrabajos: false,
    })
  })

  it('la tanda respeta el tope y avisa que quedan trabajos', async () => {
    let servidos = 0
    db.rpcHandlers[F.claimJob] = () => {
      servidos += 1
      const row = jobRow({ id: `job-${servidos}`, status: 'running', attempts: 1 })
      db.rows(T.jobs).push(row)
      return { data: row }
    }
    registerHandler('run_checks', async () => {})

    const resumen = await processBatch({ max: 2, log: () => {} })

    expect(resumen.procesados).toBe(2)
    expect(resumen.exitosos).toBe(2)
    expect(resumen.quedanTrabajos).toBe(true)
  })

  it('la tanda no arranca nada nuevo pasada la fecha límite', async () => {
    db.rpcHandlers[F.claimJob] = () => ({ data: jobRow({ status: 'running', attempts: 1 }) })
    const resumen = await processBatch({ max: 3, deadlineAt: Date.now() - 1, log: () => {} })

    expect(resumen.procesados).toBe(0)
    expect(resumen.quedanTrabajos).toBe(true)
  })
})
