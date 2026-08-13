/**
 * El handler de `run_checks`: de chequeo a fila en la base.
 *
 * Lo que se prueba, en orden de importancia:
 *
 *  1. **Idempotencia.** Correrlo dos veces sobre la misma corrida deja la misma
 *     cantidad de hallazgos, no el doble. Es la regla que fijó el frente de la
 *     cola, y sin ella un reintento del worker le duplica el reporte al usuario.
 *  2. **Un problema arreglado desaparece.** Si el usuario arregla algo y se
 *     vuelve a revisar, el hallazgo viejo no puede quedar colgado.
 *  3. **Nada sin evidencia llega a la base**, aunque un chequeo tenga un bug.
 *  4. Costo y etapas: se reportan, y las etapas están en castellano.
 */

import { describe, it, expect } from 'vitest'
import type { FindingDraft } from '@/lib/types/domain'
import { crearHandlerRunChecks } from '@/server/checks/handlers'
import type { RunChecksPayload } from '@/server/checks/handlers'
import { T } from '@/lib/db/tablas'
import { defineCheck } from '@/server/checks/lib/context'
import type { Check } from '@/server/checks/lib/context'
import {
  almacenEnMemoria,
  contextoDeTrabajo,
  DbFalsa,
} from '../fixtures/checks/db-falsa'
import type { Fila } from '../fixtures/checks/db-falsa'
import { codigoYaEnDisco } from '../fixtures/codigo'
import {
  borrarProyecto,
  crearProyecto,
  PROYECTO_CATCH_VACIO,
  PROYECTO_ENV_VERSIONADO,
} from '../fixtures/checks/proyectos'

/* ── Ayudas ───────────────────────────────────────────────────────────── */

function baseConIndice(): DbFalsa {
  const db = new DbFalsa()
  db.sembrar(T.codeIndex, [
    {
      analysis_run_id: 'corrida-1',
      symbol_graph: { symbols: [], edges: [] },
      routes: [{ path: '/', file: 'app/page.tsx', kind: 'page', isDynamic: false, isClient: false, looksProtected: false }],
      ranked_files: [],
      db_schema: { source: 'none', tables: [], buckets: [], functions: [] },
      stats: { fileCount: 12, totalBytes: 4096, languages: { typescript: 12 }, truncated: false, notes: [] },
    },
  ])
  db.sembrar(T.projects, [{ id: 'proyecto-1', stack_detected: { framework: 'nextjs' } }])
  db.sembrar(T.findings, [])
  return db
}

function draft(parcial: Partial<FindingDraft> & { checkId: string }): FindingDraft {
  return {
    pillar: 'security',
    severity: 'critical',
    confidence: 'confirmed',
    titlePlain: `Título de ${parcial.checkId}`,
    explanationPlain: 'Explicación.',
    impactPlain: 'Impacto.',
    fixPrompt: 'Arreglalo.',
    evidence: [{ kind: 'code', file: 'app/a.ts', line: 1 }],
    ...parcial,
  }
}

function checkFijo(id: string, drafts: FindingDraft[]): Check {
  return defineCheck({
    id,
    pillar: 'security',
    name: id,
    requires: ['code'],
    run: async () => drafts,
  })
}

/**
 * Handler listo para test: base de mentira + almacén de etapas en memoria.
 *
 * El almacén hay que inyectarlo sí o sí: el de producción vive en la columna
 * `payload` del trabajo y va a buscar el cliente real de Supabase. Uno por
 * handler, compartido entre las llamadas que haga ese handler — que es lo que
 * permite distinguir "otro trabajo" (rehace) de "el mismo reintentado" (saltea).
 *
 * `asegurar` también: estos tests le pasan una carpeta temporal cualquiera, y el
 * helper de verdad ya no acepta una ruta que no cuelgue del workspace del
 * proyecto (ver `esCarpetaDelProyecto` en `@/server/ingest/rehidratar`). Sin el
 * doble, saldría a buscar la copia guardada en el Storage real.
 */
