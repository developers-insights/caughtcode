/**
 * De dónde sale el código de cada proyecto.
 *
 * Este archivo existe por un bug real de producción: un proyecto conectado con
 * la GitHub App (repositorio privado, instalación con acceso confirmado) se
 * intentó bajar por el camino **anónimo**. GitHub le responde 404 a quien no
 * manda credencial, ese 404 se tradujo a "ese repositorio es privado" y el
 * usuario terminó leyendo que conectara una cuenta que ya tenía conectada.
 *
 * Lo que se prueba, en orden de importancia:
 *
 *  1. **Un proyecto con GitHub App nunca sale por el camino anónimo.** Es la
 *     regla que se rompió; si vuelve a romperse, este test tiene que gritar.
 *  2. Los cuatro caminos hacen lo que dicen: copia guardada, App, anónimo y
 *     archivo subido.
 *  3. Cuando de verdad no podemos entrar, el texto es el que ya escribió el
 *     equipo, sale de `copy.ts` y dice qué hacer.
 *  4. Si GitHub no contesta pero el código ya estaba guardado, la auditoría
 *     sigue con la copia y queda dicho en el registro.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ONBOARDING } from '@/content/copy'
import { T } from '@/lib/db/tablas'
import { planDeFuentes, usaCaminoAnonimo } from '@/server/ingest/fuente'
import { setGithubFetch } from '@/server/ingest/github'
import { crearHandlerIngestRepo, type AccesoGithubApp, type AlmacenRepos } from '@/server/ingest/handlers'
import { setJobsDb } from '@/server/jobs/db'
import { JobError } from '@/server/jobs/errors'
import { almacenEnMemoria, contextoDeTrabajo, DbFalsa } from '../fixtures/checks/db-falsa'
import { zipLimpio } from '../fixtures/zips'

/* ── Dobles ───────────────────────────────────────────────────────────── */

const RUTA_GUARDADA = 'org-1/proyecto-1/abc123.zip'
const REPO = 'https://github.com/developers-insights/alianzas-sabias'

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

interface AppFalsa extends AccesoGithubApp {
  bajadas: Array<{ owner: string; repo: string; ref?: string; installationId?: number }>
  instalacionesPedidas: number
}

function appFalsa(
  opciones: {
    instalaciones?: Array<{ id: number; accountLogin: string }>
    zip?: Uint8Array
    fallaCon?: unknown
    sha?: string
  } = {},
): AppFalsa {
  const bajadas: AppFalsa['bajadas'] = []
  return {
    bajadas,
    instalacionesPedidas: 0,
    async listarInstalaciones() {
      this.instalacionesPedidas += 1
      return opciones.instalaciones ?? [{ id: 152524864, accountLogin: 'developers-insights' }]
    },
    async resolverRef(target) {
      if (opciones.fallaCon) throw opciones.fallaCon
      return { ref: target.ref ?? 'main', sha: opciones.sha ?? 'sha-de-hoy' }
    },
    async bajarArchivo(target) {
      if (opciones.fallaCon) throw opciones.fallaCon
      bajadas.push({
        owner: target.owner,
        repo: target.repo,
        ref: target.ref,
        installationId: target.installationId,
      })
      return opciones.zip ?? zipLimpio()
    },
  }
}

/** Deja el `fetch` anónimo de GitHub armado como trampa: si alguien lo usa, se sabe. */
function trampaAnonima(): { usado: () => boolean } {
  let usado = false
  setGithubFetch((async () => {
    usado = true
    return new Response('{"message":"Not Found"}', { status: 404 })
  }) as unknown as typeof fetch)
  return { usado: () => usado }
}

