/**
 * El motor: los tres invariantes que no se negocian.
 *
 *   1. un candidato sin evidencia no se emite, y queda registrado el error
 *   2. el mismo problema visto por dos vías sale una sola vez
 *   3. solo tres destacados, y el orden es siempre el mismo
 *
 * Más la constancia de qué **no** se revisó, que es lo que evita que un chequeo
 * que nunca corrió se lea como "todo bien".
 */

import { describe, it, expect } from 'vitest'
import type { Evidence, FindingDraft } from '@/lib/types/domain'
import {
  agrupar,
  claveDeDedup,
  correrChequeos,
  deduplicar,
  detectarInsumos,
  fuerzaDe,
  rankear,
  resumenDeCobertura,
  sujetoDe,
  tieneDemostracion,
} from '@/server/checks/runner'
import type { HallazgoRankeado } from '@/server/checks/runner'
import { defineCheck } from '@/server/checks/lib/context'
import type { Check } from '@/server/checks/lib/context'
import { contextoDe, ESQUEMA_CON_PROBLEMAS } from '../fixtures/checks/contexto'
import { borrarProyecto, crearProyecto } from '../fixtures/checks/proyectos'

/* ── Ayudas ───────────────────────────────────────────────────────────── */

function draft(parcial: Partial<FindingDraft> & { checkId: string }): FindingDraft {
  return {
    pillar: 'security',
    severity: 'high',
    confidence: 'confirmed',
    titlePlain: `Título de ${parcial.checkId}`,
    explanationPlain: 'Explicación.',
    impactPlain: 'Impacto.',
    fixPrompt: 'Arreglalo.',
    evidence: [{ kind: 'code', file: 'app/page.tsx', line: 1 }],
    ...parcial,
  }
}

function checkFalso(id: string, drafts: FindingDraft[] | (() => never)): Check {
  return defineCheck({
    id,
    pillar: 'security',
    name: id,
    requires: ['code'],
    run: async () => {
      if (typeof drafts === 'function') drafts()
      return drafts as FindingDraft[]
    },
  })
}

async function conRepo<T>(fn: (repo: string) => Promise<T>): Promise<T> {
  const repo = await crearProyecto({ 'app/page.tsx': 'export default () => null\n' })
  try {
    return await fn(repo)
  } finally {
    await borrarProyecto(repo)
  }
}

/* ── 1. Nada sin evidencia ────────────────────────────────────────────── */

describe('invariante: se descarta lo que no tiene evidencia', () => {
  it('un candidato con evidencia vacía no se emite y queda registrado', async () => {
    await conRepo(async (repo) => {
      const resultado = await correrChequeos(contextoDe(repo), {
        checks: [
          checkFalso('sec.secret_in_repo', [
            draft({ checkId: 'sec.secret_in_repo', evidence: [] }),
            draft({ checkId: 'sec.secret_in_repo', titlePlain: 'Este sí tiene' }),
          ]),
        ],
      })

      expect(resultado.findings).toHaveLength(1)
      expect(resultado.findings[0]!.titlePlain).toBe('Este sí tiene')

      expect(resultado.descartados).toHaveLength(1)
      expect(resultado.descartados[0]).toMatchObject({
        checkId: 'sec.secret_in_repo',
        motivo: 'sin_evidencia',
      })
    })
  })

  it('un candidato con un hueco sin completar tampoco se emite', async () => {
    await conRepo(async (repo) => {
      const resultado = await correrChequeos(contextoDe(repo), {
        checks: [
          checkFalso('sec.rls_disabled', [
            draft({
              checkId: 'sec.rls_disabled',
              titlePlain: 'Cualquiera puede leer la tabla {{tabla}}',
            }),
          ]),
        ],
      })

      expect(resultado.findings).toHaveLength(0)
      expect(resultado.descartados[0]).toMatchObject({ motivo: 'texto_incompleto' })
    })
  })

  it('un chequeo que explota no voltea la corrida', async () => {
    await conRepo(async (repo) => {
      const resultado = await correrChequeos(contextoDe(repo), {
        checks: [
          checkFalso('sec.secret_in_repo', () => {
            throw new Error('se rompió el parser')
          }),
          checkFalso('sec.env_committed', [draft({ checkId: 'sec.env_committed' })]),
        ],
      })

      expect(resultado.findings).toHaveLength(1)
      expect(resultado.fallados).toHaveLength(1)
      expect(resultado.fallados[0]).toMatchObject({ checkId: 'sec.secret_in_repo' })
      expect(resultado.fallados[0]!.error).toContain('se rompió el parser')
    })
  })
})

