/**
 * El bug que estos tests encierran salió de producción.
 *
 * Una auditoría corrió entera y bien (`ingest_repo`, `index_code` y `run_checks`
 * en `succeeded`, 180 hallazgos guardados), y la corrida seguía diciendo
 * `failed` con el mensaje de un primer intento que había fallado una hora antes.
 * La pantalla de hallazgos mira ese estado, así que le tapaba al usuario 180
 * hallazgos válidos con un cartel de "no pudimos terminar la revisión".
 *
 * Causa: nadie cerraba la corrida como terminada, y ningún reintento limpiaba
 * el error del intento anterior.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { T } from '@/lib/db/tablas'
import { setJobsDb } from '@/server/jobs/db'
import { reconcileRunStatus, esTrabajoDeRevision } from '@/server/jobs/reconcile'
import { reopenRun } from '@/server/jobs/progress'
import { FakeDb, jobRow } from './fake-db'

let db: FakeDb

beforeEach(() => {
  db = new FakeDb()
  setJobsDb(db)
})

afterEach(() => {
  setJobsDb(null)
})

function sembrarCorrida(overrides: Record<string, unknown> = {}): void {
  db.seed(T.analysisRuns, [
    {
      id: 'run-1',
      project_id: 'proj-1',
      status: 'running',
      stage: 'Revisando tu proyecto',
      progress: 40,
      error: null,
      finished_at: null,
      ...overrides,
    },
  ])
}

function sembrarCadena(...trabajos: Array<Record<string, unknown>>): void {
  db.seed(
    T.jobs,
    trabajos.map((t, indice) =>
      jobRow({ id: `job-${indice + 1}`, analysis_run_id: 'run-1', ...t }),
    ),
  )
}

describe('reconcileRunStatus', () => {
  it('la cadena entera terminó bien: la corrida queda en succeeded', async () => {
    sembrarCorrida()
    sembrarCadena(
      { kind: 'ingest_repo', status: 'succeeded' },
      { kind: 'index_code', status: 'succeeded' },
      { kind: 'run_checks', status: 'succeeded' },
    )

    const resultado = await reconcileRunStatus('run-1')

    expect(resultado.status).toBe('succeeded')
    const corrida = db.row(T.analysisRuns, 'run-1')!
    expect(corrida.status).toBe('succeeded')
    expect(corrida.progress).toBe(100)
    expect(corrida.finished_at).toBeTruthy()
  })

  it('el reintento exitoso borra el error del intento anterior', async () => {
    // Exactamente la fila de producción: el error es del primer intento.
    sembrarCorrida({
      status: 'failed',
      progress: 100,
      error: 'Ese repositorio es privado, así que todavía no podemos entrar...',
    })
    sembrarCadena(
      { kind: 'ingest_repo', status: 'succeeded' },
      { kind: 'index_code', status: 'succeeded' },
      { kind: 'run_checks', status: 'succeeded' },
    )

    await reconcileRunStatus('run-1')

    const corrida = db.row(T.analysisRuns, 'run-1')!
    expect(corrida.status).toBe('succeeded')
    expect(corrida.error).toBeNull()
  })

  it('mientras quede algo por hacer, la corrida no se cierra', async () => {
    sembrarCorrida()
    sembrarCadena(
      { kind: 'ingest_repo', status: 'succeeded' },
      { kind: 'index_code', status: 'queued' },
    )

    const resultado = await reconcileRunStatus('run-1')

    expect(resultado.status).toBeNull()
    expect(resultado.pendientes).toBe(1)
    expect(db.row(T.analysisRuns, 'run-1')!.status).toBe('running')
  })

  it('algo se cayó pero hay hallazgos: queda parcial, no fallada', async () => {
    sembrarCorrida()
    sembrarCadena(
      { kind: 'run_checks', status: 'succeeded' },
      { kind: 'generate_video', status: 'failed', last_error: 'No pudimos armar el video.' },
    )
    db.seed(T.findings, [{ id: 'f-1', analysis_run_id: 'run-1' }])

    const resultado = await reconcileRunStatus('run-1')

    expect(resultado.status).toBe('partial')
    const corrida = db.row(T.analysisRuns, 'run-1')!
    expect(corrida.status).toBe('partial')
    expect(corrida.error).toBe('No pudimos armar el video.')
  })

  it('se cayó y no hay nada que mostrar: la corrida sí falló', async () => {
    sembrarCorrida()
    sembrarCadena({
      kind: 'ingest_repo',
      status: 'failed',
      last_error: 'Ese repositorio es privado, así que todavía no podemos entrar...',
    })

    const resultado = await reconcileRunStatus('run-1')

    expect(resultado.status).toBe('failed')
    const corrida = db.row(T.analysisRuns, 'run-1')!
    expect(corrida.status).toBe('failed')
    expect(corrida.error).toContain('privado')
  })

  it('un trabajo de otra pantalla no tiñe el estado de la revisión', async () => {
    sembrarCorrida()
    sembrarCadena(
      { kind: 'run_checks', status: 'succeeded' },
      { kind: 'scan_comments', status: 'failed', last_error: 'se cayó el escaneo' },
    )

    const resultado = await reconcileRunStatus('run-1')

    expect(resultado.status).toBe('succeeded')
    expect(db.row(T.analysisRuns, 'run-1')!.error).toBeNull()
  })

  it('sin corrida no toca nada', async () => {
    const resultado = await reconcileRunStatus(null)
    expect(resultado.status).toBeNull()
    expect(db.operations).toHaveLength(0)
  })

  it('esTrabajoDeRevision deja afuera lo que no compone la revisión', () => {
    expect(esTrabajoDeRevision('run_checks')).toBe(true)
    expect(esTrabajoDeRevision('generate_video')).toBe(true)
    expect(esTrabajoDeRevision('scan_comments')).toBe(false)
    expect(esTrabajoDeRevision('build_tutorials')).toBe(false)
  })
})

describe('reopenRun', () => {
  it('una corrida cerrada por un intento fallido se reabre sin el error viejo', async () => {
    sembrarCorrida({
      status: 'failed',
      error: 'Ese repositorio es privado, así que todavía no podemos entrar...',
      finished_at: '2026-08-10T01:18:54.803Z',
    })

    await reopenRun('run-1')

    const corrida = db.row(T.analysisRuns, 'run-1')!
    expect(corrida.status).toBe('running')
    expect(corrida.error).toBeNull()
    expect(corrida.finished_at).toBeNull()
  })

  it('una corrida en marcha no se toca', async () => {
    sembrarCorrida({ status: 'running', stage: 'Revisando tu proyecto', progress: 40 })

    await reopenRun('run-1')

    const corrida = db.row(T.analysisRuns, 'run-1')!
    expect(corrida.status).toBe('running')
    expect(corrida.stage).toBe('Revisando tu proyecto')
    expect(corrida.progress).toBe(40)
  })
})
