/**
 * El bug que estos tests encierran es el mismo de siempre entrando por otra
 * puerta: la corrida que no cierra nunca.
 *
 * El tick de Vercel dejó de pedir `run_browser_agent`, `generate_video` y
 * `build_tutorials` porque en la función serverless no hay navegador. Pero nada
 * envejecía un `queued`: `requeue_expired_jobs_caughtcode()` solo mira
 * `running`, y `barrerCorridasHuerfanas()` cuenta `queued` como pendiente. Un
 * proyecto con `deployedUrl` encolaba `run_browser_agent`, el worker de Render
 * no existía todavía, y la pantalla giraba para siempre sin un solo log.
 *
 * La parte delicada es la otra mitad: un trabajo que espera porque el worker
 * está ocupado NO puede darse por muerto. Por eso la regla mira si alguien
 * atendió ese tipo de trabajo en la ventana, no solo cuánto esperó.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { T } from '@/lib/db/tablas'
import { setJobsDb } from '@/server/jobs/db'
import {
  ESPERA_MAXIMA_EN_COLA_MS,
  vencerEncoladosDesatendidos,
} from '@/server/jobs/encolados'
import { FakeDb, jobRow } from './fake-db'

const AHORA = new Date('2026-08-12T12:00:00.000Z')

/** Un instante suficientemente viejo como para pasar el umbral de espera. */
function haceRato(extraMs = 60_000): string {
  return new Date(AHORA.getTime() - ESPERA_MAXIMA_EN_COLA_MS - extraMs).toISOString()
}

function reciente(): string {
  return new Date(AHORA.getTime() - 60_000).toISOString()
}

let db: FakeDb

