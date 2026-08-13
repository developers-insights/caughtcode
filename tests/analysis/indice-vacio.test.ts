/**
 * Un índice sin archivos no es un resultado: es una falla.
 *
 * Regresión de un fallo real de producción. `ingest_repo` deja el código en
 * disco y le pasa la ruta a `index_code`, pero cada trabajo corre en su propia
 * invocación y esa carpeta vive en `/tmp`, que no sobrevive. Cuando el análisis
 * arrancaba, el código ya no estaba — y nada fallaba: `walkFiles()` ignora la
 * carpeta que no puede leer, el índice se guardaba con `fileCount: 0`,
 * `run_checks` se salteaba todos los chequeos de código por "insumo faltante" y
 * la corrida terminaba **succeeded con cero hallazgos**. La corrida `c282c46b`
 * de `alianzas-sabias` figura exitosa y en blanco sobre un repositorio que, en
 * local, da 180 hallazgos.
 *
 * Lo que se prueba:
 *
 *  1. **Con la carpeta perdida, `index_code` la rehidrata** desde la copia
 *     guardada y analiza el código de verdad.
 *  2. **Si aun así no hay archivos, falla** en vez de escribir el índice vacío y
 *     encadenar la revisión.
 *  3. **`run_checks` con un índice de cero archivos no dice "revisado".**
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { T } from '@/lib/db/tablas'
import type { CodeIndex, StackInfo } from '@/lib/types/domain'
import { crearHandlerIndexCode } from '@/server/analysis/handlers'
import { crearHandlerRunChecks } from '@/server/checks/handlers'
import type { AlmacenRepos } from '@/server/ingest/rehidratar'
import { setJobsDb } from '@/server/jobs/db'

import { almacenEnMemoria, contextoDeTrabajo, DbFalsa } from '../fixtures/checks/db-falsa'
import { codigoYaEnDisco } from '../fixtures/codigo'
import { zipLimpio } from '../fixtures/zips'

/* ── Ayudas ───────────────────────────────────────────────────────────── */

const COPIA = 'org-1/proyecto-1/corridas/corrida-1/codigo.zip'

const STACK: StackInfo = {
  framework: 'nextjs',
  language: 'typescript',
  packageManager: 'pnpm',
  backends: [],
  hasTypescript: true,
  hasTailwind: false,
  routerKind: 'app',
  evidence: [],
}

function indiceVacio(): CodeIndex {
  return {
    fileCount: 0,
    totalBytes: 0,
    languages: {},
    routes: [],
    symbols: [],
    edges: [],
    rankedFiles: [],
    dbSchema: { source: 'none', tables: [], buckets: [], functions: [] },
    truncated: false,
    notes: ['No encontramos archivos de código para analizar.'],
  }
}

function baseLista(storagePath: string | null = COPIA): DbFalsa {
  const db = new DbFalsa()
  db.sembrar(T.projects, [
    { id: 'proyecto-1', org_id: 'org-1', storage_path: storagePath, stack_detected: null },
  ])
  db.sembrar(T.codeIndex, [])
  db.sembrar(T.findings, [])
  db.sembrar(T.jobs, [])
  return db
}

function almacenCon(zip: Uint8Array): AlmacenRepos & { descargas: string[] } {
  const descargas: string[] = []
  return {
    descargas,
    async descargar(_bucket, ruta) {
      descargas.push(ruta)
      return zip
    },
    async subir() {},
  }
}

let raiz: string
let anterior: string | undefined

beforeEach(async () => {
  raiz = await mkdtemp(path.join(tmpdir(), 'caughtcode-indice-vacio-'))
  anterior = process.env.CAUGHTCODE_STORAGE_DIR
  process.env.CAUGHTCODE_STORAGE_DIR = raiz
  setJobsDb(null)
})

afterEach(async () => {
  setJobsDb(null)
  if (anterior === undefined) delete process.env.CAUGHTCODE_STORAGE_DIR
  else process.env.CAUGHTCODE_STORAGE_DIR = anterior
  await rm(raiz, { recursive: true, force: true })
})

/* ── 1. La carpeta perdida se recupera ────────────────────────────────── */

describe('index_code cuando la carpeta del código ya no está', () => {
  it('la trae de nuevo de la copia guardada y analiza el código de verdad', async () => {
    const db = baseLista()
    setJobsDb(db)
    const almacen = almacenCon(zipLimpio())
    const ctx = contextoDeTrabajo()

    // La ruta que trae el payload apunta a una carpeta que ya no existe: es
    // exactamente lo que pasa en producción entre un trabajo y el siguiente.
    const perdida = path.join(raiz, 'invocacion-anterior', 'code')

    const handler = crearHandlerIndexCode({
      db: async () => db,
      store: almacenEnMemoria().store,
      // Con el helper de verdad: lo que se prueba es que rehidrata solo.
      asegurar: async (opciones) => {
        const { asegurarCodigoEnDisco } = await import('@/server/ingest/rehidratar')
        return asegurarCodigoEnDisco({ ...opciones, almacen, db: async () => db })
      },
    })

    await handler({ repoPath: perdida }, ctx)

    expect(almacen.descargas).toEqual([COPIA])

    const filas = db.filasDe(T.codeIndex) as Array<Record<string, any>>
    expect(filas).toHaveLength(1)
    expect(filas[0].stats.fileCount, 'guardó un mapa vacío').toBeGreaterThan(0)

    // Y la cadena siguió con normalidad.
    expect((db.filasDe(T.jobs) as Array<Record<string, any>>).map((j) => j.kind)).toEqual([
      'run_checks',
    ])
  })

  it('si no hay carpeta ni copia, no escribe nada y lo dice sin jerga', async () => {
    const db = baseLista(null)
    setJobsDb(db)

    const handler = crearHandlerIndexCode({
      db: async () => db,
      store: almacenEnMemoria().store,
      asegurar: async (opciones) => {
        const { asegurarCodigoEnDisco } = await import('@/server/ingest/rehidratar')
        return asegurarCodigoEnDisco({
          ...opciones,
          almacen: almacenCon(zipLimpio()),
          db: async () => db,
        })
      },
    })

    await expect(
      handler({ repoPath: path.join(raiz, 'nunca-existio') }, contextoDeTrabajo()),
    ).rejects.toMatchObject({ retryable: false })

    expect(db.filasDe(T.codeIndex)).toHaveLength(0)
    expect(db.filasDe(T.jobs)).toHaveLength(0)
  })
})

