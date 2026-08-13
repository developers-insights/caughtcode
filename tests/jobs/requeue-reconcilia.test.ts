/**
 * El bug que estos tests encierran salió de la base de producción.
 *
 * `requeue_expired_jobs_caughtcode()` marca `failed` **en SQL** a los trabajos
 * que perdieron el lease con los intentos agotados. Ese camino nunca pasaba por
 * `reconcileRunStatus()`, así que quedaban trabajos en `failed` con su corrida en
 * `running` para siempre, y la pantalla de hallazgos mostrando "Estamos
 * revisando tu app" hasta el fin de los tiempos. Dos corridas reales así:
 *
 *     7713e31f-c789-4002-8421-0044be7644c5
 *     4f81ed96-21c2-4454-9909-26b105043708
 *
 * Desde la migración 0016 el RPC devuelve QUÉ tocó, que es lo único que faltaba
 * para poder avisarle a la corrida correcta.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { F, T } from '@/lib/db/tablas'
import { setJobsDb } from '@/server/jobs/db'
import { requeueExpired } from '@/server/jobs/queue'
import { barrerCorridasHuerfanas } from '@/server/jobs/reconcile'
import { FakeDb, jobRow } from './fake-db'

let db: FakeDb

beforeEach(() => {
  db = new FakeDb()
  setJobsDb(db)
})

afterEach(() => {
  setJobsDb(null)
})

function sembrarCorridas(...corridas: Array<Record<string, unknown>>): void {
  db.seed(
    T.analysisRuns,
    corridas.map((corrida) => ({
      project_id: 'proj-1',
      status: 'running',
      stage: 'Revisando tu proyecto',
      progress: 40,
      error: null,
      finished_at: null,
      ...corrida,
    })),
  )
}

describe('requeueExpired reconcilia las corridas de lo que ya no vuelve', () => {
  it('un trabajo que quedó failed cierra su corrida en vez de dejarla abierta', async () => {
    sembrarCorridas({ id: 'run-1' })
    db.seed(T.jobs, [
      jobRow({ id: 'job-1', analysis_run_id: 'run-1', kind: 'ingest_repo', status: 'succeeded' }),
      jobRow({
        id: 'job-2',
        analysis_run_id: 'run-1',
        kind: 'run_checks',
        status: 'failed',
        attempts: 3,
        last_error: 'El trabajo dejó de responder y se agotaron los reintentos.',
      }),
    ])
    db.rpcHandlers[F.requeueExpiredJobs] = () => ({
      data: [{ id: 'job-2', analysis_run_id: 'run-1', status: 'failed' }],
    })

    expect(await requeueExpired()).toBe(1)

    const corrida = db.row(T.analysisRuns, 'run-1')!
    expect(corrida.status).toBe('failed')
    expect(corrida.error).toBe('El trabajo dejó de responder y se agotaron los reintentos.')
    expect(corrida.finished_at).toBeTruthy()
  })

  it('el que vuelve a la cola no cierra nada: la corrida sigue en marcha', async () => {
    sembrarCorridas({ id: 'run-1' })
    db.seed(T.jobs, [
      jobRow({ id: 'job-1', analysis_run_id: 'run-1', kind: 'run_checks', status: 'queued' }),
    ])
    db.rpcHandlers[F.requeueExpiredJobs] = () => ({
      data: [{ id: 'job-1', analysis_run_id: 'run-1', status: 'queued' }],
    })

    expect(await requeueExpired()).toBe(1)
    expect(db.row(T.analysisRuns, 'run-1')!.status).toBe('running')
  })

  it('reconcilia una sola vez por corrida aunque caigan varios trabajos suyos', async () => {
    sembrarCorridas({ id: 'run-1' })
    db.seed(T.jobs, [
      jobRow({ id: 'job-1', analysis_run_id: 'run-1', kind: 'run_checks', status: 'failed' }),
      jobRow({ id: 'job-2', analysis_run_id: 'run-1', kind: 'index_code', status: 'failed' }),
    ])
    db.rpcHandlers[F.requeueExpiredJobs] = () => ({
      data: [
        { id: 'job-1', analysis_run_id: 'run-1', status: 'failed' },
        { id: 'job-2', analysis_run_id: 'run-1', status: 'failed' },
      ],
    })

    await requeueExpired()

    // Una sola escritura sobre la corrida: dos no romperían nada (reconciliar es
    // idempotente), pero sí querrían decir que no estamos agrupando por corrida.
    const escrituras = db.operations.filter(
      (op) => op.table === T.analysisRuns && op.type === 'update',
    )
    expect(escrituras).toHaveLength(1)
  })

  it('sigue funcionando si la base todavía tiene el RPC viejo que devuelve un número', async () => {
    db.rpcHandlers[F.requeueExpiredJobs] = () => ({ data: 4 })
    expect(await requeueExpired()).toBe(4)
  })
})

describe('barrerCorridasHuerfanas', () => {
  it('cierra la corrida running que ya no tiene trabajos pendientes', async () => {
    sembrarCorridas({ id: 'run-1' })
    db.seed(T.jobs, [
      jobRow({ id: 'job-1', analysis_run_id: 'run-1', kind: 'ingest_repo', status: 'succeeded' }),
      jobRow({ id: 'job-2', analysis_run_id: 'run-1', kind: 'run_checks', status: 'succeeded' }),
    ])

    const resultado = await barrerCorridasHuerfanas()

    expect(resultado).toEqual({ revisadas: 1, cerradas: 1 })
    expect(db.row(T.analysisRuns, 'run-1')!.status).toBe('succeeded')
  })

  it('no toca la corrida que todavía tiene trabajo en cola', async () => {
    sembrarCorridas({ id: 'run-1' }, { id: 'run-2' })
    db.seed(T.jobs, [
      jobRow({ id: 'job-1', analysis_run_id: 'run-1', kind: 'run_checks', status: 'succeeded' }),
      jobRow({ id: 'job-2', analysis_run_id: 'run-2', kind: 'run_checks', status: 'queued' }),
    ])

    const resultado = await barrerCorridasHuerfanas()

    expect(resultado).toEqual({ revisadas: 2, cerradas: 1 })
    expect(db.row(T.analysisRuns, 'run-1')!.status).toBe('succeeded')
    expect(db.row(T.analysisRuns, 'run-2')!.status).toBe('running')
  })

  it('un trabajo que no es de la revisión no la mantiene abierta', async () => {
    sembrarCorridas({ id: 'run-1' })
    db.seed(T.jobs, [
      jobRow({ id: 'job-1', analysis_run_id: 'run-1', kind: 'run_checks', status: 'succeeded' }),
      // Alimenta otra pantalla: que siga corriendo no dice nada de la revisión.
      jobRow({ id: 'job-2', analysis_run_id: 'run-1', kind: 'scan_comments', status: 'running' }),
    ])

    expect(await barrerCorridasHuerfanas()).toEqual({ revisadas: 1, cerradas: 1 })
    expect(db.row(T.analysisRuns, 'run-1')!.status).toBe('succeeded')
  })

  it('una corrida sin trabajos propios se deja abierta: sin evidencia no se inventa un estado', async () => {
    sembrarCorridas({ id: 'run-1' })

    expect(await barrerCorridasHuerfanas()).toEqual({ revisadas: 1, cerradas: 0 })
    expect(db.row(T.analysisRuns, 'run-1')!.status).toBe('running')
  })

  it('sin corridas abiertas no consulta trabajos', async () => {
    expect(await barrerCorridasHuerfanas()).toEqual({ revisadas: 0, cerradas: 0 })
    expect(db.operations.filter((op) => op.table === T.jobs)).toHaveLength(0)
  })
})