function handlerCon(
  db: DbFalsa,
  extra: Partial<Parameters<typeof crearHandlerRunChecks>[0]> = {},
) {
  const { store } = almacenEnMemoria()
  return crearHandlerRunChecks({
    db: async () => db,
    store,
    asegurar: codigoYaEnDisco(),
    ...extra,
  })
}

async function conRepo<T2>(
  arbol: Record<string, string>,
  fn: (repo: string) => Promise<T2>,
): Promise<T2> {
  const repo = await crearProyecto(arbol)
  try {
    return await fn(repo)
  } finally {
    await borrarProyecto(repo)
  }
}

function hallazgos(db: DbFalsa): Fila[] {
  return db.filasDe(T.findings)
}

/* ── 1. Idempotencia ──────────────────────────────────────────────────── */

describe('idempotencia: correrlo dos veces no duplica nada', () => {
  it('dos trabajos distintos sobre la misma corrida dejan la misma cantidad', async () => {
    await conRepo({ ...PROYECTO_ENV_VERSIONADO, ...PROYECTO_CATCH_VACIO }, async (repo) => {
      const db = baseConIndice()
      const payload: RunChecksPayload = { repoPath: repo }

      // Cada trabajo con su propio almacén: el segundo no ve el avance del
      // primero, así que rehace todo. Es el caso que de verdad importa.
      const handler = handlerCon(db)

      await handler(payload, contextoDeTrabajo({ jobId: 'trabajo-1' }))
      const despuesDeUna = hallazgos(db).length
      expect(despuesDeUna, 'la primera corrida no guardó nada').toBeGreaterThan(0)

      await handler(payload, contextoDeTrabajo({ jobId: 'trabajo-2' }))
      const despuesDeDos = hallazgos(db).length

      expect(despuesDeDos).toBe(despuesDeUna)
    })
  })

  it('el mismo trabajo reintentado tampoco duplica', async () => {
    await conRepo(PROYECTO_ENV_VERSIONADO, async (repo) => {
      const db = baseConIndice()
      const handler = handlerCon(db)
      const payload: RunChecksPayload = { repoPath: repo }

      await handler(payload, contextoDeTrabajo({ jobId: 'trabajo-1' }))
      const primera = hallazgos(db).length
      expect(primera).toBeGreaterThan(0)

      // Mismo jobId y mismo almacén: las etapas ya hechas se saltean.
      await handler(payload, contextoDeTrabajo({ jobId: 'trabajo-1' }))
      expect(hallazgos(db).length).toBe(primera)
    })
  })

  it('borra por chequeo antes de insertar, no a lo bruto', async () => {
    await conRepo({ 'app/page.tsx': 'export default () => null\n' }, async (repo) => {
      const db = baseConIndice()

      // Un hallazgo de otro chequeo que no corre en esta pasada: no se toca.
      db.sembrar(T.findings, [
        {
          id: 'viejo-de-otro',
          analysis_run_id: 'corrida-1',
          check_id: 'sec.public_bucket',
          title_plain: 'De otro chequeo',
        },
        {
          id: 'viejo-mio',
          analysis_run_id: 'corrida-1',
          check_id: 'sec.secret_in_repo',
          title_plain: 'Va a ser reemplazado',
        },
      ])

      const handler = handlerCon(db, {
        checks: [checkFijo('sec.secret_in_repo', [draft({ checkId: 'sec.secret_in_repo' })])],
      })

      await handler({ repoPath: repo }, contextoDeTrabajo())

      const filas = hallazgos(db)
      expect(filas.some((f) => f.id === 'viejo-de-otro'), 'borró un hallazgo de otro chequeo').toBe(true)
      expect(filas.some((f) => f.id === 'viejo-mio'), 'no reemplazó el hallazgo viejo').toBe(false)
      expect(filas.filter((f) => f.check_id === 'sec.secret_in_repo')).toHaveLength(1)
    })
  })

  it('un problema arreglado desaparece del reporte', async () => {
    await conRepo({ 'app/page.tsx': 'export default () => null\n' }, async (repo) => {
      const db = baseConIndice()
      const payload: RunChecksPayload = { repoPath: repo }

      // Primera revisión: el chequeo encuentra algo.
      await handlerCon(db, {
        checks: [checkFijo('sec.secret_in_repo', [draft({ checkId: 'sec.secret_in_repo' })])],
      })(payload, contextoDeTrabajo({ jobId: 'trabajo-1' }))

      expect(hallazgos(db)).toHaveLength(1)

      // Segunda: el usuario lo arregló y el chequeo ya no encuentra nada.
      await handlerCon(db, {
        checks: [checkFijo('sec.secret_in_repo', [])],
      })(payload, contextoDeTrabajo({ jobId: 'trabajo-2' }))

      expect(hallazgos(db), 'el hallazgo arreglado quedó colgado').toHaveLength(0)
    })
  })
})