function baseLista(proyecto: Record<string, unknown> = {}): DbFalsa {
  const db = new DbFalsa()
  db.sembrar(T.projects, [
    {
      id: 'proyecto-1',
      org_id: 'org-1',
      name: 'alianzas-sabias',
      source_type: 'github',
      repo_url: REPO,
      repo_ref: 'sha-viejo',
      deployed_url: null,
      storage_path: RUTA_GUARDADA,
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

function encolados(db: DbFalsa): Array<Record<string, any>> {
  return (db.filasDe(T.jobs) as Array<Record<string, any>>).filter((j) => j.kind === 'index_code')
}

function proyectoDe(db: DbFalsa): Record<string, any> {
  return (db.filasDe(T.projects) as Array<Record<string, any>>)[0]
}

let raiz: string
let anterior: string | undefined

beforeEach(async () => {
  raiz = await mkdtemp(path.join(tmpdir(), 'caughtcode-fuente-'))
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

/* ── El plan, sin red ni base ─────────────────────────────────────────── */

describe('plan de fuentes', () => {
  const rutaCorrida = 'org-1/proyecto-1/corridas/corrida-1/codigo.zip'

  it('un proyecto conectado con la GitHub App nunca sale por el camino anónimo', () => {
    // Todas las combinaciones que se pueden dar en la base para source_type github.
    for (const storagePath of [null, RUTA_GUARDADA, rutaCorrida]) {
      for (const repoUrl of [REPO, null]) {
        const plan = planDeFuentes({ sourceType: 'github', repoUrl, storagePath, rutaCorrida })
        expect(usaCaminoAnonimo(plan)).toBe(false)
      }
    }
  })

  it('con la App: primero el repositorio de hoy, la copia guardada como respaldo', () => {
    expect(
      planDeFuentes({
        sourceType: 'github',
        repoUrl: REPO,
        storagePath: RUTA_GUARDADA,
        rutaCorrida,
      }),
    ).toEqual([
      { tipo: 'github_app', url: REPO },
      { tipo: 'guardado', ruta: RUTA_GUARDADA },
    ])
  })

  it('la copia de esta misma corrida va primero: un reintento no vuelve a salir a la red', () => {
    const plan = planDeFuentes({
      sourceType: 'github',
      repoUrl: REPO,
      storagePath: rutaCorrida,
      rutaCorrida,
    })
    expect(plan[0]).toEqual({ tipo: 'guardado', ruta: rutaCorrida })
  })

  it('un repositorio público sí usa el camino sin credencial', () => {
    expect(
      planDeFuentes({ sourceType: 'github_public', repoUrl: REPO, storagePath: null, rutaCorrida }),
    ).toEqual([{ tipo: 'github_publico', url: REPO }])
  })

  it('un proyecto subido como archivo se lee de lo que guardamos, y nada más', () => {
    expect(
      planDeFuentes({
        sourceType: 'zip',
        repoUrl: null,
        storagePath: RUTA_GUARDADA,
        rutaCorrida,
      }),
    ).toEqual([{ tipo: 'guardado', ruta: RUTA_GUARDADA }])
  })

  it('sin copia y sin dirección no hay nada que intentar', () => {
    expect(
      planDeFuentes({ sourceType: 'zip', repoUrl: null, storagePath: null, rutaCorrida }),
    ).toEqual([])
  })
})

/* ── Los cuatro caminos, de punta a punta ─────────────────────────────── */

describe('handler de ingest_repo: de dónde saca el código', () => {
  it('repositorio privado con GitHub App: entra con la instalación, sin tocar el camino anónimo', async () => {
    const db = baseLista({ storage_path: null })
    setJobsDb(db)
    db.sembrar(T.projectConnections, [
      {
        id: 'c1',
        project_id: 'proyecto-1',
        provider: 'github',
        credentials_ref: 'cifrado',
        created_at: '2026-01-01',
      },
    ])
    const trampa = trampaAnonima()
    const app = appFalsa()

    const handler = crearHandlerIngestRepo({
      db: async () => db,
      almacen: almacenFalso(),
      store: almacenEnMemoria().store,
      github: app,
      descifrarGithub: async () => ({
        installationId: 152524864,
        owner: 'developers-insights',
        repo: 'alianzas-sabias',
      }),
    })
    await handler({}, contextoDeTrabajo({ analysisRunId: null }))

    // Esto es exactamente lo que fallaba: se bajaba sin credencial.
    expect(trampa.usado()).toBe(false)
    expect(app.bajadas).toEqual([
      {
        owner: 'developers-insights',
        repo: 'alianzas-sabias',
        ref: 'main',
        installationId: 152524864,
      },
    ])
    expect(encolados(db)).toHaveLength(1)
    // El commit que se analizó queda anotado: es lo que fecha la evidencia.
    expect(proyectoDe(db).repo_ref).toBe('sha-de-hoy')
  })

  it('si el proyecto no dejó su conexión guardada, busca la instalación de la cuenta dueña', async () => {
    const db = baseLista({ storage_path: null })
    setJobsDb(db)
    const trampa = trampaAnonima()
    const app = appFalsa({
      instalaciones: [
        { id: 999, accountLogin: 'otra-cuenta' },
        { id: 152524864, accountLogin: 'developers-insights' },
      ],
    })

    const handler = crearHandlerIngestRepo({
      db: async () => db,
      almacen: almacenFalso(),
      store: almacenEnMemoria().store,
      github: app,
    })
    await handler({}, contextoDeTrabajo({ analysisRunId: null }))

    expect(trampa.usado()).toBe(false)
    expect(app.bajadas[0].installationId).toBe(152524864)
  })

  it('sin ninguna instalación de esa cuenta lo dice con el texto del equipo y no insiste', async () => {
    const db = baseLista({ storage_path: null })
    setJobsDb(db)
    const app = appFalsa({ instalaciones: [{ id: 999, accountLogin: 'otra-cuenta' }] })

    const handler = crearHandlerIngestRepo({
      db: async () => db,
      almacen: almacenFalso(),
      store: almacenEnMemoria().store,
      github: app,
    })

    let capturado: unknown
    try {
      await handler({}, contextoDeTrabajo({ analysisRunId: null }))
    } catch (error) {
      capturado = error
    }

    expect(capturado).toBeInstanceOf(JobError)
    expect((capturado as JobError).message).toBe(ONBOARDING.erroresDeRepositorio.privado)
    expect((capturado as JobError).retryable).toBe(false)
    expect(encolados(db)).toHaveLength(0)
  })

  it('si GitHub no contesta pero el código ya estaba guardado, la auditoría sigue y queda dicho', async () => {
    const db = baseLista()
    setJobsDb(db)
    const ctx = contextoDeTrabajo({ analysisRunId: null })
    const almacen = almacenFalso({ [RUTA_GUARDADA]: zipLimpio() })
    const app = appFalsa({ fallaCon: Object.assign(new Error('Service Unavailable'), { status: 503 }) })

    const handler = crearHandlerIngestRepo({
      db: async () => db,
      almacen,
      store: almacenEnMemoria().store,
      github: app,
      descifrarGithub: async () => ({
        installationId: 152524864,
        owner: 'developers-insights',
        repo: 'alianzas-sabias',
      }),
    })
    db.sembrar(T.projectConnections, [
      { id: 'c1', project_id: 'proyecto-1', provider: 'github', credentials_ref: 'cifrado' },
    ])

    await handler({}, ctx)

    expect(almacen.descargas).toContain(RUTA_GUARDADA)
    expect(encolados(db)).toHaveLength(1)
    expect(ctx.registro.join(' ')).toMatch(/no pudimos traer tu código de github/i)
    // Y no se inventa un commit nuevo: el código no salió de GitHub.
    expect(proyectoDe(db).repo_ref).toBe('sha-viejo')
  })

  it('repositorio público: sin credencial, por el camino anónimo', async () => {
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

    const app = appFalsa()
    const handler = crearHandlerIngestRepo({
      db: async () => db,
      almacen: almacenFalso(),
      store: almacenEnMemoria().store,
      github: app,
    })
    await handler({}, contextoDeTrabajo({ analysisRunId: null }))

    expect(conCredencial).toBe(false)
    // Y no se pidió ninguna instalación: un repo público no necesita ninguna.
    expect(app.instalacionesPedidas).toBe(0)
    expect(encolados(db)).toHaveLength(1)
  })

  it('proyecto subido como archivo: se lee de la copia guardada, sin tocar GitHub', async () => {
    const db = baseLista({ source_type: 'zip', repo_url: null })
    setJobsDb(db)
    const trampa = trampaAnonima()
    const almacen = almacenFalso({ [RUTA_GUARDADA]: zipLimpio() })
    const app = appFalsa()

    const handler = crearHandlerIngestRepo({
      db: async () => db,
      almacen,
      store: almacenEnMemoria().store,
      github: app,
    })
    await handler({}, contextoDeTrabajo({ analysisRunId: null }))

    expect(trampa.usado()).toBe(false)
    expect(app.bajadas).toHaveLength(0)
    expect(almacen.descargas).toEqual([RUTA_GUARDADA])
    expect(encolados(db)).toHaveLength(1)
  })

  it('cuando GitHub frena la instalación, el trabajo se reintenta en vez de darse por perdido', async () => {
    const db = baseLista({ storage_path: null })
    setJobsDb(db)
    const frenado = Object.assign(new Error('rate limit'), {
      status: 403,
      response: { headers: { 'x-ratelimit-remaining': '0' } },
    })
    const app = appFalsa({ fallaCon: frenado })

    const handler = crearHandlerIngestRepo({
      db: async () => db,
      almacen: almacenFalso(),
      store: almacenEnMemoria().store,
      github: app,
      descifrarGithub: async () => ({
        installationId: 152524864,
        owner: 'developers-insights',
        repo: 'alianzas-sabias',
      }),
    })
    db.sembrar(T.projectConnections, [
      { id: 'c1', project_id: 'proyecto-1', provider: 'github', credentials_ref: 'cifrado' },
    ])

    let capturado: unknown
    try {
      await handler({}, contextoDeTrabajo({ analysisRunId: null }))
    } catch (error) {
      capturado = error
    }

    expect((capturado as JobError).retryable).toBe(true)
    expect((capturado as JobError).message).toBe(
      ONBOARDING.erroresDeRepositorio.demasiadosIntentos,
    )
  })

  it('si la instalación perdió el repositorio, el texto pide revisar a cuáles nos dio acceso', async () => {
    const db = baseLista({ storage_path: null })
    setJobsDb(db)
    const app = appFalsa({ fallaCon: Object.assign(new Error('Not Found'), { status: 404 }) })

    const handler = crearHandlerIngestRepo({
      db: async () => db,
      almacen: almacenFalso(),
      store: almacenEnMemoria().store,
      github: app,
      descifrarGithub: async () => ({
        installationId: 152524864,
        owner: 'developers-insights',
        repo: 'alianzas-sabias',
      }),
    })
    db.sembrar(T.projectConnections, [
      { id: 'c1', project_id: 'proyecto-1', provider: 'github', credentials_ref: 'cifrado' },
    ])

    await expect(handler({}, contextoDeTrabajo({ analysisRunId: null }))).rejects.toMatchObject({
      message: ONBOARDING.erroresDeRepositorio.privado,
      retryable: false,
    })
  })
})
