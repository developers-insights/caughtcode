/**
 * El handler de `run_browser_agent`: de una corrida del agente a evidencia usable.
 *
 * Lo que se prueba, en orden de importancia:
 *
 *  1. **La cadena.** Con app publicada el orden es `run_browser_agent` →
 *     `run_checks` con la evidencia adentro. Sin app publicada, `run_checks`
 *     directo. Si esto se rompe, los chequeos que dependen del agente se
 *     saltean en silencio y el producto deja de cumplir lo que promete.
 *  2. **La revisión se encola igual si la prueba falla.** Este trabajo quedó en
 *     el medio de la cadena: si se lleva puesta la auditoría cuando el navegador
 *     no abre, el remedio fue peor que la enfermedad.
 *  3. **Idempotencia.** Correrlo dos veces deja las mismas sesiones, no el doble.
 *  4. **Los errores se cuentan en castellano**, con `retryable` bien puesto.
 *  5. Costo en unidades concretas y etapas sin jerga.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionResult } from '@/lib/types/domain'
import { B, T } from '@/lib/db/tablas'
import { setJobsDb } from '@/server/jobs/db'
import { crearHandlerRunBrowserAgent } from '@/server/agent/handlers'
import type { RunBrowserAgentPayload } from '@/server/agent/handlers'
import type { AgentStorage } from '@/server/agent/storage'
import type { RunAgentSessionOptions } from '@/server/agent'
import { crearHandlerIndexCode } from '@/server/analysis/handlers'
import type { RunChecksPayload } from '@/server/checks/handlers'
import { almacenEnMemoria, contextoDeTrabajo, DbFalsa } from '../fixtures/checks/db-falsa'
import type { ContextoFalso, Fila } from '../fixtures/checks/db-falsa'

/* ── Dobles ───────────────────────────────────────────────────────────── */

const URL_APP = 'https://mi-app.vercel.app'

function sesion(extra: Partial<AgentSessionResult> = {}): AgentSessionResult {
  return {
    taskId: 'cookie_banner',
    outcome: 'completed',
    conclusionPlain: 'Abrí tu página y miré qué se cargaba solo.',
    steps: [{ index: 0, atMs: 900, action: 'observe', url: `${URL_APP}/`, note: 'Entré a la portada.' }],
    durationMs: 4200,
    costUsd: 0.004,
    ...extra,
  }
}

/** Storage de mentira. Guarda en un Map para poder revisar qué se subió. */
function storageFalso(): AgentStorage & { objetos: Map<string, string>; subidas: string[] } {
  const objetos = new Map<string, string>()
  const subidas: string[] = []
  return {
    objetos,
    subidas,
    async subir(bucket, ruta, cuerpo) {
      subidas.push(`${bucket}/${ruta}`)
      objetos.set(`${bucket}/${ruta}`, typeof cuerpo === 'string' ? cuerpo : '<binario>')
    },
    async bajarTexto(bucket, ruta) {
      return objetos.get(`${bucket}/${ruta}`) ?? null
    },
  }
}

/**
 * Motor de mentira. Devuelve sesiones fijas y, si se le pasa, deja observaciones
 * en el recolector — que es el camino real por el que la evidencia llega a los
 * chequeos.
 */
function motorFalso(
  sessions: AgentSessionResult[],
  observar?: (options: RunAgentSessionOptions) => void,
): { run: (options: RunAgentSessionOptions) => Promise<AgentSessionResult[]>; llamadas: number } {
  const estado = { llamadas: 0 }
  return {
    get llamadas() {
      return estado.llamadas
    },
    async run(options) {
      estado.llamadas += 1
      observar?.(options)
      return sessions
    },
  }
}

/** Deja en el recolector lo que en producción deja el navegador de verdad. */
function conRastreador(options: RunAgentSessionOptions): void {
  options.collector?.agregarSesion({
    taskId: 'cookie_banner',
    cookies: [{ name: '_ga', domain: '.mi-app.vercel.app' }],
    cookiesAtMs: 2500,
    steps: [],
    pages: [
      { atMs: 100, url: `${URL_APP}/`, status: 200, html: '<h1>Mi app</h1>' },
    ],
    requests: [
      {
        atMs: 120,
        url: `${URL_APP}/`,
        method: 'GET',
        resourceType: 'document',
        hostname: 'mi-app.vercel.app',
        isNavigation: true,
        blocked: false,
      },
      {
        atMs: 1200,
        url: 'https://www.google-analytics.com/g/collect?v=2',
        method: 'POST',
        resourceType: 'fetch',
        hostname: 'www.google-analytics.com',
        isNavigation: false,
        blocked: false,
      },
    ],
  })
}