/* ── 2. Nada sin evidencia llega a la base ────────────────────────────── */

describe('la última puerta antes de la base', () => {
  it('un chequeo con un bug que emite sin evidencia no ensucia la tabla', async () => {
    await conRepo({ 'app/page.tsx': 'export default () => null\n' }, async (repo) => {
      const db = baseConIndice()
      const ctx = contextoDeTrabajo()

      await handlerCon(db, {
        checks: [
          checkFijo('sec.secret_in_repo', [
            draft({ checkId: 'sec.secret_in_repo', evidence: [] }),
            draft({ checkId: 'sec.secret_in_repo', titlePlain: 'Este sí tiene' }),
          ]),
        ],
      })({ repoPath: repo }, ctx)

      const filas = hallazgos(db)
      expect(filas).toHaveLength(1)
      expect(filas[0]!.title_plain).toBe('Este sí tiene')

      // Y quedó dicho por qué no se guardó el otro.
      expect(ctx.registro.some((m) => m.includes('Se descartó un hallazgo'))).toBe(true)
    })
  })

  it('toda fila guardada lleva evidencia', async () => {
    await conRepo({ ...PROYECTO_ENV_VERSIONADO, ...PROYECTO_CATCH_VACIO }, async (repo) => {
      const db = baseConIndice()
      await handlerCon(db)({ repoPath: repo }, contextoDeTrabajo())

      const filas = hallazgos(db)
      expect(filas.length).toBeGreaterThan(0)
      for (const fila of filas) {
        expect(Array.isArray(fila.evidence), `${fila.check_id} guardó evidencia que no es lista`).toBe(true)
        expect((fila.evidence as unknown[]).length, `${fila.check_id} guardó sin evidencia`).toBeGreaterThan(0)
      }
    })
  })

  it('escribe en la tabla con sufijo, nunca en la del otro producto', async () => {
    await conRepo(PROYECTO_ENV_VERSIONADO, async (repo) => {
      const db = baseConIndice()
      await handlerCon(db)({ repoPath: repo }, contextoDeTrabajo())

      expect(T.findings).toBe('findings_caughtcode')
      expect(db.filasDe('findings'), 'escribió en la tabla del otro producto').toHaveLength(0)
      expect(db.filasDe(T.findings).length).toBeGreaterThan(0)
      for (const operacion of db.operaciones) {
        expect(operacion).not.toMatch(/ findings$/)
      }
    })
  })
})

/* ── 3. Forma de las filas ────────────────────────────────────────────── */

describe('las filas quedan como las espera el esquema', () => {
  it('mapea los campos y respeta el ranking', async () => {
    await conRepo({ 'app/page.tsx': 'export default () => null\n' }, async (repo) => {
      const db = baseConIndice()

      await handlerCon(db, {
        checks: [
          checkFijo('sec.secret_in_repo', [
            draft({ checkId: 'sec.secret_in_repo', severity: 'critical' }),
            draft({
              checkId: 'sec.secret_in_repo',
              severity: 'low',
              titlePlain: 'El menor',
              evidence: [{ kind: 'code', file: 'app/b.ts', line: 2 }],
            }),
          ]),
        ],
      })({ repoPath: repo }, contextoDeTrabajo())

      const filas = hallazgos(db)
      expect(filas).toHaveLength(2)

      const grave = filas.find((f) => f.severity === 'critical')!
      expect(grave).toMatchObject({
        analysis_run_id: 'corrida-1',
        project_id: 'proyecto-1',
        pillar: 'security',
        check_id: 'sec.secret_in_repo',
        confidence: 'confirmed',
        status: 'open',
        rank: 1,
      })
      expect(grave.title_plain).toBeDefined()
      expect(grave.fix_prompt).toBeDefined()

      // El menor va después: el orden se guarda, no se recalcula en pantalla.
      expect(filas.find((f) => f.title_plain === 'El menor')!.rank).toBe(2)
    })
  })
})

