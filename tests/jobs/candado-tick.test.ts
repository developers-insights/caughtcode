/**
 * Un tick a la vez.
 *
 * El cron de Vercel dispara /api/worker/tick cada 60 s y los trabajos tardan
 * minutos. Sin candado las invocaciones se apilan y —con Fluid Compute, donde
 * varias comparten los 2 GB de UNA instancia— Vercel mata la instancia entera:
 *
 *     Vercel Runtime Error: instance was killed because it ran out of
 *     available memory
 *
 * y con ella el trabajo que estaba corriendo, sin dejar rastro en la fila.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { F, T } from '@/lib/db/tablas'
import { setJobsDb } from '@/server/jobs/db'
import { FakeDb, jobRow } from './fake-db'

const ORIGINAL_ENV = { ...process.env }

interface Candado {
  titular: string
  venceEn: number
}

/**
 * Reproduce la semántica de las dos funciones de la migración 0016: se puede
 * robar un candado vencido, y solo el titular puede soltar el suyo.
 */
function montarCandados(db: FakeDb): Map<string, Candado> {
  const candados = new Map<string, Candado>()

  db.rpcHandlers[F.tryAcquireWorkerLock] = (args) => {
    const nombre = String(args?.p_name)
    const titular = String(args?.p_holder)
    const ttlMs = Number(args?.p_ttl_seconds ?? 300) * 1000

    const actual = candados.get(nombre)
    const vigenteDeOtro = actual && actual.venceEn > Date.now() && actual.titular !== titular
    if (vigenteDeOtro) return { data: false }

    candados.set(nombre, { titular, venceEn: Date.now() + ttlMs })
    return { data: true }
  }

  db.rpcHandlers[F.releaseWorkerLock] = (args) => {
    const nombre = String(args?.p_name)
    const titular = String(args?.p_holder)
    const actual = candados.get(nombre)
    if (!actual || actual.titular !== titular) return { data: false }
    candados.delete(nombre)
    return { data: true }
  }

  return candados
}

/**
 * FakeDb que deja el `claim` colgado: así se puede tener un tick de verdad
 * adentro del candado mientras arranca el segundo.
 */
class DbConClaimColgado extends FakeDb {
  /** Se resuelve cuando el tick llegó a pedir un trabajo. */
  readonly enClaim: Promise<void>
  private avisarClaim!: () => void
  private destrabarClaim!: () => void

  constructor() {
    super()
    this.enClaim = new Promise<void>((resolve) => {
      this.avisarClaim = resolve
    })
  }

  /** Deja que el `claim` conteste "no hay nada" y el tick termine. */
  destrabar(): void {
    this.destrabarClaim?.()
  }

  rpc(fn: string, args?: Record<string, unknown>): any {
    if (fn === F.claimJob) {
      this.rpcCalls.push({ fn, args })
      this.avisarClaim()
      return new Promise((resolve) => {
        this.destrabarClaim = () => resolve({ data: null, error: null })
      })
    }
    return super.rpc(fn, args)
  }
}

function pedido(): Request {
  // `kinds` acotado a propósito: así la tanda solo carga el módulo de checks y
  // el test no paga tree-sitter, playwright y ffmpeg para nada.
  return new Request('https://caughtcode.test/api/worker/tick?max=1&kinds=run_checks', {
    method: 'GET',
    headers: { authorization: 'Bearer secreto-de-cron' },
  })
}

afterEach(() => {
  setJobsDb(null)
  process.env = { ...ORIGINAL_ENV }
})

beforeEach(() => {
  process.env.CRON_SECRET = 'secreto-de-cron'
})

