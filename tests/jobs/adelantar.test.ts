/**
 * Adelantar la revisión que quedó esperando, sin crear una segunda.
 *
 * `index_code` deja dos trabajos encolados cuando el proyecto tiene app
 * publicada: `run_browser_agent` para ya y `run_checks` con `run_after` a
 * futuro, de red. El agente, al terminar, no encola una revisión nueva:
 * adelanta la que ya está.
 *
 * Lo que se prueba es lo que puede salir mal:
 *
 *  1. **Nunca dos `run_checks` para la misma corrida.** Ni cuando la red ya
 *     arrancó, ni cuando ya terminó, ni cuando el encadenado corre dos veces.
 *  2. **Adelantar de verdad adelanta**: deja `run_after` en el pasado y pisa el
 *     payload con la evidencia.
 *  3. **Compatibilidad**: un `run_browser_agent` encolado por la versión
 *     anterior no tiene red esperando, y ahí sí hay que encolar.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { T } from '@/lib/db/tablas'
import { setJobsDb } from '@/server/jobs/db'
import { adelantarOEncolar, encolarUnaVezPorCorrida } from '@/server/jobs/queue'
import { FakeDb, jobRow } from './fake-db'

let db: FakeDb

const CORRIDA = 'corrida-1'
const DENTRO_DE_UN_RATO = new Date(Date.now() + 20 * 60_000).toISOString()

function laRed(overrides: Record<string, unknown> = {}) {
  return jobRow({
    id: 'red-1',
    analysis_run_id: CORRIDA,
    kind: 'run_checks',
    status: 'queued',
    run_after: DENTRO_DE_UN_RATO,
    payload: { repoPath: '/tmp/proyecto', deployedUrl: 'https://mi-app.vercel.app' },
    ...overrides,
  })
}

function conEvidencia() {
  return {
    orgId: 'org-1',
    projectId: 'proj-1',
    analysisRunId: CORRIDA,
    kind: 'run_checks' as const,
    payload: { repoPath: '/tmp/proyecto', agentEvidence: { network: [{ host: 'ga.com' }] } },
  }
}

beforeEach(() => {
  db = new FakeDb()
  db.seed(T.jobs, [])
  setJobsDb(db)
})

afterEach(() => setJobsDb(null))

describe('adelantarOEncolar', () => {
  it('adelanta la red que estaba esperando y le pisa el payload', async () => {
    db.seed(T.jobs, [laRed()])

    const resultado = await adelantarOEncolar(conEvidencia())

    expect(resultado).toBe('adelantado')
    expect(db.rows(T.jobs)).toHaveLength(1)

    const fila = db.row(T.jobs, 'red-1')!
    expect(new Date(fila.run_after).getTime()).toBeLessThanOrEqual(Date.now())
    expect(fila.status).toBe('queued')
    expect(fila.payload.agentEvidence.network).toHaveLength(1)
  })

  /**
   * La carrera que importa: el diferimiento venció justo cuando el agente
   * terminaba y otro worker ya tomó la red. El `.eq('status','queued')` del
   * UPDATE es el compare-and-set — toca cero filas — y acá se comprueba que la
   * respuesta a eso NO es encolar otra.
   */
  it('si otro worker ya la tomó, no crea una segunda', async () => {
    db.seed(T.jobs, [laRed({ status: 'running' })])

    const resultado = await adelantarOEncolar(conEvidencia())

    expect(resultado).toBe('ya_no_esperaba')
    expect(db.rows(T.jobs)).toHaveLength(1)
    expect(db.row(T.jobs, 'red-1')!.status).toBe('running')
  })

  it('si la revisión ya terminó, tampoco encola otra', async () => {
    db.seed(T.jobs, [laRed({ status: 'succeeded' })])

    expect(await adelantarOEncolar(conEvidencia())).toBe('ya_no_esperaba')
    expect(db.rows(T.jobs)).toHaveLength(1)
  })

  /**
   * Compatibilidad con lo que ya estaba en la cola: un `run_browser_agent`
   * encolado por la versión anterior no dejó ninguna red esperando. Ahí el
   * comportamiento viejo —encolar— es el correcto.
   */
  it('sin nada esperando, encola (los trabajos viejos siguen andando)', async () => {
    const resultado = await adelantarOEncolar(conEvidencia())

    expect(resultado).toBe('encolado')
    const filas = db.rows(T.jobs)
    expect(filas).toHaveLength(1)
    expect(filas[0]!.kind).toBe('run_checks')
    expect(filas[0]!.run_after).toBeDefined()
  })

  it('no toca la red de otra corrida', async () => {
    db.seed(T.jobs, [laRed({ id: 'red-ajena', analysis_run_id: 'corrida-2' })])

    expect(await adelantarOEncolar(conEvidencia())).toBe('encolado')
    expect(db.row(T.jobs, 'red-ajena')!.run_after).toBe(DENTRO_DE_UN_RATO)
    expect(db.rows(T.jobs)).toHaveLength(2)
  })
})

describe('encolarUnaVezPorCorrida', () => {
  it('la segunda vez no encola nada', async () => {
    const entrada = {
      orgId: 'org-1',
      projectId: 'proj-1',
      analysisRunId: CORRIDA,
      kind: 'run_checks' as const,
      payload: { repoPath: '/tmp/proyecto' },
    }

    expect(await encolarUnaVezPorCorrida(entrada)).toBe('encolado')
    expect(await encolarUnaVezPorCorrida(entrada)).toBe('ya_existia')
    expect(db.rows(T.jobs)).toHaveLength(1)
  })

  /**
   * Un trabajo que ya se dio por perdido no se resucita por la puerta de atrás:
   * reencolarlo le devolvería intentos a algo que el usuario ya vio fallar.
   */
  it('un trabajo que terminó mal también frena el reencolado', async () => {
    db.seed(T.jobs, [laRed({ status: 'failed' })])

    const resultado = await encolarUnaVezPorCorrida({
      orgId: 'org-1',
      projectId: 'proj-1',
      analysisRunId: CORRIDA,
      kind: 'run_checks',
      payload: { repoPath: '/tmp/proyecto' },
    })

    expect(resultado).toBe('ya_existia')
    expect(db.rows(T.jobs)).toHaveLength(1)
  })
})