beforeEach(() => {
  db = new FakeDb()
  setJobsDb(db)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  setJobsDb(null)
  vi.restoreAllMocks()
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

describe('vencerEncoladosDesatendidos', () => {
  it('el trabajo que nadie atiende se da por perdido y la corrida cierra', async () => {
    sembrarCorrida()
    db.seed(T.jobs, [
      jobRow({ id: 'job-1', kind: 'ingest_repo', status: 'succeeded', updated_at: haceRato() }),
      jobRow({ id: 'job-2', kind: 'index_code', status: 'succeeded', updated_at: haceRato() }),
      // Nadie tiene navegador: este quedó encolado desde hace media hora.
      jobRow({ id: 'job-3', kind: 'run_browser_agent', status: 'queued', run_after: haceRato() }),
    ])

    const resultado = await vencerEncoladosDesatendidos({ now: AHORA })

    expect(resultado.vencidos).toBe(1)
    const trabajo = db.row(T.jobs, 'job-3')!
    expect(trabajo.status).toBe('failed')
    expect(trabajo.last_error).toContain('Probando tu app como si fuera un usuario')
    expect(trabajo.last_error).not.toMatch(/handler|registrado|módulo/i)

    // Lo que importa: la corrida deja de girar.
    expect(db.row(T.analysisRuns, 'run-1')!.status).not.toBe('running')
  })

  it('si alguien atiende ese tipo, el encolado se deja en paz aunque haya esperado', async () => {
    sembrarCorrida()
    db.seed(T.jobs, [
      // El worker está ocupado con otro video: hay atención reciente del tipo.
      jobRow({ id: 'job-1', kind: 'generate_video', status: 'running', updated_at: reciente() }),
      jobRow({ id: 'job-2', kind: 'generate_video', status: 'queued', run_after: haceRato() }),
    ])

    const resultado = await vencerEncoladosDesatendidos({ now: AHORA })

    expect(resultado.vencidos).toBe(0)
    expect(resultado.atendidos).toContain('generate_video')
    expect(db.row(T.jobs, 'job-2')!.status).toBe('queued')
    expect(db.row(T.analysisRuns, 'run-1')!.status).toBe('running')
  })

  it('un trabajo agendado a futuro no es candidato: el backoff y las verificaciones siguen vivos', async () => {
    sembrarCorrida()
    db.seed(T.jobs, [
      jobRow({
        id: 'job-1',
        kind: 'run_checks',
        status: 'queued',
        // Reintento con backoff: creado hace rato, pero recién puede correr en 10 min.
        created_at: haceRato(),
        run_after: new Date(AHORA.getTime() + 10 * 60_000).toISOString(),
      }),
    ])

    const resultado = await vencerEncoladosDesatendidos({ now: AHORA })

    expect(resultado.revisados).toBe(0)
    expect(db.row(T.jobs, 'job-1')!.status).toBe('queued')
  })

  it('un encolado que recién puede correr tampoco se toca', async () => {
    sembrarCorrida()
    db.seed(T.jobs, [
      jobRow({ id: 'job-1', kind: 'run_browser_agent', status: 'queued', run_after: reciente() }),
    ])

    const resultado = await vencerEncoladosDesatendidos({ now: AHORA })

    expect(resultado.vencidos).toBe(0)
    expect(db.row(T.jobs, 'job-1')!.status).toBe('queued')
  })

  it('otro encolado del mismo tipo no alcanza como prueba de que alguien atiende', async () => {
    // El agujero obvio: si contáramos los `queued` como señal de vida, dos
    // trabajos abandonados se blindarían el uno al otro para siempre.
    sembrarCorrida()
    db.seed(T.jobs, [
      jobRow({ id: 'job-1', kind: 'generate_video', status: 'queued', run_after: haceRato() }),
      jobRow({
        id: 'job-2',
        kind: 'generate_video',
        status: 'queued',
        run_after: haceRato(),
        updated_at: reciente(),
      }),
    ])

    const resultado = await vencerEncoladosDesatendidos({ now: AHORA })

    expect(resultado.vencidos).toBe(2)
  })

  it('correrla dos veces no cambia nada: es idempotente', async () => {
    sembrarCorrida()
    db.seed(T.jobs, [
      jobRow({ id: 'job-1', kind: 'run_checks', status: 'succeeded', updated_at: haceRato() }),
      jobRow({ id: 'job-2', kind: 'generate_video', status: 'queued', run_after: haceRato() }),
    ])

    const primera = await vencerEncoladosDesatendidos({ now: AHORA })
    const motivo = db.row(T.jobs, 'job-2')!.last_error
    const segunda = await vencerEncoladosDesatendidos({ now: AHORA })

    expect(primera.vencidos).toBe(1)
    expect(segunda.vencidos).toBe(0)
    expect(db.row(T.jobs, 'job-2')!.status).toBe('failed')
    expect(db.row(T.jobs, 'job-2')!.last_error).toBe(motivo)
  })

  it('los candidatos salen ordenados por espera: los más viejos primero', async () => {
    db.seed(T.jobs, [
      jobRow({ id: 'nuevo', kind: 'generate_video', status: 'queued', run_after: haceRato(60_000) }),
      jobRow({ id: 'viejo', kind: 'generate_video', status: 'queued', run_after: haceRato(999_000) }),
    ])

    await vencerEncoladosDesatendidos({ now: AHORA, limite: 1 })

    // Con `limit` y sin `order`, PostgREST no garantiza cuál de los dos trae.
    const lectura = db.operations.find((op) => op.type === 'select' && op.limit === 1)
    expect(lectura?.order).toEqual({ column: 'run_after', ascending: true })
    expect(db.row(T.jobs, 'viejo')!.status).toBe('failed')
    expect(db.row(T.jobs, 'nuevo')!.status).toBe('queued')
  })

  it('cola vacía: ni siquiera pregunta quién atiende qué', async () => {
    const resultado = await vencerEncoladosDesatendidos({ now: AHORA })

    expect(resultado).toEqual({ revisados: 0, vencidos: 0, atendidos: [] })
    expect(db.operations).toHaveLength(1)
  })

  it('un trabajo que un worker tomó entre el listado y el update no se pisa', async () => {
    db.seed(T.jobs, [
      jobRow({ id: 'job-1', kind: 'generate_video', status: 'queued', run_after: haceRato() }),
    ])

    // Entre listar candidatos y escribir pasan segundos reales, y en esos
    // segundos el worker de Render puede haberlo tomado. Se simula justo ahí:
    // después de las dos lecturas, antes del UPDATE.
    const original = db.execute.bind(db)
    let lecturas = 0
    db.execute = (op) => {
      const resultado = original(op)
      if (op.type === 'select') {
        lecturas += 1
        if (lecturas === 2) db.row(T.jobs, 'job-1')!.status = 'running'
      }
      return resultado
    }

    const resultado = await vencerEncoladosDesatendidos({ now: AHORA })

    // El `.eq('status', 'queued')` del UPDATE es el candado: no encuentra fila.
    expect(resultado.revisados).toBe(1)
    expect(resultado.vencidos).toBe(0)
    expect(db.row(T.jobs, 'job-1')!.status).toBe('running')
  })
})