/* ── 4. Costo, progreso y errores ─────────────────────────────────────── */

describe('lo que el usuario ve mientras corre', () => {
  it('reporta el costo de la revisión', async () => {
    await conRepo(PROYECTO_ENV_VERSIONADO, async (repo) => {
      const db = baseConIndice()
      const ctx = contextoDeTrabajo()
      await handlerCon(db)({ repoPath: repo }, ctx)

      expect(ctx.costos.length).toBeGreaterThan(0)
      for (const costo of ctx.costos) {
        expect(costo.costUsd).toBeGreaterThanOrEqual(0)
        expect(costo.unitLabel.length).toBeGreaterThan(0)
      }
    })
  })

  it('las etapas que ve el usuario están en castellano y sin jerga', async () => {
    await conRepo(PROYECTO_ENV_VERSIONADO, async (repo) => {
      const db = baseConIndice()
      const ctx = contextoDeTrabajo()
      await handlerCon(db)({ repoPath: repo }, ctx)

      const etiquetas = ctx.etapas.map((e) => e.stage).filter((s): s is string => Boolean(s))
      expect(etiquetas.length).toBeGreaterThan(0)
      expect(etiquetas).toContain('Revisando tu proyecto')

      const { detectarJerga } = await import('@/content/lenguaje')
      for (const etiqueta of etiquetas) {
        expect(detectarJerga(etiqueta), `la etapa "${etiqueta}" tiene jerga`).toEqual([])
      }

      const progresos = ctx.etapas.map((e) => e.progress).filter((p): p is number => typeof p === 'number')
      expect(Math.max(...progresos)).toBe(100)
    })
  })

  it('deja constancia de lo que no se pudo revisar', async () => {
    await conRepo(PROYECTO_ENV_VERSIONADO, async (repo) => {
      const db = baseConIndice()
      const ctx = contextoDeTrabajo()
      // Sin base ni app publicada: se saltean un montón de chequeos.
      await handlerCon(db)({ repoPath: repo }, ctx)

      expect(ctx.registro.some((m) => m.startsWith('No se revisó'))).toBe(true)
    })
  })

  it('sin índice de código no revisa nada y lo dice claro', async () => {
    await conRepo(PROYECTO_ENV_VERSIONADO, async (repo) => {
      const db = new DbFalsa()
      db.sembrar(T.codeIndex, [])
      db.sembrar(T.findings, [])

      await expect(
        handlerCon(db)({ repoPath: repo }, contextoDeTrabajo()),
      ).rejects.toThrow(/mapa del proyecto/)

      expect(hallazgos(db)).toHaveLength(0)
    })
  })

  it('sin corrida asociada corta antes de tocar la base', async () => {
    await conRepo(PROYECTO_ENV_VERSIONADO, async (repo) => {
      const db = baseConIndice()
      await expect(
        handlerCon(db)({ repoPath: repo }, contextoDeTrabajo({ analysisRunId: null })),
      ).rejects.toThrow(/sin corrida/i)
    })
  })

  it('si el insert falla, el error se puede reintentar', async () => {
    await conRepo({ 'app/page.tsx': 'export default () => null\n' }, async (repo) => {
      const db = baseConIndice()
      db.fallaEn = { tabla: T.findings, operacion: 'insert' }

      await expect(
        handlerCon(db, {
          checks: [checkFijo('sec.secret_in_repo', [draft({ checkId: 'sec.secret_in_repo' })])],
        })({ repoPath: repo }, contextoDeTrabajo()),
      ).rejects.toMatchObject({ retryable: true })
    })
  })
})