/* ── 2. El índice vacío nunca se guarda ───────────────────────────────── */

describe('index_code no guarda un mapa sin archivos', () => {
  it('falla en vez de escribir el índice vacío y encadenar la revisión', async () => {
    const db = baseLista()
    setJobsDb(db)

    const handler = crearHandlerIndexCode({
      db: async () => db,
      store: almacenEnMemoria().store,
      asegurar: codigoYaEnDisco(),
      build: async () => ({ index: indiceVacio(), stack: STACK, stages: {} }),
    })

    let capturado: unknown
    try {
      await handler({ repoPath: path.join(raiz, 'code') }, contextoDeTrabajo())
    } catch (error) {
      capturado = error
    }

    expect(capturado, 'el índice vacío pasó como si nada').toBeDefined()
    // Sin reintento: si la copia no se hubiera podido bajar, `asegurarCodigoEnDisco`
    // habría tirado antes. Llegar acá significa que el árbol está de verdad vacío
    // o que los filtros se lo llevaron entero, y eso no lo arregla insistir tres
    // veces con backoff. El texto tiene que decir qué hacer, no "esperá un rato".
    expect(capturado).toMatchObject({ retryable: false, code: 'indice_vacio' })
    expect((capturado as Error).message).not.toMatch(/index|walk|fileCount|storage/i)
    expect((capturado as Error).message).not.toMatch(/momentáneo|en un ratito/i)
    expect((capturado as Error).message).toMatch(/volvé a lanzar la revisión/i)

    // Lo que de verdad importa: no quedó ni el mapa vacío ni la revisión en cola.
    expect(db.filasDe(T.codeIndex), 'guardó un mapa vacío').toHaveLength(0)
    expect(db.filasDe(T.jobs), 'encadenó una revisión sobre la nada').toHaveLength(0)
  })

  /**
   * El caso legítimo que no se puede romper: un proyecto que tiene archivos pero
   * ninguno es código (puro HTML, configuración, contenido). `fileCount` cuenta
   * todo lo que sobrevivió a los filtros, así que da mayor a cero y la corrida
   * sigue: el motor deja la nota y la revisión hace lo que puede.
   */
  it('un proyecto con archivos pero sin código sigue de largo, con su nota', async () => {
    const db = baseLista()
    setJobsDb(db)
    const ctx = contextoDeTrabajo()

    const handler = crearHandlerIndexCode({
      db: async () => db,
      store: almacenEnMemoria().store,
      asegurar: codigoYaEnDisco(),
      build: async () => ({
        index: {
          ...indiceVacio(),
          fileCount: 4,
          totalBytes: 900,
          notes: ['No encontramos archivos de código para leer.'],
        },
        stack: STACK,
        stages: {},
      }),
    })

    await handler({ repoPath: path.join(raiz, 'code') }, ctx)

    expect(db.filasDe(T.codeIndex)).toHaveLength(1)
    expect(ctx.registro.join(' ')).toMatch(/archivos de código/i)
  })
})

/* ── 3. run_checks tampoco lo deja pasar ──────────────────────────────── */

describe('run_checks con un mapa de cero archivos', () => {
  it('falla en vez de terminar "revisado" sin haber revisado nada', async () => {
    const db = new DbFalsa()
    db.sembrar(T.codeIndex, [
      {
        analysis_run_id: 'corrida-1',
        symbol_graph: { symbols: [], edges: [] },
        routes: [],
        ranked_files: [],
        db_schema: { source: 'none', tables: [], buckets: [], functions: [] },
        // Lo que quedó guardado en producción, tal cual.
        stats: {
          fileCount: 0,
          totalBytes: 0,
          languages: {},
          truncated: false,
          notes: ['No encontramos archivos de código para analizar.'],
        },
      },
    ])
    db.sembrar(T.projects, [{ id: 'proyecto-1', stack_detected: null }])
    db.sembrar(T.findings, [])
    db.sembrar(T.analysisRuns, [{ id: 'corrida-1', project_id: 'proyecto-1' }])

    const handler = crearHandlerRunChecks({
      db: async () => db,
      store: almacenEnMemoria().store,
      asegurar: codigoYaEnDisco(),
    })

    let capturado: unknown
    try {
      await handler({ repoPath: path.join(raiz, 'code') }, contextoDeTrabajo())
    } catch (error) {
      capturado = error
    }

    expect(capturado, 'terminó bien con un informe en blanco').toBeDefined()
    // El mapa vacío ya está escrito: releerlo daría lo mismo. Lo que destraba
    // esto es volver a lanzar la revisión.
    expect(capturado).toMatchObject({ retryable: false, code: 'indice_vacio' })
    expect((capturado as Error).message).toMatch(/volvé a lanzar la revisión/i)

    expect(db.filasDe(T.findings)).toHaveLength(0)
    // Y no quedó registrada una cobertura que diga que se revisó algo.
    expect((db.filasDe(T.analysisRuns)[0] as Record<string, unknown>).coverage).toBeUndefined()
  })
})
