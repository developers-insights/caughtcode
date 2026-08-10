import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildCodeIndex, STAGE_LABEL, type StageId } from '@/server/analysis'
import { summarizeProject } from '@/server/analysis/summarize'
import { resolveSpecifier } from '@/server/analysis/symbols'
import { detectStack } from '@/server/ingest/stack'
import type { BuildIndexResult } from '@/server/analysis'
import { materializeFixture } from '../fixtures/mini-next'

describe('motor completo sobre el proyecto de prueba', () => {
  let root: string
  let cleanup: () => Promise<void>
  let result: BuildIndexResult
  const progreso: Array<{ stage: StageId; percent: number }> = []

  beforeAll(async () => {
    const fixture = await materializeFixture()
    root = fixture.root
    cleanup = fixture.cleanup
    result = await buildCodeIndex({
      root,
      onProgress: (stage, percent) => {
        progreso.push({ stage, percent })
      },
    })
  }, 60_000)

  afterAll(async () => {
    await cleanup()
  })

  it('detecta el stack con evidencia', async () => {
    const stack = await detectStack(root)
    expect(stack.framework).toBe('nextjs')
    expect(stack.routerKind).toBe('app')
    expect(stack.language).toBe('typescript')
    expect(stack.backends).toContain('supabase')
    expect(stack.hasTailwind).toBe(true)
    // Cada línea de evidencia nombra el archivo que la respalda.
    expect(stack.evidence.every((line) => line.includes('→'))).toBe(true)
  })

  it('informa progreso creciente y termina en 100', () => {
    expect(progreso.length).toBeGreaterThan(0)
    expect(progreso[progreso.length - 1].percent).toBe(100)
    let anterior = -1
    for (const paso of progreso) {
      expect(paso.percent).toBeGreaterThanOrEqual(anterior)
      anterior = paso.percent
    }
  })

  it('cada etapa tiene un nombre entendible', () => {
    for (const paso of progreso) {
      expect(STAGE_LABEL[paso.stage]).toBeTruthy()
      expect(STAGE_LABEL[paso.stage]).not.toMatch(/parse|AST|index|graph/i)
    }
  })

  it('arma el índice con pantallas, símbolos y ranking', () => {
    const { index } = result
    expect(index.fileCount).toBeGreaterThan(5)
    expect(index.routes.filter((route) => route.kind === 'page')).toHaveLength(4)
    expect(index.symbols.length).toBeGreaterThan(0)
    expect(index.rankedFiles.length).toBeGreaterThan(0)
  })

  it('resuelve los imports con alias @/ y conecta los archivos', () => {
    const { index } = result
    const desdeLaHome = index.edges.filter(
      (edge) => edge.from === 'src/app/page.tsx' && edge.kind === 'imports',
    )
    expect(desdeLaHome.map((edge) => edge.to)).toEqual(
      expect.arrayContaining(['src/components/Boton.tsx', 'src/lib/formato.ts']),
    )
  })

  it('registra que la home dibuja el botón', () => {
    const renders = result.index.edges.filter((edge) => edge.kind === 'renders')
    expect(renders.some((edge) => edge.to.startsWith('src/components/Boton.tsx'))).toBe(true)
  })

  it('no pierde el import que viene después de una expresión regular', () => {
    // src/lib/formato.ts tiene /^https:\/\// arriba de todo.
    const formato = result.index.rankedFiles.find((file) => file.file === 'src/lib/formato.ts')
    expect(formato).toBeDefined()
    const usan = result.index.edges.filter(
      (edge) => edge.kind === 'imports' && edge.to === 'src/lib/formato.ts',
    )
    expect(usan.length).toBeGreaterThanOrEqual(2)
  })

  it('anota el archivo roto en las notas sin voltear la corrida', () => {
    const notas = result.index.notes.join(' ')
    expect(notas).toMatch(/sintaxis/i)
    expect(notas).toMatch(/roto\.ts/)
  })

  it('sin conexión a la base lo dice y cae a lo declarado en el .sql', () => {
    const { dbSchema, notes } = result.index
    expect(dbSchema.source).toBe('declared')
    expect(notes.join(' ')).toMatch(/No conectaste la base de datos/i)

    const pedidos = dbSchema.tables.find((table) => table.name === 'pedidos')
    expect(pedidos).toBeDefined()
    expect(pedidos!.rlsEnabled).toBe(true)
    expect(pedidos!.rlsForced).toBe(true)
    expect(pedidos!.policies.map((policy) => policy.name)).toContain('pedidos_propios')
    expect(dbSchema.functions.find((fn) => fn.name === 'es_miembro')?.securityDefiner).toBe(true)
  })

  it('las notas están en castellano y sin jerga', () => {
    for (const nota of result.index.notes) {
      expect(nota).not.toMatch(/\b(RLS|AST|parser|schema|null|undefined)\b/)
      expect(nota.length).toBeGreaterThan(10)
    }
  })

  it('reanuda sin rehacer las etapas ya resueltas', async () => {
    let llamadas = 0
    const segunda = await buildCodeIndex({
      root,
      resumeFrom: result.stages,
      onProgress: () => {
        llamadas++
      },
    })
    expect(llamadas).toBeGreaterThan(0)
    expect(segunda.index.routes).toEqual(result.index.routes)
    expect(segunda.index.rankedFiles.map((file) => file.file)).toEqual(
      result.index.rankedFiles.map((file) => file.file),
    )
  })

  it('el mismo proyecto da el mismo índice dos veces', async () => {
    const otra = await buildCodeIndex({ root })
    expect(otra.index.rankedFiles).toEqual(result.index.rankedFiles)
    expect(otra.index.edges).toEqual(result.index.edges)
  }, 60_000)
})

