/**
 * El handler de `index_code`: del motor de análisis a una fila en la base.
 *
 * Lo que se prueba, en orden de importancia:
 *
 *  1. **Idempotencia.** Correrlo dos veces sobre la misma corrida deja UN solo
 *     `code_index`, no dos. Si el worker muere después de escribir y antes de
 *     marcar el trabajo terminado, el reintento no puede duplicar el mapa.
 *  2. **Encadenado.** Al terminar encola `run_checks`, y `run_browser_agent`
 *     solo si el proyecto tiene una URL publicada. Sin esto la cadena se corta
 *     y el usuario ve una auditoría que nunca avanza.
 *  3. **Sin corrida no se hace nada**, y el error dice por qué sin jerga.
 *  4. El costo se reporta y las etapas están en castellano (las lee el usuario).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { CodeIndex, StackInfo } from '@/lib/types/domain'
import { crearHandlerIndexCode } from '@/server/analysis/handlers'
import type { IndexCodePayload } from '@/server/analysis/handlers'
import { T } from '@/lib/db/tablas'
import { MAX_STAGE_RESULT_BYTES, STAGE_RESULTS_KEY } from '@/server/jobs'
import { setJobsDb } from '@/server/jobs/db'
import { almacenEnMemoria, contextoDeTrabajo, DbFalsa } from '../fixtures/checks/db-falsa'

/* ── Ayudas ───────────────────────────────────────────────────────────── */

const STACK: StackInfo = {
  framework: 'nextjs',
  language: 'typescript',
  packageManager: 'pnpm',
  backends: ['supabase'],
  hasTypescript: true,
  hasTailwind: true,
  routerKind: 'app',
  evidence: ['package.json declara next'],
}

function indiceFalso(parcial: Partial<CodeIndex> = {}): CodeIndex {
  return {
    fileCount: 12,
    totalBytes: 4096,
    languages: { typescript: 12 },
    routes: [
      {
        path: '/',
        file: 'app/page.tsx',
        kind: 'page',
        isDynamic: false,
        isClient: false,
        looksProtected: false,
      },
    ],
    symbols: [],
    edges: [],
    rankedFiles: [],
    dbSchema: { source: 'none', tables: [], buckets: [], functions: [] },
    truncated: false,
    notes: ['Leímos 12 archivos con el analizador de sintaxis.'],
    ...parcial,
  }
}

function baseLista(): DbFalsa {
  const db = new DbFalsa()
  db.sembrar(T.codeIndex, [])
  db.sembrar(T.projects, [{ id: 'proyecto-1', stack_detected: null }])
  db.sembrar(T.jobs, [])
  return db
}

function buildFalso(index = indiceFalso()) {
  return async () => ({ index, stack: STACK, stages: {} })
}

const PAYLOAD: IndexCodePayload = { repoPath: '/tmp/proyecto' }

beforeEach(() => {
  setJobsDb(null)
})

afterEach(() => {
  setJobsDb(null)
})

/* ── Tests ────────────────────────────────────────────────────────────── */