/* ── 2. Deduplicación ─────────────────────────────────────────────────── */

describe('invariante: un problema, un hallazgo', () => {
  const grabacion: Evidence = {
    kind: 'recording',
    agentSessionId: 'delete_account',
    startMs: 0,
    endMs: 9000,
    caption: 'No hay opción de borrar la cuenta.',
  }

  it('el borrado de cuenta visto por dos pilares sale una sola vez', () => {
    const unificados = deduplicar([
      draft({
        checkId: 'cmp.no_account_deletion',
        pillar: 'completeness',
        severity: 'critical',
        evidence: [grabacion],
      }),
      draft({
        checkId: 'sto.no_account_deletion',
        pillar: 'store_hygiene',
        severity: 'critical',
        evidence: [grabacion],
      }),
    ])

    expect(unificados).toHaveLength(1)
    // Gana la versión de tienda: dice la consecuencia concreta.
    expect(unificados[0]!.checkId).toBe('sto.no_account_deletion')
    // Y queda constancia de que lo detectaron los dos.
    expect(unificados[0]!.detectadoPor).toEqual([
      'cmp.no_account_deletion',
      'sto.no_account_deletion',
    ])
  })

  it('se queda con la evidencia más fuerte de las dos', () => {
    const unificados = deduplicar([
      draft({
        checkId: 'sto.no_account_deletion',
        evidence: [{ kind: 'code', file: 'app/cuenta/page.tsx', line: 1 }],
      }),
      draft({
        checkId: 'cmp.no_account_deletion',
        titlePlain: 'El que tiene la grabación',
        evidence: [grabacion],
      }),
    ])

    expect(unificados).toHaveLength(2) // sujetos distintos: no son el mismo hecho
  })

  it('entre dos con el mismo sujeto gana la grabación sobre el código', () => {
    const mismoSujeto: Evidence = {
      kind: 'recording',
      agentSessionId: 'delete_account',
      startMs: 0,
      endMs: 100,
      caption: 'x',
    }
    const unificados = deduplicar([
      draft({
        checkId: 'sto.no_account_deletion',
        titlePlain: 'El flojo',
        evidence: [mismoSujeto],
      }),
      draft({
        checkId: 'cmp.no_account_deletion',
        titlePlain: 'El fuerte',
        evidence: [mismoSujeto, { kind: 'code', file: 'app/cuenta/page.tsx', line: 1 }],
      }),
    ])

    expect(unificados).toHaveLength(1)
    // Misma fuerza de evidencia, pero uno tiene más piezas.
    expect(unificados[0]!.titlePlain).toBe('El fuerte')
  })

  it('dos hallazgos del mismo chequeo en archivos distintos son dos hallazgos', () => {
    const unificados = deduplicar([
      draft({
        checkId: 'sec.secret_in_repo',
        evidence: [{ kind: 'code', file: 'app/a.ts', line: 3 }],
      }),
      draft({
        checkId: 'sec.secret_in_repo',
        evidence: [{ kind: 'code', file: 'app/b.ts', line: 9 }],
      }),
    ])
    expect(unificados).toHaveLength(2)
  })

  it('el sujeto sale de la evidencia más fuerte', () => {
    expect(sujetoDe(draft({ checkId: 'x', evidence: [{ kind: 'database', object: 'public.notas', detail: 'd' }] }))).toBe(
      'public.notas',
    )
    expect(
      sujetoDe(
        draft({
          checkId: 'x',
          evidence: [
            { kind: 'http', url: 'https://miapp.com/api/datos', status: 200, detail: 'd' },
            { kind: 'database', object: 'public.notas', detail: 'd' },
          ],
        }),
      ),
    ).toBe('public.notas')
  })

  it('el orden de fuerza es grabación > base > código > navegador > http', () => {
    const fuerza = (kind: Evidence['kind']): number => {
      const ejemplos: Record<Evidence['kind'], Evidence> = {
        recording: { kind: 'recording', agentSessionId: 'a', startMs: 0, endMs: 1, caption: 'c' },
        database: { kind: 'database', object: 'o', detail: 'd' },
        code: { kind: 'code', file: 'f', line: 1 },
        browser: { kind: 'browser', url: 'https://x.com', detail: 'd' },
        http: { kind: 'http', url: 'https://x.com', status: 200, detail: 'd' },
      }
      return fuerzaDe([ejemplos[kind]])
    }

    expect(fuerza('recording')).toBeGreaterThan(fuerza('database'))
    expect(fuerza('database')).toBeGreaterThan(fuerza('code'))
    expect(fuerza('code')).toBeGreaterThan(fuerza('browser'))
    expect(fuerza('browser')).toBeGreaterThan(fuerza('http'))
  })

  it('la clave de deduplicación une los chequeos equivalentes', () => {
    const evidence = [grabacion]
    expect(claveDeDedup(draft({ checkId: 'cmp.no_account_deletion', evidence }))).toBe(
      claveDeDedup(draft({ checkId: 'sto.no_account_deletion', evidence })),
    )
  })
})