function baseLista(): DbFalsa {
  const db = new DbFalsa()
  db.sembrar(T.agentSessions, [])
  db.sembrar(T.jobs, [])
  db.sembrar(T.projects, [{ id: 'proyecto-1', stack_detected: null }])
  db.sembrar(T.codeIndex, [])
  return db
}

const PAYLOAD: RunBrowserAgentPayload = {
  deployedUrl: URL_APP,
  repoPath: '/tmp/proyecto',
}

function trabajosDe(db: DbFalsa, kind: string): Fila[] {
  return db.filasDe(T.jobs).filter((j) => j.kind === kind)
}

function payloadDeRunChecks(db: DbFalsa): RunChecksPayload | undefined {
  const trabajo = trabajosDe(db, 'run_checks')[0]
  return trabajo?.payload as RunChecksPayload | undefined
}

beforeEach(() => setJobsDb(null))
afterEach(() => setJobsDb(null))

/* ── 1. La cadena ─────────────────────────────────────────────────────── */

describe('la cadena: el agente va antes que la revisión', () => {
  it('encola run_checks con la evidencia del agente adentro', async () => {
    const db = baseLista()
    setJobsDb(db)
    const motor = motorFalso([sesion()], conRastreador)

    const handler = crearHandlerRunBrowserAgent({
      db: async () => db,
      store: almacenEnMemoria().store,
      storage: storageFalso(),
      run: motor.run,
    })

    await handler(PAYLOAD, contextoDeTrabajo())

    const siguiente = payloadDeRunChecks(db)
    expect(siguiente, 'no encoló la revisión').toBeDefined()
    expect(siguiente!.repoPath).toBe('/tmp/proyecto')
    expect(siguiente!.deployedUrl).toBe(URL_APP)

    // Lo que hace que los chequeos de rastreadores puedan siquiera correr.
    const pedidos = siguiente!.agentEvidence?.network ?? []
    const analytics = pedidos.find((p) => p.host === 'google-analytics.com')
    expect(analytics, 'la evidencia de red no llegó a la revisión').toBeDefined()
    expect(analytics!.thirdParty).toBe(true)
    expect(analytics!.beforeConsent, 'sin esto el chequeo de consentimiento no puede afirmar nada').toBe(true)
    expect(siguiente!.agentEvidence?.cookies?.[0]?.name).toBe('_ga')
    expect(siguiente!.agentEvidence?.pages?.[0]?.status).toBe(200)
  })

  it('con app publicada, index_code encola el agente y NO la revisión', async () => {
    const db = baseLista()
    setJobsDb(db)

    const handler = crearHandlerIndexCode({
      db: async () => db,
      build: async () => ({ index: indiceVacio(), stack: stackVacio(), stages: {} }),
      store: almacenEnMemoria().store,
    })

    await handler({ repoPath: '/tmp/proyecto', deployedUrl: URL_APP }, contextoDeTrabajo())

    const kinds = db.filasDe(T.jobs).map((j) => j.kind)
    expect(kinds).toEqual(['run_browser_agent'])

    // El agente necesita estos datos para poder encolar la revisión después.
    const payload = db.filasDe(T.jobs)[0]!.payload as RunBrowserAgentPayload
    expect(payload.repoPath).toBe('/tmp/proyecto')
    expect(payload.deployedUrl).toBe(URL_APP)
  })

  it('sin app publicada, index_code encola la revisión directo', async () => {
    const db = baseLista()
    setJobsDb(db)

    const handler = crearHandlerIndexCode({
      db: async () => db,
      build: async () => ({ index: indiceVacio(), stack: stackVacio(), stages: {} }),
      store: almacenEnMemoria().store,
    })

    await handler({ repoPath: '/tmp/proyecto' }, contextoDeTrabajo())

    expect(db.filasDe(T.jobs).map((j) => j.kind)).toEqual(['run_checks'])
  })
})

