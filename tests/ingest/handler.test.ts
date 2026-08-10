/**
 * El handler de `ingest_repo`: donde arranca de verdad el pipeline.
 *
 * Es el primer trabajo de la cadena y el único que llega **sin corrida**: la
 * crea él. Eso lo vuelve el punto más delicado para la idempotencia, porque un
 * reintento mal resuelto no duplica una fila cualquiera: duplica la auditoría
 * entera y el usuario la paga dos veces.
 *
 * Lo que se prueba, en orden de importancia:
 *
 *  1. **Correrlo dos veces deja una sola corrida y un solo trabajo encadenado.**
 *  2. La corrida se crea cuando falta y se reusa cuando ya está.
 *  3. `index_code` recibe exactamente la forma que espera (`repoPath`,
 *     `deployedUrl`, `databaseUrl`), y el código está de verdad en `repoPath`.
 *  4. Un repositorio que no podemos leer falla con la causa clasificada, no con
 *     un 404 crudo.
 *  5. El costo queda registrado en unidades concretas, sin "créditos".
 */

import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ONBOARDING } from '@/content/copy'
import { T } from '@/lib/db/tablas'
import { JobError } from '@/server/jobs/errors'
import { setJobsDb } from '@/server/jobs/db'
import { crearHandlerIngestRepo, type AlmacenRepos } from '@/server/ingest/handlers'
import { PublicRepoError, setGithubFetch } from '@/server/ingest/github'
import { almacenEnMemoria, contextoDeTrabajo, DbFalsa } from '../fixtures/checks/db-falsa'
import { zipLimpio } from '../fixtures/zips'

/* ── Dobles ───────────────────────────────────────────────────────────── */

const RUTA_SUBIDA = 'org-1/proyecto-1/source.zip'

function almacenFalso(inicial: Record<string, Uint8Array> = {}): AlmacenRepos & {
  objetos: Map<string, Uint8Array>
  descargas: string[]
} {
  const objetos = new Map<string, Uint8Array>(Object.entries(inicial))
  const descargas: string[] = []
  return {
    objetos,
    descargas,
    async descargar(_bucket, ruta) {
      descargas.push(ruta)
      const bytes = objetos.get(ruta)
      if (!bytes) throw new Error(`no hay nada guardado en ${ruta}`)
      return bytes
    },
    async subir(_bucket, ruta, bytes) {
      objetos.set(ruta, bytes)
    },
  }
}

function baseLista(proyecto: Record<string, unknown> = {}): DbFalsa {
  const db = new DbFalsa()
  db.sembrar(T.projects, [
    {
      id: 'proyecto-1',
      org_id: 'org-1',
      name: 'Mi app',
      source_type: 'zip',
      repo_url: null,
      repo_ref: null,
      deployed_url: null,
      storage_path: RUTA_SUBIDA,
      stack_detected: null,
      ...proyecto,
    },
  ])
  db.sembrar(T.analysisRuns, [])
  db.sembrar(T.projectConnections, [])
  db.sembrar(T.jobs, [{ id: 'trabajo-1', analysis_run_id: null, kind: 'ingest_repo' }])
  db.sembrar(T.usageEvents, [])
  return db
}

function corridas(db: DbFalsa): Array<Record<string, any>> {
  return db.filasDe(T.analysisRuns) as Array<Record<string, any>>
}

function encolados(db: DbFalsa): Array<Record<string, any>> {
  return (db.filasDe(T.jobs) as Array<Record<string, any>>).filter((j) => j.kind === 'index_code')
}

let raiz: string
let anterior: string | undefined

beforeEach(async () => {
  raiz = await mkdtemp(path.join(tmpdir(), 'caughtcode-handler-'))
  anterior = process.env.CAUGHTCODE_STORAGE_DIR
  process.env.CAUGHTCODE_STORAGE_DIR = raiz
  setJobsDb(null)
})