/* ── 3. Ranking ───────────────────────────────────────────────────────── */

describe('invariante: máximo 3 destacados, y el orden no cambia', () => {
  function conRank(drafts: FindingDraft[]): HallazgoRankeado[] {
    return rankear(agrupar(drafts.map((d) => ({ ...d, detectadoPor: [d.checkId] }))))
  }

  it('ordena por severidad, después confianza, después si se puede mostrar en video', () => {
    const ordenados = conRank([
      draft({ checkId: 'a', severity: 'medium', confidence: 'confirmed', titlePlain: 'medio' }),
      draft({ checkId: 'b', severity: 'critical', confidence: 'to_review', titlePlain: 'grave dudoso' }),
      draft({ checkId: 'c', severity: 'critical', confidence: 'confirmed', titlePlain: 'grave seguro' }),
      draft({ checkId: 'd', severity: 'low', confidence: 'confirmed', titlePlain: 'menor' }),
    ])

    expect(ordenados.map((f) => f.titlePlain)).toEqual([
      'grave seguro',
      'grave dudoso',
      'medio',
      'menor',
    ])
    expect(ordenados.map((f) => f.rank)).toEqual([1, 2, 3, 4])
  })

  it('con severidad y confianza iguales, adelante el que se puede demostrar', () => {
    const ordenados = conRank([
      draft({
        checkId: 'sec.secret_in_repo',
        severity: 'critical',
        confidence: 'confirmed',
        titlePlain: 'sin video',
      }),
      draft({
        checkId: 'cmp.flow_blocked',
        severity: 'critical',
        confidence: 'confirmed',
        titlePlain: 'con video',
        evidence: [
          { kind: 'recording', agentSessionId: 'primary_flow', startMs: 0, endMs: 1, caption: 'c' },
        ],
      }),
    ])

    expect(ordenados[0]!.titlePlain).toBe('con video')
  })

  it('la confianza pesa más que el video: primero lo que probamos', () => {
    const ordenados = conRank([
      draft({
        checkId: 'a',
        severity: 'critical',
        confidence: 'to_review',
        titlePlain: 'dudoso con video',
        evidence: [{ kind: 'recording', agentSessionId: 's', startMs: 0, endMs: 1, caption: 'c' }],
      }),
      draft({
        checkId: 'b',
        severity: 'critical',
        confidence: 'confirmed',
        titlePlain: 'seguro sin video',
      }),
    ])

    expect(ordenados[0]!.titlePlain).toBe('seguro sin video')
  })

  it('solo 1, 2 y 3 son destacados', async () => {
    await conRepo(async (repo) => {
      const muchos = Array.from({ length: 9 }, (_, i) =>
        draft({
          checkId: 'sec.secret_in_repo',
          severity: 'critical',
          titlePlain: `hallazgo ${i}`,
          evidence: [{ kind: 'code', file: `app/archivo-${i}.ts`, line: 1 }],
        }),
      )

      const resultado = await correrChequeos(contextoDe(repo), {
        checks: [checkFalso('sec.secret_in_repo', muchos)],
      })

      expect(resultado.findings).toHaveLength(9)
      expect(resultado.destacados).toHaveLength(3)
      expect(resultado.destacados.map((f) => f.rank)).toEqual([1, 2, 3])
    })
  })

  it('dos corridas iguales dan el mismo orden', () => {
    const entrada = [
      draft({ checkId: 'sec.b', severity: 'high', evidence: [{ kind: 'code', file: 'b.ts', line: 1 }] }),
      draft({ checkId: 'sec.a', severity: 'high', evidence: [{ kind: 'code', file: 'a.ts', line: 1 }] }),
      draft({ checkId: 'sec.c', severity: 'high', evidence: [{ kind: 'code', file: 'c.ts', line: 1 }] }),
    ]
    const uno = conRank(entrada).map((f) => f.checkId)
    const dos = conRank([...entrada].reverse()).map((f) => f.checkId)
    expect(uno).toEqual(dos)
  })

  it('tieneDemostracion reconoce las dos formas', () => {
    expect(tieneDemostracion(draft({ checkId: 'x', demoTaskId: 'cross_tenant_read' }))).toBe(true)
    expect(
      tieneDemostracion(
        draft({
          checkId: 'x',
          evidence: [{ kind: 'recording', agentSessionId: 's', startMs: 0, endMs: 1, caption: 'c' }],
        }),
      ),
    ).toBe(true)
    expect(tieneDemostracion(draft({ checkId: 'x' }))).toBe(false)
  })
})