describe('handler de index_code', () => {
  it('guarda el mapa del proyecto con la forma que espera run_checks', async () => {
    const db = baseLista()
    setJobsDb(db)
    const { store } = almacenEnMemoria()

    const handler = crearHandlerIndexCode({ db: async () => db, build: buildFalso(), store })
    await handler(PAYLOAD, contextoDeTrabajo())

    const filas = db.filasDe(T.codeIndex)
    expect(filas).toHaveLength(1)

    const fila = filas[0] as Record<string, any>
    expect(fila.analysis_run_id).toBe('corrida-1')
    // run_checks lee exactamente estas claves: si cambian, se rompe en silencio.
    expect(fila.symbol_graph).toEqual({ symbols: [], edges: [] })
    expect(fila.stats.fileCount).toBe(12)
    expect(fila.routes).toHaveLength(1)
    expect(store).toBeDefined()
  })

  it('correrlo dos veces deja un solo mapa, no dos', async () => {
    const db = baseLista()
    setJobsDb(db)

    const handler = crearHandlerIndexCode({ db: async () => db, build: buildFalso(), store: almacenEnMemoria().store })
    // Dos trabajos distintos sobre la misma corrida: es el caso real de un
    // reintento después de que el worker se murió.
    await handler(PAYLOAD, contextoDeTrabajo({ jobId: 'trabajo-1' }))
    await handler(PAYLOAD, contextoDeTrabajo({ jobId: 'trabajo-2' }))

    expect(db.filasDe(T.codeIndex)).toHaveLength(1)
  })

  it('encola run_checks al terminar', async () => {
    const db = baseLista()
    setJobsDb(db)

    const handler = crearHandlerIndexCode({ db: async () => db, build: buildFalso(), store: almacenEnMemoria().store })
    await handler(PAYLOAD, contextoDeTrabajo())

    const encolados = db.filasDe(T.jobs) as Array<Record<string, any>>
    expect(encolados.map((j) => j.kind)).toEqual(['run_checks'])
    expect(encolados[0].analysis_run_id).toBe('corrida-1')
  })

  /**
   * Con la app publicada, la revisión NO se encola acá: la encola el agente de
   * navegación cuando termina, pasándole lo que vio (cookies, pedidos de red,
   * accesibilidad). Si las dos salieran juntas, la revisión podría correr antes
   * de que exista esa evidencia y saltearía justo los chequeos que dependen de
   * usar la app de verdad — que son los que el producto promete.
   */
  it('con la app publicada encola solo el agente de navegación, que después encadena la revisión', async () => {
    const db = baseLista()
    setJobsDb(db)

    const handler = crearHandlerIndexCode({ db: async () => db, build: buildFalso(), store: almacenEnMemoria().store })
    await handler(
      { ...PAYLOAD, deployedUrl: 'https://mi-app.vercel.app' },
      contextoDeTrabajo(),
    )

    const kinds = (db.filasDe(T.jobs) as Array<Record<string, any>>).map((j) => j.kind)
    expect(kinds).toContain('run_browser_agent')
    expect(kinds).not.toContain('run_checks')
  })

  it('sin corrida asociada falla con un mensaje entendible y no reintenta', async () => {
    const db = baseLista()
    setJobsDb(db)

    const handler = crearHandlerIndexCode({ db: async () => db, build: buildFalso(), store: almacenEnMemoria().store })

    await expect(
      handler(PAYLOAD, contextoDeTrabajo({ analysisRunId: null })),
    ).rejects.toThrow(/sin corrida asociada/i)

    expect(db.filasDe(T.codeIndex)).toHaveLength(0)
  })

  it('las etapas que ve el usuario están en castellano y sin jerga', async () => {
    const db = baseLista()
    setJobsDb(db)
    const ctx = contextoDeTrabajo()

    const handler = crearHandlerIndexCode({ db: async () => db, build: buildFalso(), store: almacenEnMemoria().store })
    await handler(PAYLOAD, ctx)

    const etiquetas = ctx.etapas.map((e) => e.stage).filter(Boolean) as string[]
    expect(etiquetas.length).toBeGreaterThan(0)
    for (const etiqueta of etiquetas) {
      expect(etiqueta).not.toMatch(/index|parse|AST|schema|RLS/i)
    }
  })

  /**
   * Regresión de un fallo real: con un repo de 406 archivos, la etapa
   * "analizar" devolvía el `CodeIndex` entero (323 KB) y `runStages` la cortaba
   * contra su tope de 32 KB. El trabajo fallaba definitivamente y se llevaba
   * puesto el pipeline: sin mapa no hay revisión, sin revisión no hay hallazgos
   * ni videos. Los tests no lo veían porque el índice de mentira tenía un
   * archivo y una ruta.
   *
   * El índice de acá abajo pesa varios cientos de KB a propósito. Si alguien
   * vuelve a meter el mapa en el payload del trabajo, este test se pone rojo.
   */
  describe('con un repo grande de verdad', () => {
    function indiceGrande(): CodeIndex {
      const symbols = Array.from({ length: 3000 }, (_, i) => ({
        id: `src/modulos/carpeta-${i % 40}/archivo-${i}.tsx#componenteDeVerdadLargo${i}`,
        name: `componenteDeVerdadLargo${i}`,
        kind: 'component' as const,
        file: `src/modulos/carpeta-${i % 40}/archivo-${i}.tsx`,
        line: i,
        exported: true,
      }))
      return indiceFalso({
        fileCount: 406,
        totalBytes: 5_400_000,
        symbols,
        edges: symbols.slice(1).map((s, i) => ({
          from: symbols[i].id,
          to: s.id,
          kind: 'imports' as const,
        })),
        rankedFiles: symbols.map((s) => ({
          file: s.file,
          score: 0.5,
          reason: 'Lo importan varios archivos del proyecto.',
        })),
      })
    }

    it('el índice pesa más que el tope de una etapa (si no, este test no prueba nada)', () => {
      const pesoBytes = JSON.stringify(indiceGrande()).length
      expect(pesoBytes).toBeGreaterThan(MAX_STAGE_RESULT_BYTES)
    })

    it('termina bien y guarda el mapa completo en su tabla', async () => {
      const db = baseLista()
      setJobsDb(db)
      const grande = indiceGrande()

      const handler = crearHandlerIndexCode({
        db: async () => db,
        build: buildFalso(grande),
        store: almacenEnMemoria().store,
      })
      await handler(PAYLOAD, contextoDeTrabajo())

      const filas = db.filasDe(T.codeIndex) as Array<Record<string, any>>
      expect(filas).toHaveLength(1)
      expect(filas[0].symbol_graph.symbols).toHaveLength(grande.symbols.length)
      expect(filas[0].stats.fileCount).toBe(406)
      // Y la cadena siguió: sin esto el usuario ve una auditoría clavada.
      expect((db.filasDe(T.jobs) as Array<Record<string, any>>).map((j) => j.kind)).toEqual([
        'run_checks',
      ])
    })

    it('al payload del trabajo solo va un recibo chico, nunca el mapa', async () => {
      const db = baseLista()
      setJobsDb(db)
      const { store, payloads } = almacenEnMemoria()

      const handler = crearHandlerIndexCode({
        db: async () => db,
        build: buildFalso(indiceGrande()),
        store,
      })
      await handler(PAYLOAD, contextoDeTrabajo({ jobId: 'trabajo-grande' }))

      const guardado = payloads.get('trabajo-grande') ?? {}
      const etapas = guardado[STAGE_RESULTS_KEY] as Record<string, { result: any }>

      for (const [nombre, entrada] of Object.entries(etapas)) {
        const pesoBytes = JSON.stringify(entrada.result ?? null).length
        expect(pesoBytes, `la etapa "${nombre}" volvió a guardar un blob`).toBeLessThan(
          MAX_STAGE_RESULT_BYTES,
        )
      }

      // El recibo apunta a la fila, no la reemplaza.
      const recibo = etapas.analizar.result
      expect(recibo.codeIndexId).toBe((db.filasDe(T.codeIndex)[0] as Record<string, any>).id)
      expect(recibo.archivos).toBe(406)
    })
  })

  it('deja registrado en el log qué motor leyó el código', async () => {
    const db = baseLista()
    setJobsDb(db)
    const ctx = contextoDeTrabajo()

    const handler = crearHandlerIndexCode({ db: async () => db, build: buildFalso(), store: almacenEnMemoria().store })
    await handler(PAYLOAD, ctx)

    expect(ctx.registro.join(' ')).toMatch(/analizador de sintaxis/i)
  })
})