describe('resolución de imports', () => {
  const known = new Set([
    'src/lib/formato.ts',
    'src/components/Boton.tsx',
    'src/components/index.ts',
    'src/app/page.tsx',
  ])

  it('resuelve relativos, alias y carpetas con index', () => {
    expect(resolveSpecifier('src/app/page.tsx', '@/lib/formato', known)).toBe('src/lib/formato.ts')
    expect(resolveSpecifier('src/app/page.tsx', '../lib/formato', known)).toBe('src/lib/formato.ts')
    expect(resolveSpecifier('src/app/page.tsx', '@/components', known)).toBe('src/components/index.ts')
  })

  it('devuelve null para paquetes de terceros', () => {
    expect(resolveSpecifier('src/app/page.tsx', 'react', known)).toBeNull()
    expect(resolveSpecifier('src/app/page.tsx', '@supabase/supabase-js', known)).toBeNull()
  })
})

describe('resumen escrito', () => {
  it('sin modelo devuelve un resumen armado con los datos del análisis', async () => {
    const fixture = await materializeFixture()
    try {
      const { index, stack } = await buildCodeIndex({ root: fixture.root })
      const summary = await summarizeProject(index, stack)
      expect(summary.source).toBe('estructura')
      expect(summary.overview).toMatch(/pantalla/i)
    } finally {
      await fixture.cleanup()
    }
  }, 60_000)

  it('descarta lo que el modelo inventa', async () => {
    const fixture = await materializeFixture()
    try {
      const { index, stack } = await buildCodeIndex({ root: fixture.root })
      const summary = await summarizeProject(index, stack, {
        complete: async () =>
          JSON.stringify({
            overview: 'Una tienda de mates.',
            modules: [
              { name: 'Pantallas', purpose: 'Lo que ve la gente.', files: ['src/app/page.tsx'] },
              { name: 'Inventado', purpose: 'No existe.', files: ['src/no/existe.ts'] },
            ],
          }),
      })
      expect(summary.source).toBe('modelo')
      expect(summary.modules.map((module) => module.name)).toEqual(['Pantallas'])
      expect(summary.notes.join(' ')).toMatch(/archivos que no están/i)
    } finally {
      await fixture.cleanup()
    }
  }, 60_000)

  it('si el modelo falla, igual devuelve algo útil', async () => {
    const fixture = await materializeFixture()
    try {
      const { index, stack } = await buildCodeIndex({ root: fixture.root })
      const summary = await summarizeProject(index, stack, {
        complete: async () => {
          throw new Error('el proveedor no respondió')
        },
      })
      expect(summary.source).toBe('estructura')
      expect(summary.overview.length).toBeGreaterThan(10)
    } finally {
      await fixture.cleanup()
    }
  }, 60_000)
})