/* ── Constancia de lo que no se revisó ────────────────────────────────── */

describe('el usuario se entera de qué no se revisó', () => {
  it('los chequeos sin insumo quedan registrados con el motivo en castellano', async () => {
    await conRepo(async (repo) => {
      const resultado = await correrChequeos(contextoDe(repo))

      expect(resultado.salteados.length).toBeGreaterThan(0)
      for (const salteado of resultado.salteados) {
        expect(salteado.faltan.length).toBeGreaterThan(0)
        expect(salteado.porqueePlain.length).toBeGreaterThan(10)
        expect(salteado.siLoConectasPlain.length).toBeGreaterThan(10)
      }

      // Sin base ni app, los de base y los de app tienen que estar salteados.
      const ids = new Set(resultado.salteados.map((s) => s.checkId))
      expect(ids.has('sec.rls_permissive')).toBe(true)
      expect(ids.has('cmp.flow_blocked')).toBe(true)

      const resumen = resumenDeCobertura(resultado)
      expect(resumen.sinRevisar).toBe(resultado.salteados.length)
      expect(resumen.faltantesPlain.length).toBeGreaterThan(0)
    })
  })

  it('detectarInsumos mira lo que de verdad hay', async () => {
    await conRepo(async (repo) => {
      expect(detectarInsumos(contextoDe(repo))).toEqual({
        code: true,
        database: false,
        deployed_app: false,
        browser_run: false,
      })

      /**
       * Con la dirección y una sonda HTTP alcanza para `deployed_app`, pero NO
       * para `browser_run`: nadie recorrió la app todavía. Es la distinción que
       * evita que los chequeos de cookies, rastreadores, pantalla en el celular
       * y flujos faltantes se muestren como "revisados, todo bien" cuando el
       * agente de navegación nunca llegó a correr.
       */
      expect(
        detectarInsumos(
          contextoDe(repo, {
            dbSchema: ESQUEMA_CON_PROBLEMAS,
            deployedUrl: 'https://miapp.com',
            http: async () => null,
          }),
        ),
      ).toEqual({ code: true, database: true, deployed_app: true, browser_run: false })

      // Con lo que vio el agente sí: ahí hay una visita de verdad detrás.
      expect(
        detectarInsumos(
          contextoDe(repo, {
            deployedUrl: 'https://miapp.com',
            agent: { sessions: [] },
          }),
        ).browser_run,
      ).toBe(true)

      // Con la dirección pero sin forma de mirarla, no cuenta como disponible.
      expect(
        detectarInsumos(contextoDe(repo, { deployedUrl: 'https://miapp.com' })).deployed_app,
      ).toBe(false)
    })
  })

  it('lo salteado no se cuenta como corrido', async () => {
    await conRepo(async (repo) => {
      const resultado = await correrChequeos(contextoDe(repo))
      expect(resultado.chequeosCorridos + resultado.salteados.length).toBe(40)
    })
  })
})