afterEach(async () => {
  setJobsDb(null)
  setGithubFetch(null)
  if (anterior === undefined) delete process.env.CAUGHTCODE_STORAGE_DIR
  else process.env.CAUGHTCODE_STORAGE_DIR = anterior
  await rm(raiz, { recursive: true, force: true })
})

/* ── Tests ────────────────────────────────────────────────────────────── */

describe('handler de ingest_repo', () => {
  it('crea la corrida cuando el trabajo llega sin ninguna', async () => {
    const db = baseLista()
    setJobsDb(db)
    const almacen = almacenFalso({ [RUTA_SUBIDA]: zipLimpio() })

    const handler = crearHandlerIngestRepo({
      db: async () => db,
      almacen,
      store: almacenEnMemoria().store,
    })
    await handler({}, contextoDeTrabajo({ analysisRunId: null }))

    expect(corridas(db)).toHaveLength(1)
    expect(corridas(db)[0].project_id).toBe('proyecto-1')
    expect(corridas(db)[0].status).toBe('running')

    // Y el trabajo queda apuntando a su corrida: es lo que la hace recuperable
    // si el worker se muere antes de terminar.
    const trabajo = (db.filasDe(T.jobs) as Array<Record<string, any>>).find(
      (j) => j.id === 'trabajo-1',
    )
    expect(trabajo?.analysis_run_id).toBe(corridas(db)[0].id)
  })

  it('correrlo dos veces no duplica la corrida ni el trabajo siguiente', async () => {
    const db = baseLista()
    setJobsDb(db)
    const almacen = almacenFalso({ [RUTA_SUBIDA]: zipLimpio() })

    const handler = crearHandlerIngestRepo({ db: async () => db, almacen, store: almacenEnMemoria().store })

    // Segundo intento del MISMO trabajo con el avance perdido: el peor caso real
    // (el worker se murió después de escribir y la fila del trabajo se releyó).
    await handler({}, contextoDeTrabajo({ jobId: 'trabajo-1', analysisRunId: null }))

    const handlerReintento = crearHandlerIngestRepo({
      db: async () => db,
      almacen,
      store: almacenEnMemoria().store,
    })
    await handlerReintento({}, contextoDeTrabajo({ jobId: 'trabajo-1', analysisRunId: null }))

    expect(corridas(db)).toHaveLength(1)
    expect(encolados(db)).toHaveLength(1)
  })

  it('encola index_code con la forma exacta que espera, y el código está donde dice', async () => {
    const db = baseLista({ deployed_url: 'https://mi-app.vercel.app' })
    setJobsDb(db)
    const almacen = almacenFalso({ [RUTA_SUBIDA]: zipLimpio() })

    const handler = crearHandlerIngestRepo({
      db: async () => db,
      almacen,
      store: almacenEnMemoria().store,
      descifrar: async () => 'postgres://solo-lectura',
    })
    db.sembrar(T.projectConnections, [
      { id: 'c1', project_id: 'proyecto-1', provider: 'supabase', credentials_ref: 'cifrado' },
    ])

    await handler({}, contextoDeTrabajo({ analysisRunId: null }))

    const siguiente = encolados(db)[0]
    expect(siguiente.analysis_run_id).toBe(corridas(db)[0].id)
    expect(siguiente.project_id).toBe('proyecto-1')
    expect(siguiente.payload).toEqual({
      repoPath: expect.any(String),
      deployedUrl: 'https://mi-app.vercel.app',
      databaseUrl: 'postgres://solo-lectura',
    })

    // El siguiente trabajo va a leer de ahí: si no existe, la cadena se corta.
    const marcador = path.join(siguiente.payload.repoPath, 'package.json')
    expect((await stat(marcador)).isFile()).toBe(true)
  })

  it('si no se puede leer la conexión a la base, el análisis sigue igual y queda dicho', async () => {
    const db = baseLista()
    setJobsDb(db)
    db.sembrar(T.projectConnections, [
      { id: 'c1', project_id: 'proyecto-1', provider: 'supabase', credentials_ref: 'roto' },
    ])
    const ctx = contextoDeTrabajo({ analysisRunId: null })

    const handler = crearHandlerIngestRepo({
      db: async () => db,
      almacen: almacenFalso({ [RUTA_SUBIDA]: zipLimpio() }),
      store: almacenEnMemoria().store,
      descifrar: async () => {
        throw new Error('clave equivocada')
      },
    })
    await handler({}, ctx)

    expect(encolados(db)[0].payload.databaseUrl).toBeNull()
    expect(ctx.registro.join(' ')).toMatch(/conexión a tu base/i)
  })

  it('guarda el código de la corrida en su propia ruta y actualiza el proyecto', async () => {
    const db = baseLista()
    setJobsDb(db)
    const almacen = almacenFalso({ [RUTA_SUBIDA]: zipLimpio() })

    const handler = crearHandlerIngestRepo({ db: async () => db, almacen, store: almacenEnMemoria().store })
    await handler({}, contextoDeTrabajo({ analysisRunId: null }))

    const corrida = corridas(db)[0].id
    const esperada = `org-1/proyecto-1/corridas/${corrida}/codigo.zip`
    expect([...almacen.objetos.keys()]).toContain(esperada)

    const proyecto = (db.filasDe(T.projects) as Array<Record<string, any>>)[0]
    expect(proyecto.storage_path).toBe(esperada)
    expect(proyecto.stack_detected.framework).toBe('nextjs')
  })

  it('trae un repositorio público sin ninguna credencial', async () => {
    const db = baseLista({
      source_type: 'github_public',
      storage_path: null,
      repo_url: 'https://github.com/mi/app',
    })
    setJobsDb(db)
    const zip = zipLimpio()
    let conCredencial = false
    setGithubFetch((async (_entrada: unknown, init?: RequestInit) => {
      if (new Headers(init?.headers).get('authorization')) conCredencial = true
      return new Response(zip as unknown as BodyInit, { status: 200 })
    }) as unknown as typeof fetch)

    const almacen = almacenFalso()
    const handler = crearHandlerIngestRepo({ db: async () => db, almacen, store: almacenEnMemoria().store })
    await handler({}, contextoDeTrabajo({ analysisRunId: null }))

    expect(conCredencial).toBe(false)
    expect(encolados(db)).toHaveLength(1)
    // Lo que trajimos queda guardado, así que un reintento no vuelve a gastar
    // consultas contra GitHub.
    expect([...almacen.objetos.keys()]).toHaveLength(1)
  })

  it('un repositorio que no podemos leer falla con la causa clasificada', async () => {
    const db = baseLista({
      source_type: 'github_public',
      storage_path: null,
      repo_url: 'https://github.com/mi/privado',
    })
    setJobsDb(db)
    setGithubFetch((async (entrada: string | URL | Request) => {
      const url = String(entrada)
      if (url.includes('/users/')) return new Response('{"login":"mi"}', { status: 200 })
      return new Response('{"message":"Not Found"}', { status: 404 })
    }) as unknown as typeof fetch)

    const handler = crearHandlerIngestRepo({
      db: async () => db,
      almacen: almacenFalso(),
      store: almacenEnMemoria().store,
    })

    let capturado: unknown
    try {
      await handler({}, contextoDeTrabajo({ analysisRunId: null }))
    } catch (error) {
      capturado = error
    }

    // Para la cola es un error que no se arregla reintentando, y el texto que
    // queda guardado es el que ya escribió el equipo, no uno inventado acá.
    expect(capturado).toBeInstanceOf(JobError)
    const falla = capturado as JobError
    expect(falla.retryable).toBe(false)
    expect(falla.message).toBe(ONBOARDING.erroresDeRepositorio.privado)
    // La causa original queda enganchada para el log del worker.
    expect((falla.cause as PublicRepoError).code).toBe('privado')

    expect(encolados(db)).toHaveLength(0)
    // La corrida queda marcada como fallida: no puede quedar girando para siempre.
    expect(corridas(db)[0].status).toBe('failed')
    expect(corridas(db)[0].error).toBe(ONBOARDING.erroresDeRepositorio.privado)
  })

  it('cuando GitHub nos frena, el trabajo se reintenta en vez de darse por perdido', async () => {
    const db = baseLista({
      source_type: 'github_public',
      storage_path: null,
      repo_url: 'https://github.com/mi/app',
    })
    setJobsDb(db)
    setGithubFetch((async () =>
      new Response('', { status: 429 })) as unknown as typeof fetch)

    const handler = crearHandlerIngestRepo({
      db: async () => db,
      almacen: almacenFalso(),
      store: almacenEnMemoria().store,
    })

    let capturado: unknown
    try {
      await handler({}, contextoDeTrabajo({ analysisRunId: null }))
    } catch (error) {
      capturado = error
    }

    expect((capturado as JobError).retryable).toBe(true)
    // Todavía puede salir bien: la corrida no se cierra.
    expect(corridas(db)[0].status).toBe('running')
  })

  it('sin código ni dirección lo dice claro y no insiste', async () => {
    const db = baseLista({ storage_path: null, repo_url: null })
    setJobsDb(db)

    const handler = crearHandlerIngestRepo({
      db: async () => db,
      almacen: almacenFalso(),
      store: almacenEnMemoria().store,
    })

    await expect(handler({}, contextoDeTrabajo({ analysisRunId: null }))).rejects.toThrow(
      /no encontramos el código/i,
    )
    expect(encolados(db)).toHaveLength(0)
  })

  it('registra el costo en unidades concretas, nunca en créditos', async () => {
    const db = baseLista()
    setJobsDb(db)
    const ctx = contextoDeTrabajo({ analysisRunId: null })

    const handler = crearHandlerIngestRepo({
      db: async () => db,
      almacen: almacenFalso({ [RUTA_SUBIDA]: zipLimpio() }),
      store: almacenEnMemoria().store,
    })
    await handler({}, ctx)

    expect(ctx.costos).toHaveLength(1)
    const costo = ctx.costos[0]
    expect(costo.category).toBe('storage')
    expect(costo.units).toBeGreaterThan(0)
    expect(costo.unitLabel).not.toMatch(/crédito/i)
    expect(costo.detail).toMatch(/archivo/i)
    expect(costo.costUsd).toBeGreaterThanOrEqual(0)
  })

  it('las etapas que ve el usuario están en castellano y sin jerga', async () => {
    const db = baseLista()
    setJobsDb(db)
    const ctx = contextoDeTrabajo({ analysisRunId: null })

    const handler = crearHandlerIngestRepo({
      db: async () => db,
      almacen: almacenFalso({ [RUTA_SUBIDA]: zipLimpio() }),
      store: almacenEnMemoria().store,
    })
    await handler({}, ctx)

    const etiquetas = ctx.etapas.map((e) => e.stage).filter(Boolean) as string[]
    expect(etiquetas.length).toBeGreaterThan(0)
    for (const etiqueta of etiquetas) {
      expect(etiqueta).not.toMatch(/zip|zipball|repo|storage|stack|sha|commit|payload/i)
    }
  })

  it('sin proyecto asociado no hace nada y lo dice sin jerga', async () => {
    const db = baseLista()
    setJobsDb(db)

    const handler = crearHandlerIngestRepo({
      db: async () => db,
      almacen: almacenFalso(),
      store: almacenEnMemoria().store,
    })

    await expect(
      handler({}, contextoDeTrabajo({ projectId: null, analysisRunId: null })),
    ).rejects.toThrow(/proyecto/i)
    expect(corridas(db)).toHaveLength(0)
  })
})