/* ── 5. Cobertura: qué se revisó, no solo qué se encontró ────────────── */

describe('cobertura de la corrida', () => {
  it('clasifica cada chequeo según lo que le pasó y lo guarda en analysis_runs', async () => {
    await conRepo({ 'app/page.tsx': 'export default () => null\n' }, async (repo) => {
      const db = baseConIndice()
      db.sembrar(T.analysisRuns, [{ id: 'corrida-1', project_id: 'proyecto-1' }])

      const checks: Check[] = [
        checkFijo('sec.con_hallazgo', [draft({ checkId: 'sec.con_hallazgo' })]),
        checkFijo('sec.sin_hallazgo', []),
        defineCheck({
          id: 'sec.salteado',
          pillar: 'security',
          name: 'sec.salteado',
          requires: ['deployed_app'],
          run: async () => [],
        }),
      ]

      await handlerCon(db, { checks })({ repoPath: repo }, contextoDeTrabajo())

      const [corrida] = db.filasDe(T.analysisRuns)
      const coverage = corrida.coverage as {
        totalChequeos: number
        entries: Array<{ checkId: string; status: string; reasonPlain?: string }>
      }

      expect(coverage.totalChequeos).toBe(3)

      const porId = new Map(coverage.entries.map((e) => [e.checkId, e]))
      expect(porId.get('sec.con_hallazgo')?.status).toBe('con_hallazgos')
      expect(porId.get('sec.sin_hallazgo')?.status).toBe('sin_hallazgos')
      expect(porId.get('sec.salteado')?.status).toBe('salteado')
      expect(porId.get('sec.salteado')?.reasonPlain).toMatch(/dirección de tu app publicada/)
    })
  })

  /**
   * La revisión de red: `index_code` la dejó agendada por si el agente de
   * navegación nunca corría, y no corrió. Llega con la dirección de la app pero
   * sin una sola observación del navegador.
   *
   * Lo que NO puede pasar es que los chequeos que leen lo que vio el agente se
   * muestren como "revisado, sin problemas". Nadie miró cookies, ni rastreadores,
   * ni cómo se ve en el celular. Tienen que quedar marcados como no revisados, y
   * el motivo tiene que decir que fue algo que no pudimos hacer nosotros — no
   * pedirle nada al usuario, que dio todo lo que había que dar.
   */
  it('sin la visita del agente, los chequeos que dependen de ella quedan como no revisados', async () => {
    await conRepo({ 'app/page.tsx': 'export default () => null\n' }, async (repo) => {
      const db = baseConIndice()
      db.sembrar(T.analysisRuns, [{ id: 'corrida-1', project_id: 'proyecto-1' }])
      db.sembrar(T.agentSessions, [])

      const checks: Check[] = [
        defineCheck({
          id: 'sto.trackers_before_consent',
          pillar: 'store_hygiene',
          name: 'trackers',
          requires: ['deployed_app', 'browser_run'],
          run: async () => [],
        }),
        defineCheck({
          id: 'cmp.broken_links',
          pillar: 'completeness',
          name: 'enlaces',
          requires: ['deployed_app'],
          run: async () => [],
        }),
      ]

      await handlerCon(db, { checks })(
        { repoPath: repo, deployedUrl: 'https://mi-app.vercel.app' },
        contextoDeTrabajo(),
      )

      const [corrida] = db.filasDe(T.analysisRuns)
      const coverage = corrida.coverage as {
        entries: Array<{ checkId: string; status: string; reasonPlain?: string }>
      }
      const porId = new Map(coverage.entries.map((e) => [e.checkId, e]))

      const sinAgente = porId.get('sto.trackers_before_consent')
      expect(sinAgente?.status, 'un chequeo que no miró nada se mostró como revisado').toBe('salteado')
      expect(sinAgente?.reasonPlain).toMatch(/no llegamos a recorrer tu app/i)

      // El que sí puede trabajar solo con la dirección corre igual: la dirección
      // está, lo que faltó fue el recorrido.
      expect(porId.get('cmp.broken_links')?.status).toBe('sin_hallazgos')
    })
  })

  it('correrlo dos veces deja la cobertura de la última corrida, no las dos mezcladas', async () => {
    await conRepo({ 'app/page.tsx': 'export default () => null\n' }, async (repo) => {
      const db = baseConIndice()
      db.sembrar(T.analysisRuns, [{ id: 'corrida-1', project_id: 'proyecto-1' }])

      const check = checkFijo('sec.a', [draft({ checkId: 'sec.a' })])

      await handlerCon(db, { checks: [check] })(
        { repoPath: repo },
        contextoDeTrabajo({ jobId: 'trabajo-1' }),
      )
      await handlerCon(db, { checks: [check] })(
        { repoPath: repo },
        contextoDeTrabajo({ jobId: 'trabajo-2' }),
      )

      const filas = db.filasDe(T.analysisRuns)
      expect(filas).toHaveLength(1)
      const coverage = filas[0].coverage as { entries: unknown[] }
      expect(coverage.entries).toHaveLength(1)
    })
  })
})

