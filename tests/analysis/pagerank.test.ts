import { describe, expect, it } from 'vitest'

import { pageRank, rankFiles } from '@/server/analysis/pagerank'

/**
 * Grafo de tres nodos con resultado resuelto a mano:
 *   A → B, A → C, B → C, C → A     con d = 0.85
 *
 *   A = 0.05 + 0.85·C
 *   B = 0.05 + 0.425·A
 *   C = 0.05 + 0.425·A + 0.85·B
 *
 * Resolviendo el sistema: A = 686/1769 ≈ 0.3877897, B ≈ 0.2148106, C ≈ 0.3973997.
 * Si alguien cambia la fórmula, este test se entera.
 */
const NODES = ['A', 'B', 'C']
const EDGES = [
  { from: 'A', to: 'B' },
  { from: 'A', to: 'C' },
  { from: 'B', to: 'C' },
  { from: 'C', to: 'A' },
]

describe('pageRank', () => {
  it('coincide con el resultado calculado a mano', () => {
    const scores = pageRank(NODES, EDGES)
    expect(scores.get('A')).toBeCloseTo(686 / 1769, 6)
    expect(scores.get('B')).toBeCloseTo(0.2148106, 6)
    expect(scores.get('C')).toBeCloseTo(0.3973997, 6)
  })

  it('los puntajes suman 1', () => {
    const total = [...pageRank(NODES, EDGES).values()].reduce((sum, value) => sum + value, 0)
    expect(total).toBeCloseTo(1, 9)
  })

  it('es determinístico: el orden de entrada no cambia el resultado', () => {
    const primera = pageRank(NODES, EDGES)
    const segunda = pageRank([...NODES].reverse(), [...EDGES].reverse())
    for (const node of NODES) {
      expect(segunda.get(node)).toBe(primera.get(node))
    }
  })

  it('reparte el peso de los nodos que no importan a nadie', () => {
    const scores = pageRank(['A', 'B'], [{ from: 'A', to: 'B' }])
    const total = [...scores.values()].reduce((sum, value) => sum + value, 0)
    expect(total).toBeCloseTo(1, 9)
    expect(scores.get('B')!).toBeGreaterThan(scores.get('A')!)
  })

  it('ignora las aristas hacia nodos desconocidos y las de un nodo a sí mismo', () => {
    const scores = pageRank(['A', 'B'], [
      { from: 'A', to: 'B' },
      { from: 'A', to: 'A' },
      { from: 'A', to: 'FANTASMA' },
    ])
    expect(scores.size).toBe(2)
    expect([...scores.values()].reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 9)
  })

  it('con un grafo vacío no explota', () => {
    expect(pageRank([], []).size).toBe(0)
  })

  it('las aristas repetidas no cuentan dos veces', () => {
    const unaVez = pageRank(NODES, EDGES)
    const repetidas = pageRank(NODES, [...EDGES, ...EDGES])
    for (const node of NODES) {
      expect(repetidas.get(node)).toBeCloseTo(unaVez.get(node)!, 12)
    }
  })
})

describe('rankFiles', () => {
  const files = ['src/app/page.tsx', 'src/components/Boton.tsx', 'src/lib/formato.ts']
  const edges = [
    { from: 'src/app/page.tsx', to: 'src/components/Boton.tsx' },
    { from: 'src/app/page.tsx', to: 'src/lib/formato.ts' },
    { from: 'src/components/Boton.tsx', to: 'src/lib/formato.ts' },
  ]

  it('pone arriba lo más usado y explica el porqué en castellano', () => {
    const ranked = rankFiles({ files, edges })
    expect(ranked[0].file).toBe('src/lib/formato.ts')
    expect(ranked[0].reason).toContain('2 archivos')
    // Nada de jerga en el texto que ve el usuario.
    for (const item of ranked) {
      expect(item.reason).not.toMatch(/pagerank|score|grafo|nodo/i)
      expect(item.reason.length).toBeGreaterThan(10)
    }
  })

  it('usa la ruta para explicar los archivos de pantalla', () => {
    const ranked = rankFiles({
      files,
      edges,
      context: {
        routes: [
          {
            path: '/',
            file: 'src/app/page.tsx',
            kind: 'page',
            isDynamic: false,
            isClient: false,
            looksProtected: false,
          },
        ],
      },
    })
    const page = ranked.find((item) => item.file === 'src/app/page.tsx')
    expect(page?.reason).toContain('Es la pantalla /')
  })

  it('respeta el límite pedido', () => {
    expect(rankFiles({ files, edges, limit: 2 })).toHaveLength(2)
  })
})