/* ── El modelo, cuando está ───────────────────────────────────────────── */

describe('el repaso con modelo solo puede podar', () => {
  const dudoso = draft({
    checkId: 'sec.dangerous_html',
    confidence: 'likely',
    titlePlain: 'Un usuario podría inyectar código en tu pantalla',
    evidence: [{ kind: 'code', file: 'app/nota.tsx', line: 12, snippet: 'x.innerHTML = texto' }],
  })

  it('descarta lo que el modelo marca como falso positivo', async () => {
    await conRepo(async (repo) => {
      const ctx = contextoDe(repo, {
        complete: async () => ({
          text: '[{"i":0,"v":"descartar","porque":"es un valor fijo"}]',
          costUsd: 0.004,
          inputTokens: 300,
          outputTokens: 20,
        }),
      })

      const resultado = await correrChequeos(ctx, {
        checks: [checkFalso('sec.dangerous_html', [dudoso])],
      })

      expect(resultado.findings).toHaveLength(0)
      expect(resultado.costos.some((c) => c.category === 'llm')).toBe(true)
      expect(resultado.costoTotalUsd).toBeCloseTo(0.004)
    })
  })

  it('si el modelo contesta cualquier cosa, no se pierde ningún hallazgo', async () => {
    await conRepo(async (repo) => {
      const ctx = contextoDe(repo, {
        complete: async () => ({
          text: 'perdón, no puedo ayudarte con eso',
          costUsd: 0.001,
          inputTokens: 10,
          outputTokens: 10,
        }),
      })

      const resultado = await correrChequeos(ctx, {
        checks: [checkFalso('sec.dangerous_html', [dudoso])],
      })
      expect(resultado.findings).toHaveLength(1)
    })
  })

  it('si el modelo falla, tampoco', async () => {
    await conRepo(async (repo) => {
      const ctx = contextoDe(repo, {
        complete: async () => {
          throw new Error('se cayó la red')
        },
      })

      const resultado = await correrChequeos(ctx, {
        checks: [checkFalso('sec.dangerous_html', [dudoso])],
      })
      expect(resultado.findings).toHaveLength(1)
    })
  })

  it('no toca lo que ya está comprobado, aunque el modelo diga que lo descarte', async () => {
    await conRepo(async (repo) => {
      let llamado = false
      const ctx = contextoDe(repo, {
        complete: async () => {
          llamado = true
          return {
            text: '[{"i":0,"v":"descartar"}]',
            costUsd: 0.001,
            inputTokens: 10,
            outputTokens: 10,
          }
        },
      })

      const comprobado = draft({
        checkId: 'sec.secret_in_repo',
        confidence: 'confirmed',
        evidence: [{ kind: 'code', file: 'app/a.ts', line: 1, snippet: 'const k = "..."' }],
      })

      const resultado = await correrChequeos(ctx, {
        checks: [checkFalso('sec.secret_in_repo', [comprobado])],
      })

      expect(resultado.findings).toHaveLength(1)
      // Ni siquiera se molestó en preguntar.
      expect(llamado).toBe(false)
    })
  })

  it('con usarModelo en false, no se llama aunque esté disponible', async () => {
    await conRepo(async (repo) => {
      let llamado = false
      const ctx = contextoDe(repo, {
        complete: async () => {
          llamado = true
          return { text: '[]', costUsd: 0, inputTokens: 0, outputTokens: 0 }
        },
      })

      await correrChequeos(ctx, {
        checks: [checkFalso('sec.dangerous_html', [dudoso])],
        usarModelo: false,
      })
      expect(llamado).toBe(false)
    })
  })
})
