import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { setJobsDb } from '@/server/jobs/db'
import { buildBreakdown, estimate, mergeEntries, recordCost, runCost } from '@/server/cost/ledger'
import {
  formatUsd,
  llmCostUsd,
  renderCostUsd,
  storageCostUsd,
  totalBilledTokens,
  ttsCostUsd,
} from '@/server/cost/pricing'
import { FakeDb } from './fake-db'
import { T } from '@/lib/db/tablas'

describe('precio de los modelos', () => {
  it('cobra entrada y salida según la tabla', () => {
    // claude-sonnet-5: US$3 por millón de entrada, US$15 por millón de salida.
    expect(llmCostUsd('claude-sonnet-5', { inputTokens: 1000, outputTokens: 500 })).toBe(0.0105)
    expect(llmCostUsd('claude-opus-5', { inputTokens: 1000, outputTokens: 500 })).toBe(0.0175)
    expect(llmCostUsd('claude-haiku-4-5', { inputTokens: 1_000_000, outputTokens: 0 })).toBe(1)
  })

  it('aplica los multiplicadores de caché', () => {
    expect(
      llmCostUsd('claude-sonnet-5', {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 10_000,
      }),
    ).toBe(0.003)

    expect(
      llmCostUsd('claude-sonnet-5', {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 10_000,
      }),
    ).toBe(0.0375)
  })

  it('un modelo desconocido se cobra como el más caro que usamos', () => {
    expect(llmCostUsd('modelo-inventado', { inputTokens: 1000, outputTokens: 0 })).toBe(0.005)
  })

  it('cuenta todos los tokens facturados', () => {
    expect(
      totalBilledTokens({
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationInputTokens: 10,
        cacheReadInputTokens: 5,
      }),
    ).toBe(165)
  })

  it('voz, render y storage salen de la misma tabla', () => {
    expect(ttsCostUsd(1_000_000, 'azure')).toBe(16)
    expect(ttsCostUsd(0)).toBe(0)
    // 0.019 min de cómputo por segundo de video, medido sobre 3 renders reales
    // (ver docs/DECISIONS.md D11) — reemplaza la estimación de 0.08 previa al render real.
    expect(renderCostUsd(75)).toBe(0.07125)
    expect(storageCostUsd(1, 1)).toBe(0.021)
  })
})

describe('formato de plata', () => {
  it('usa coma decimal y nunca dice "créditos"', () => {
    expect(formatUsd(0.42)).toBe('US$ 0,42')
    expect(formatUsd(12.5)).toBe('US$ 12,50')
    expect(formatUsd(0)).toBe('US$ 0,00')
  })

  it('no muestra US$ 0,00 cuando algo costó algo', () => {
    expect(formatUsd(0.004)).toBe('menos de US$ 0,01')
  })
})

describe('acumulación de renglones', () => {
  it('junta renglones equivalentes', () => {
    const merged = mergeEntries([
      { category: 'llm', units: 100, unitLabel: 'tokens', costUsd: 0.01, detail: 'hallazgo' },
      { category: 'llm', units: 50, unitLabel: 'tokens', costUsd: 0.005, detail: 'hallazgo' },
      { category: 'tts', units: 900, unitLabel: 'caracteres narrados', costUsd: 0.02 },
    ])

    expect(merged).toHaveLength(2)
    const llm = merged.find((entry) => entry.category === 'llm')!
    expect(llm.units).toBe(150)
    expect(llm.costUsd).toBe(0.015)
  })

  it('no junta renglones con distinto detalle', () => {
    const merged = mergeEntries([
      { category: 'llm', units: 100, unitLabel: 'tokens', costUsd: 0.01, detail: 'guion' },
      { category: 'llm', units: 100, unitLabel: 'tokens', costUsd: 0.01, detail: 'hallazgo' },
    ])
    expect(merged).toHaveLength(2)
  })

  it('el total es la suma de los renglones', () => {
    const breakdown = buildBreakdown([
      { category: 'llm', units: 1, unitLabel: 'tokens', costUsd: 0.02 },
      { category: 'render', units: 1, unitLabel: 'segundos de video', costUsd: 0.3 },
    ])
    expect(breakdown.totalUsd).toBe(0.32)
    expect(breakdown.entries[0].category).toBe('render') // ordenado de más caro a menos
  })
})

