import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { setJobsDb } from '@/server/jobs/db'
import { FakeDb } from './fake-db'
import { F } from '@/lib/db/tablas'

const ORIGINAL_ENV = { ...process.env }

let db: FakeDb

beforeEach(() => {
  db = new FakeDb()
  db.rpcHandlers[F.claimJob] = () => ({ data: null })
  db.rpcHandlers[F.requeueExpiredJobs] = () => ({ data: 0 })
  setJobsDb(db)
})

afterEach(() => {
  setJobsDb(null)
  process.env = { ...ORIGINAL_ENV }
})

function pedido(headers: Record<string, string> = {}): Request {
  return new Request('https://caughtcode.test/api/worker/tick?max=1', { method: 'GET', headers })
}

describe('POST/GET /api/worker/tick', () => {
  it('sin secreto configurado queda cerrado (nunca abierto por omisión)', async () => {
    delete process.env.CRON_SECRET
    delete process.env.WORKER_SECRET

    const { GET } = await import('@/app/api/worker/tick/route')
    const respuesta = await GET(pedido({ authorization: 'Bearer lo-que-sea' }))

    expect(respuesta.status).toBe(401)
  })

  it('rechaza sin header y con secreto equivocado', async () => {
    process.env.CRON_SECRET = 'secreto-de-cron'
    const { GET } = await import('@/app/api/worker/tick/route')

    expect((await GET(pedido())).status).toBe(401)
    expect((await GET(pedido({ authorization: 'Bearer otro' }))).status).toBe(401)
    expect((await GET(pedido({ authorization: 'secreto-de-cron' }))).status).toBe(401)
  })

  it('acepta el secreto de cron y el del worker', async () => {
    process.env.CRON_SECRET = 'secreto-de-cron'
    process.env.WORKER_SECRET = 'secreto-de-worker'
    const { GET } = await import('@/app/api/worker/tick/route')

    for (const secreto of ['secreto-de-cron', 'secreto-de-worker']) {
      const respuesta = await GET(pedido({ authorization: `Bearer ${secreto}` }))
      expect(respuesta.status).toBe(200)
      const cuerpo = await respuesta.json()
      expect(cuerpo.ok).toBe(true)
      expect(cuerpo.procesados).toBe(0)
    }
  })

  it('devuelve el resumen de la tanda', async () => {
    process.env.CRON_SECRET = 'secreto-de-cron'
    db.rpcHandlers[F.requeueExpiredJobs] = () => ({ data: 2 })

    const { GET } = await import('@/app/api/worker/tick/route')
    const respuesta = await GET(pedido({ authorization: 'Bearer secreto-de-cron' }))
    const cuerpo = await respuesta.json()

    expect(cuerpo).toMatchObject({
      ok: true,
      recuperados: 2,
      procesados: 0,
      exitosos: 0,
      fallidos: 0,
      quedanTrabajos: false,
    })
    expect(respuesta.headers.get('cache-control')).toBe('no-store')
  })
})
