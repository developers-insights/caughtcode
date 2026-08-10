/**
 * El motor de análisis no puede pasar a heurístico en silencio.
 *
 * Si un día tree-sitter deja de cargar (una dependencia que se mueve, un `.wasm`
 * incompatible, un deploy sin las gramáticas), el producto sigue funcionando con
 * el lector simple — pero eso tiene que estar dicho en `CodeIndex.notes`, no
 * escondido. Estos tests fallan si esa constancia desaparece.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildCodeIndex, type BuildIndexResult } from '@/server/analysis'
import { analyzeSource, parserCapability, type SourceFacts } from '@/server/analysis/parser'
import { materializeFixture } from '../fixtures/mini-next'

/** Toda nota que hable del motor de lectura. */
const MOTOR = /analizador de sintaxis|lector simple/

function notasDeMotor(notes: string[]): string[] {
  return notes.filter((nota) => MOTOR.test(nota))
}

describe('constancia del motor de lectura', () => {
  let root: string
  let cleanup: () => Promise<void>
  let result: BuildIndexResult

  beforeAll(async () => {
    const fixture = await materializeFixture()
    root = fixture.root
    cleanup = fixture.cleanup
    result = await buildCodeIndex({ root })
  }, 60_000)

  afterAll(async () => {
    await cleanup()
  })

  it('siempre deja exactamente una nota diciendo con qué se leyó el código', () => {
    expect(notasDeMotor(result.index.notes)).toHaveLength(1)
  })

  it('la nota coincide con lo que realmente hizo cada archivo', () => {
    const nota = notasDeMotor(result.index.notes)[0]
    const conAst = result.stages.facts!.filter((fact) => fact.engine === 'tree-sitter').length
    const conLector = result.stages.facts!.filter((fact) => fact.engine === 'lector-directo').length

    expect(conAst + conLector).toBeGreaterThan(0)

    if (conLector === 0) {
      expect(nota).toContain('analizador de sintaxis')
      expect(nota).not.toContain('lector simple')
      expect(nota).toContain(String(conAst))
    } else if (conAst === 0) {
      expect(nota).toContain('lector simple')
      expect(nota).toContain(String(conLector))
    } else {
      expect(nota).toContain('analizador de sintaxis')
      expect(nota).toContain('lector simple')
    }
  })

  it('si el motor cayera entero al lector simple, la nota lo diría', async () => {
    // Se reanuda la corrida con hechos fabricados: todos leídos con el lector.
    // Es la única forma de probar el camino degradado sin romper la instalación.
    const degradados: SourceFacts[] = result.stages.facts!.map((fact) => ({
      ...fact,
      engine: 'lector-directo' as const,
    }))

    const degradado = await buildCodeIndex({
      root,
      resumeFrom: { ...result.stages, facts: degradados },
    })

    const notas = notasDeMotor(degradado.index.notes)
    expect(notas).toHaveLength(1)
    expect(notas[0]).toContain('lector simple')
    expect(notas[0]).toContain('no con el analizador de sintaxis')
  })

  it('si solo algunos archivos cayeran al lector, también lo diría', async () => {
    const mezcla: SourceFacts[] = result.stages.facts!.map((fact, indice) => ({
      ...fact,
      engine: indice === 0 ? ('lector-directo' as const) : ('tree-sitter' as const),
    }))

    const mixto = await buildCodeIndex({
      root,
      resumeFrom: { ...result.stages, facts: mezcla },
    })

    const notas = notasDeMotor(mixto.index.notes)
    expect(notas).toHaveLength(1)
    expect(notas[0]).toContain('analizador de sintaxis')
    expect(notas[0]).toContain('lector simple')
  })

  it('la constancia sobrevive a reanudar la corrida', async () => {
    const reanudado = await buildCodeIndex({ root, resumeFrom: result.stages })
    expect(notasDeMotor(reanudado.index.notes)).toHaveLength(1)
  })

  it('la nota se entiende sin ser técnico', () => {
    const nota = notasDeMotor(result.index.notes)[0]
    expect(nota).not.toMatch(/tree-sitter|AST|wasm|parser/i)
  })
})

describe('estado declarado del motor', () => {
  it('cuando dice estar disponible, un .tsx real se lee con tree-sitter', async () => {
    const capability = await parserCapability()
    const facts = await analyzeSource(
      'src/Boton.tsx',
      'export function Boton({ t }: { t: string }) { return <button>{t}</button> }\n',
    )

    // Que lo declarado y lo que pasa de verdad no se puedan separar.
    expect(facts.engine).toBe(capability.available ? 'tree-sitter' : 'lector-directo')
  })

  it('cuando dice estar disponible, un .ts también, no solo los .tsx', async () => {
    // Cada lenguaje carga su propia gramática. Este test existe porque las
    // gramáticas se cargaban perezosamente y los .ts caían al lector en silencio.
    const capability = await parserCapability()
    const facts = await analyzeSource('src/lib/util.ts', "import { a } from './a'\nexport const b = 1\n")

    expect(facts.engine).toBe(capability.available ? 'tree-sitter' : 'lector-directo')
    expect(facts.parseError).toBeUndefined()
  })
})