/* ── 2. La revisión se encola igual si la prueba falla ────────────────── */

describe('una prueba fallida no se lleva puesta la auditoría', () => {
  it('sin navegador instalado: encola la revisión y recién después falla', async () => {
    const db = baseLista()
    setJobsDb(db)

    const handler = crearHandlerRunBrowserAgent({
      db: async () => db,
      store: almacenEnMemoria().store,
      storage: storageFalso(),
      run: async () => {
        throw new Error(
          "browserType.launch: Executable doesn't exist at /root/.cache/ms-playwright/chromium-1234/chrome-linux/chrome",
        )
      },
    })

    const ctx = contextoDeTrabajo()
    const fallo = await handler(PAYLOAD, ctx).catch((error: unknown) => error)

    // Primero lo importante: el usuario recibe igual la revisión de su código.
    expect(payloadDeRunChecks(db), 'la cadena se cortó').toBeDefined()

    expect(fallo).toMatchObject({ retryable: false, code: 'navegador_no_disponible' })
    const mensaje = (fallo as Error).message
    expect(mensaje).toMatch(/no pudimos abrir un navegador/i)
    expect(mensaje).toMatch(/tu código se revisó igual/i)
    // Nunca un stacktrace ni el error crudo de la librería.
    expect(mensaje).not.toMatch(/browserType|Executable|ms-playwright|at \//)
  })

  it('sin dirección publicada válida: lo dice sin jerga y encola la revisión', async () => {
    const db = baseLista()
    setJobsDb(db)
    const motor = motorFalso([sesion()])

    const handler = crearHandlerRunBrowserAgent({
      db: async () => db,
      store: almacenEnMemoria().store,
      storage: storageFalso(),
      run: motor.run,
    })

    const fallo = await handler({ deployedUrl: 'no-es-una-direccion' }, contextoDeTrabajo()).catch(
      (error: unknown) => error,
    )

    expect(motor.llamadas, 'abrió el navegador sin tener a dónde ir').toBe(0)
    expect(payloadDeRunChecks(db)).toBeDefined()
    expect(fallo).toMatchObject({ retryable: false, code: 'sin_direccion' })
    expect((fallo as Error).message).toMatch(/dirección válida de tu app publicada/i)
  })

  it('si tu app no responde, reintenta mientras queden intentos', async () => {
    const db = baseLista()
    setJobsDb(db)
    const caida = sesion({ outcome: 'blocked', conclusionPlain: 'No pude abrir tu app.' })

    const handler = crearHandlerRunBrowserAgent({
      db: async () => db,
      store: almacenEnMemoria().store,
      storage: storageFalso(),
      run: motorFalso([caida]).run,
    })

    const fallo = await handler(PAYLOAD, contextoDeTrabajo()).catch((error: unknown) => error)

    expect(fallo).toMatchObject({ retryable: true, code: 'app_no_responde' })
    expect((fallo as Error).message).toMatch(/no respondió/i)
    expect((fallo as Error).message).toMatch(/de nuevo en unos minutos/i)
    // Lo que sí probó queda guardado aunque el intento haya fallado.
    expect(db.filasDe(T.agentSessions)).toHaveLength(1)
  })

  it('en el último intento deja de reintentar, encola la revisión y explica qué hacer', async () => {
    const db = baseLista()
    setJobsDb(db)
    const caida = sesion({ outcome: 'blocked', conclusionPlain: 'No pude abrir tu app.' })

    const handler = crearHandlerRunBrowserAgent({
      db: async () => db,
      store: almacenEnMemoria().store,
      storage: storageFalso(),
      run: motorFalso([caida]).run,
    })

    const ctx: ContextoFalso = { ...contextoDeTrabajo(), attempt: 3, maxAttempts: 3 }
    const fallo = await handler(PAYLOAD, ctx).catch((error: unknown) => error)

    expect(payloadDeRunChecks(db), 'la cadena se cortó en el último intento').toBeDefined()
    expect(fallo).toMatchObject({ retryable: false, code: 'app_no_responde' })
    expect((fallo as Error).message).toMatch(/revisá que la dirección sea la correcta/i)
  })
})

/* ── 3. Idempotencia ──────────────────────────────────────────────────── */

describe('idempotencia: correrlo dos veces no duplica nada', () => {
  it('dos trabajos distintos sobre la misma corrida dejan las mismas sesiones', async () => {
    const db = baseLista()
    setJobsDb(db)
    const storage = storageFalso()
    const motor = motorFalso([sesion(), sesion({ taskId: 'privacy_terms' })])

    const handler = crearHandlerRunBrowserAgent({
      db: async () => db,
      store: almacenEnMemoria().store,
      storage,
      run: motor.run,
    })

    await handler(PAYLOAD, contextoDeTrabajo({ jobId: 'trabajo-1' }))
    expect(db.filasDe(T.agentSessions)).toHaveLength(2)

    await handler(PAYLOAD, contextoDeTrabajo({ jobId: 'trabajo-2' }))
    expect(db.filasDe(T.agentSessions), 'duplicó las pruebas al reintentar').toHaveLength(2)
  })

  it('no vuelve a abrir el navegador si la prueba de esa corrida ya está guardada', async () => {
    const db = baseLista()
    setJobsDb(db)
    const storage = storageFalso()
    const motor = motorFalso([sesion()], conRastreador)

    const handler = crearHandlerRunBrowserAgent({
      db: async () => db,
      store: almacenEnMemoria().store,
      storage,
      run: motor.run,
    })

    await handler(PAYLOAD, contextoDeTrabajo({ jobId: 'trabajo-1' }))
    await handler(PAYLOAD, contextoDeTrabajo({ jobId: 'trabajo-2' }))

    expect(motor.llamadas, 'volvió a pagar una corrida entera del agente').toBe(1)
  })

  it('la evidencia cuelga de la corrida, así que reintentar pisa lo de antes', async () => {
    const db = baseLista()
    setJobsDb(db)
    const storage = storageFalso()

    const handler = crearHandlerRunBrowserAgent({
      db: async () => db,
      store: almacenEnMemoria().store,
      storage,
      run: motorFalso([sesion()]).run,
    })

    await handler(PAYLOAD, contextoDeTrabajo())

    const rutas = storage.subidas
    expect(rutas.length).toBeGreaterThan(0)
    for (const ruta of rutas) {
      expect(ruta).toContain(`${B.recordings}/org-1/proyecto-1/corrida-1/`)
    }
  })
})

/* ── 4. Errores de escritura ──────────────────────────────────────────── */

describe('errores de escritura', () => {
  it('si no se pueden guardar las pruebas, el error se puede reintentar', async () => {
    const db = baseLista()
    setJobsDb(db)
    db.fallaEn = { tabla: T.agentSessions, operacion: 'insert' }

    const handler = crearHandlerRunBrowserAgent({
      db: async () => db,
      store: almacenEnMemoria().store,
      storage: storageFalso(),
      run: motorFalso([sesion()]).run,
    })

    const fallo = await handler(PAYLOAD, contextoDeTrabajo()).catch((error: unknown) => error)
    expect(fallo).toMatchObject({ retryable: true, code: 'guardado_fallido' })
  })

  it('sin corrida asociada corta antes de abrir nada', async () => {
    const db = baseLista()
    setJobsDb(db)
    const motor = motorFalso([sesion()])

    const handler = crearHandlerRunBrowserAgent({
      db: async () => db,
      store: almacenEnMemoria().store,
      storage: storageFalso(),
      run: motor.run,
    })

    await expect(
      handler(PAYLOAD, contextoDeTrabajo({ analysisRunId: null })),
    ).rejects.toMatchObject({ retryable: false, code: 'sin_corrida' })

    expect(motor.llamadas).toBe(0)
  })
})

/* ── 5. Lo que el usuario ve ──────────────────────────────────────────── */

describe('lo que el usuario ve mientras corre', () => {
  it('guarda cada prueba con su conclusión y el video apuntando a donde quedó', async () => {
    const db = baseLista()
    setJobsDb(db)

    const handler = crearHandlerRunBrowserAgent({
      db: async () => db,
      store: almacenEnMemoria().store,
      storage: storageFalso(),
      run: motorFalso([sesion({ outcome: 'not_found', conclusionPlain: 'No encontré cómo borrar la cuenta.' })]).run,
    })

    await handler(PAYLOAD, contextoDeTrabajo())

    const fila = db.filasDe(T.agentSessions)[0]!
    expect(fila).toMatchObject({
      analysis_run_id: 'corrida-1',
      task_id: 'cookie_banner',
      outcome: 'not_found',
      conclusion_plain: 'No encontré cómo borrar la cuenta.',
    })
    expect(fila.duration_ms).toBe(4200)
    // Sin archivo local no hay grabación: mejor vacío que una ruta que no abre.
    expect(fila.recording_url).toBeNull()
  })

  it('reporta el costo en unidades que se entienden, nunca en créditos', async () => {
    const db = baseLista()
    setJobsDb(db)
    const ctx = contextoDeTrabajo()

    const handler = crearHandlerRunBrowserAgent({
      db: async () => db,
      store: almacenEnMemoria().store,
      storage: storageFalso(),
      run: motorFalso([sesion()]).run,
    })

    await handler(PAYLOAD, ctx)

    expect(ctx.costos.length).toBeGreaterThan(0)
    for (const costo of ctx.costos) {
      expect(costo.costUsd).toBeGreaterThanOrEqual(0)
      expect(costo.unitLabel.length).toBeGreaterThan(0)
      expect(costo.unitLabel).not.toMatch(/cr[eé]dito/i)
    }
    expect(ctx.costos.some((c) => c.unitLabel === 'pruebas en tu app')).toBe(true)
  })

  it('las etapas que ve el usuario están en castellano y sin jerga', async () => {
    const db = baseLista()
    setJobsDb(db)
    const ctx = contextoDeTrabajo()

    const handler = crearHandlerRunBrowserAgent({
      db: async () => db,
      store: almacenEnMemoria().store,
      storage: storageFalso(),
      run: motorFalso([sesion()]).run,
    })

    await handler(PAYLOAD, ctx)

    const etiquetas = ctx.etapas.map((e) => e.stage).filter((s): s is string => Boolean(s))
    expect(etiquetas).toContain('Probando tu app como si fuera un usuario')

    const { detectarJerga } = await import('@/content/lenguaje')
    for (const etiqueta of etiquetas) {
      expect(detectarJerga(etiqueta), `la etapa "${etiqueta}" tiene jerga`).toEqual([])
    }

    const progresos = ctx.etapas
      .map((e) => e.progress)
      .filter((p): p is number => typeof p === 'number')
    expect(Math.max(...progresos)).toBe(100)
  })

  it('avisa cuando la revisión arranca sin lo que vio el navegador', async () => {
    const db = baseLista()
    setJobsDb(db)
    const ctx = contextoDeTrabajo()

    const handler = crearHandlerRunBrowserAgent({
      db: async () => db,
      store: almacenEnMemoria().store,
      storage: storageFalso(),
      // Motor que no deja ninguna observación: pasa cuando la app no carga nada.
      run: motorFalso([sesion()]).run,
    })

    await handler(PAYLOAD, ctx)

    expect(ctx.registro.some((m) => m.includes('sin lo que observa el navegador'))).toBe(true)
    expect(payloadDeRunChecks(db)!.agentEvidence).toBeUndefined()
  })
})

/* ── 6. Enganche con la cola ──────────────────────────────────────────── */

describe('enganche con la cola', () => {
  it('importar el módulo deja registrado el handler', async () => {
    const { hasRealHandler, resetHandlers, registerHandler } = await import('@/server/jobs')
    resetHandlers()
    expect(hasRealHandler('run_browser_agent')).toBe(false)

    await import('@/server/agent/handlers')
    registerHandler('run_browser_agent', crearHandlerRunBrowserAgent())

    expect(hasRealHandler('run_browser_agent')).toBe(true)
  })
})

/* ── Ayudas ───────────────────────────────────────────────────────────── */

function indiceVacio() {
  return {
    fileCount: 3,
    totalBytes: 100,
    languages: { typescript: 3 },
    routes: [],
    symbols: [],
    edges: [],
    rankedFiles: [],
    dbSchema: { source: 'none' as const, tables: [], buckets: [], functions: [] },
    truncated: false,
    notes: [],
  }
}

function stackVacio() {
  return {
    framework: 'nextjs' as const,
    language: 'typescript' as const,
    packageManager: 'pnpm' as const,
    backends: [],
    hasTypescript: true,
    hasTailwind: false,
    routerKind: 'app' as const,
    evidence: [],
  }
}