describe('estimación previa (lo que ve el usuario antes de gastar)', () => {
  it('da dólares y unidades concretas, nunca créditos', () => {
    const presupuesto = estimate('full_audit', { files: 120 })

    expect(presupuesto.unitsPlain[0]).toBe('1 auditoría')
    expect(presupuesto.unitsPlain).toContain('3 videos')
    expect(presupuesto.summaryPlain).toMatch(/^1 auditoría · 3 videos · US\$ /)
    expect(presupuesto.summaryPlain.toLowerCase()).not.toContain('crédito')
    expect(presupuesto.costUsd).toBeGreaterThan(0)
  })

  it('la estimación crece con el tamaño del proyecto', () => {
    const chico = estimate('full_audit', { files: 20 })
    const grande = estimate('full_audit', { files: 200 })
    expect(grande.costUsd).toBeGreaterThan(chico.costUsd)
  })

  it('el video estima guion, voz y render', () => {
    const uno = estimate('generate_video', { videos: 1 })
    const tres = estimate('generate_video', { videos: 3 })

    expect(uno.summaryPlain).toMatch(/^1 video · US\$ /)
    expect(tres.unitsPlain).toEqual(['3 videos'])
    expect(tres.entries.map((entry) => entry.category).sort()).toEqual(['llm', 'render', 'tts'])
    expect(tres.costUsd).toBeCloseTo(uno.costUsd * 3, 5)
  })

  it('el agente cuenta pruebas, no pasos', () => {
    const presupuesto = estimate('run_browser_agent', { tasks: 4 })
    expect(presupuesto.unitsPlain).toEqual(['4 pruebas en tu app'])
    expect(presupuesto.costUsd).toBeGreaterThan(0)
  })

  it('es determinística: el mismo pedido da el mismo número', () => {
    expect(estimate('run_checks', { files: 50 })).toEqual(estimate('run_checks', { files: 50 }))
  })
})

describe('libro de costos contra la base', () => {
  let db: FakeDb

  beforeEach(() => {
    db = new FakeDb()
    setJobsDb(db)
  })

  afterEach(() => {
    setJobsDb(null)
  })

  it('registra el gasto en usage_events', async () => {
    await recordCost(
      'org-1',
      'proj-1',
      { category: 'llm', units: 1500, unitLabel: 'tokens', costUsd: 0.0105, detail: 'hallazgo' },
      { analysisRunId: 'run-1' },
    )

    const fila = db.rows(T.usageEvents)[0]
    expect(fila.org_id).toBe('org-1')
    expect(fila.kind).toBe('llm')
    expect(fila.units).toBe(1500)
    expect(fila.unit_label).toBe('tokens')
    expect(fila.cost_usd).toBe(0.0105)
    expect(fila.analysis_run_id).toBe('run-1')
  })

  it('si faltan las columnas nuevas, igual registra el gasto', async () => {
    let intento = 0
    const original = db.execute.bind(db)
    db.execute = (op: any) => {
      if (op.table === T.usageEvents && op.type === 'insert') {
        intento += 1
        if (intento === 1) {
          return { data: null, error: { code: '42703', message: 'column "detail" does not exist' } }
        }
      }
      return original(op)
    }

    await recordCost('org-1', null, {
      category: 'tts',
      units: 900,
      unitLabel: 'caracteres narrados',
      costUsd: 0.014,
    })

    expect(intento).toBe(2)
    const fila = db.rows(T.usageEvents)[0]
    expect(fila.kind).toBe('tts')
    expect(fila.analysis_run_id).toBeUndefined()
  })

  it('runCost suma los renglones de la corrida y los guarda', async () => {
    db.seed(T.analysisRuns, [{ id: 'run-1', cost_breakdown: null }])
    db.seed(T.usageEvents, [
      {
        id: 'u1',
        analysis_run_id: 'run-1',
        kind: 'llm',
        units: 1000,
        unit_label: 'tokens',
        cost_usd: 0.01,
        detail: 'hallazgo',
      },
      {
        id: 'u2',
        analysis_run_id: 'run-1',
        kind: 'render',
        units: 75,
        unit_label: 'segundos de video',
        cost_usd: 0.3,
        detail: null,
      },
    ])

    // Los renglones que se le pasan son solo para el camino de respaldo: acá se
    // ignoran a propósito, porque ya están en usage_events. Contarlos dos veces
    // inflaría el costo de la corrida.
    const breakdown = await runCost('run-1', [
      { category: 'llm', units: 1000, unitLabel: 'tokens', costUsd: 0.01, detail: 'hallazgo' },
    ])

    expect(breakdown.totalUsd).toBe(0.31)
    const llm = breakdown.entries.find((entry) => entry.category === 'llm')!
    expect(llm.units).toBe(1000)

    const run = db.row(T.analysisRuns, 'run-1')!
    expect(run.cost_breakdown.totalUsd).toBe(0.31)
  })

  it('si falta la columna analysis_run_id, usa lo acumulado más los renglones sueltos', async () => {
    db.seed(T.analysisRuns, [
      {
        id: 'run-1',
        cost_breakdown: {
          entries: [
            { category: 'llm', units: 1000, unitLabel: 'tokens', costUsd: 0.01, detail: 'hallazgo' },
          ],
          totalUsd: 0.01,
        },
      },
    ])

    const original = db.execute.bind(db)
    db.execute = (op: any) => {
      if (op.table === T.usageEvents && op.type === 'select') {
        return { data: null, error: { code: '42703', message: 'column "analysis_run_id" does not exist' } }
      }
      return original(op)
    }

    const breakdown = await runCost('run-1', [
      { category: 'llm', units: 500, unitLabel: 'tokens', costUsd: 0.005, detail: 'hallazgo' },
    ])

    expect(breakdown.totalUsd).toBe(0.015)
    expect(breakdown.entries[0].units).toBe(1500)
  })
})