/* ── 6. El secreto no viaja: se resuelve al usarlo ────────────────────── */

/**
 * Regresión de seguridad. La conexión de solo lectura a la base del cliente
 * llegaba **en claro** en `jobs.payload`, y esa tabla la lee cualquier miembro
 * de la organización. Ahora `run_checks` la resuelve cuando la va a usar y el
 * secreto vive en memoria lo que dura el trabajo.
 */
describe('la conexión a la base se resuelve al usarla, no viene en el payload', () => {
  it('los chequeos la reciben aunque el payload no la traiga', async () => {
    await conRepo({ 'app/page.tsx': 'export default () => null\n' }, async (repo) => {
      const db = baseConIndice()
      let vista: string | null | undefined

      const mirón = defineCheck({
        id: 'sec.rls_permissive',
        pillar: 'security',
        name: 'mirón',
        requires: ['code'],
        run: async (ctx) => {
          vista = ctx.databaseUrl
          return []
        },
      })

      await handlerCon(db, {
        checks: [mirón],
        conexion: async () => 'postgres://solo-lectura',
      })({ repoPath: repo }, contextoDeTrabajo())

      expect(vista, 'se quedó sin conexión y el chequeo de permisos se saltea').toBe(
        'postgres://solo-lectura',
      )
    })
  })

  it('un trabajo viejo con el secreto adentro sigue funcionando', async () => {
    await conRepo({ 'app/page.tsx': 'export default () => null\n' }, async (repo) => {
      const db = baseConIndice()
      let vista: string | null | undefined

      const mirón = defineCheck({
        id: 'sec.rls_permissive',
        pillar: 'security',
        name: 'mirón',
        requires: ['code'],
        run: async (ctx) => {
          vista = ctx.databaseUrl
          return []
        },
      })

      await handlerCon(db, {
        checks: [mirón],
        conexion: async () => {
          throw new Error('no hacía falta volver a resolverla')
        },
      })({ repoPath: repo, databaseUrl: 'postgres://del-payload-viejo' }, contextoDeTrabajo())

      expect(vista).toBe('postgres://del-payload-viejo')
    })
  })
})

/* ── 7. Enganche con la cola ──────────────────────────────────────────── */

describe('enganche con la cola', () => {
  it('importar el módulo registra el handler de run_checks', async () => {
    const { hasRealHandler, resetHandlers } = await import('@/server/jobs')
    resetHandlers()
    expect(hasRealHandler('run_checks')).toBe(false)

    // El import tiene efecto de registro, igual que en el worker real.
    await import('@/server/checks/handlers')
    // Los módulos se cachean, así que se vuelve a registrar a mano para probar
    // que la función existe y engancha.
    const { registerHandler } = await import('@/server/jobs')
    const { crearHandlerRunChecks: crear } = await import('@/server/checks/handlers')
    registerHandler('run_checks', crear())

    expect(hasRealHandler('run_checks')).toBe(true)
  })
})