describe('candado del tick', () => {
  it('el segundo tick no procesa nada mientras el primero sigue adentro', async () => {
    const db = new DbConClaimColgado()
    db.rpcHandlers[F.requeueExpiredJobs] = () => ({ data: [] })
    const candados = montarCandados(db)
    setJobsDb(db)

    const { GET } = await import('@/app/api/worker/tick/route')

    const primero = GET(pedido())
    await db.enClaim // el primer tick ya tiene el candado y está trabajando
    expect(candados.size).toBe(1)

    const segundo = await GET(pedido())
    const cuerpoSegundo = await segundo.json()

    expect(segundo.status).toBe(200)
    expect(cuerpoSegundo).toMatchObject({ ok: true, saltado: true, motivo: 'ya hay un tick corriendo' })
    // Lo que importa: no tocó la cola.
    expect(cuerpoSegundo.procesados).toBeUndefined()

    db.destrabar()
    const cuerpoPrimero = await (await primero).json()
    expect(cuerpoPrimero.ok).toBe(true)
    expect(candados.size).toBe(0)
  })

  it('lo suelta al terminar bien', async () => {
    const db = new FakeDb()
    db.rpcHandlers[F.claimJob] = () => ({ data: null })
    db.rpcHandlers[F.requeueExpiredJobs] = () => ({ data: [] })
    const candados = montarCandados(db)
    setJobsDb(db)

    const { GET } = await import('@/app/api/worker/tick/route')
    const respuesta = await GET(pedido())

    expect(respuesta.status).toBe(200)
    expect(candados.size).toBe(0)
  })

  it('lo suelta también cuando la tanda revienta', async () => {
    const db = new FakeDb()
    // El claim explota: `processBatch` propaga y el handler cae en su catch.
    db.rpcHandlers[F.claimJob] = () => ({ error: { message: 'se cayó la base', code: '08006' } })
    db.rpcHandlers[F.requeueExpiredJobs] = () => ({ data: [] })
    const candados = montarCandados(db)
    setJobsDb(db)

    const { GET } = await import('@/app/api/worker/tick/route')
    const respuesta = await GET(pedido())

    expect(respuesta.status).toBe(500)
    // Un tick que se cayó no puede dejar la cola trabada hasta que venza el candado.
    expect(candados.size).toBe(0)
  })

  it('un candado vencido se puede robar: la cola no queda trabada si el titular se murió', async () => {
    const db = new FakeDb()
    db.rpcHandlers[F.claimJob] = () => ({ data: null })
    db.rpcHandlers[F.requeueExpiredJobs] = () => ({ data: [] })
    const candados = montarCandados(db)
    // Un tick anterior que murió por OOM sin llegar a soltarlo.
    candados.set('worker_tick', { titular: 'tick-muerto', venceEn: Date.now() - 1_000 })
    setJobsDb(db)

    const { GET } = await import('@/app/api/worker/tick/route')
    const cuerpo = await (await GET(pedido())).json()

    expect(cuerpo.saltado).toBeUndefined()
    expect(cuerpo.ok).toBe(true)
    expect(candados.size).toBe(0)
  })

  it('sin el RPC del candado la cola sigue andando (migración 0016 sin aplicar)', async () => {
    const db = new FakeDb()
    db.rpcHandlers[F.claimJob] = () => ({ data: null })
    db.rpcHandlers[F.requeueExpiredJobs] = () => ({ data: [] })
    db.rpcHandlers[F.tryAcquireWorkerLock] = () => ({
      error: { message: 'Could not find the function', code: 'PGRST202' },
    })
    setJobsDb(db)

    const { GET } = await import('@/app/api/worker/tick/route')
    const cuerpo = await (await GET(pedido())).json()

    expect(cuerpo).toMatchObject({ ok: true, procesados: 0 })
  })
})

describe('la tanda toma un solo trabajo', () => {
  it('por omisión pide como mucho uno: esta función se muere por memoria', async () => {
    const db = new FakeDb()
    db.rpcHandlers[F.claimJob] = () => ({ data: jobRow({ id: 'job-1', status: 'running' }) })
    db.rpcHandlers[F.requeueExpiredJobs] = () => ({ data: [] })
    db.seed(T.jobs, [jobRow({ id: 'job-1', status: 'running' })])
    montarCandados(db)
    setJobsDb(db)

    const { GET } = await import('@/app/api/worker/tick/route')
    // Sin `max` en la URL: vale el DEFAULT_MAX_JOBS del route.
    const respuesta = await GET(
      new Request('https://caughtcode.test/api/worker/tick?kinds=run_checks', {
        method: 'GET',
        headers: { authorization: 'Bearer secreto-de-cron' },
      }),
    )
    const cuerpo = await respuesta.json()

    expect(cuerpo.procesados).toBe(1)
    expect(db.rpcCalls.filter((llamada) => llamada.fn === F.claimJob)).toHaveLength(1)
  })
})
