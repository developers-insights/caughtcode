import { describe, expect, it } from 'vitest'

import {
  analyzeSource,
  languageOf,
  parserCapability,
  preprocess,
  readDirectives,
} from '@/server/analysis/parser'

describe('estado del analizador de sintaxis', () => {
  it('informa si tree-sitter está disponible y, si no, por qué', async () => {
    const capability = await parserCapability()
    if (capability.available) {
      expect(capability.engine).toBe('tree-sitter')
    } else {
      // No lo damos por bueno: si no está, tiene que decir el motivo.
      expect(capability.engine).toBe('lector-directo')
      expect(capability.reason).toBeTruthy()
      expect(capability.reason!.length).toBeGreaterThan(10)
    }
  })
})

describe('limpieza previa del archivo', () => {
  it('saca comentarios de línea y de bloque', () => {
    const { clean } = preprocess("const a = 1 // import 'no-existe'\n/* import 'tampoco' */\nconst b = 2")
    expect(clean).not.toContain('no-existe')
    expect(clean).not.toContain('tampoco')
    expect(clean).toContain('const b = 2')
  })

  it('no confunde una expresión regular con un comentario', () => {
    const source = "const re = /^https:\\/\\//\nexport const listo = 1\n"
    const { clean } = preprocess(source)
    expect(clean).toContain('export const listo = 1')
  })

  it('no toma como comentario el "/*" de un comentario de JSX ya cerrado', () => {
    const { clean } = preprocess('const x = <div>{/* nota */}</div>\nexport const y = 2')
    expect(clean).toContain('export const y = 2')
  })

  it('mantiene el largo original para no correr los números de línea', () => {
    const source = "// hola\nconst a = 1\n/* dos\nlineas */\nconst b = 2\n"
    expect(preprocess(source).clean).toHaveLength(source.length)
  })
})

describe('directivas', () => {
  it('detecta use client arriba de todo', () => {
    expect(readDirectives("'use client'\nimport x from 'y'").isClient).toBe(true)
    expect(readDirectives("// nota\n'use client'\n").isClient).toBe(true)
    expect(readDirectives("'use server'\n").isServerAction).toBe(true)
  })

  it('no la toma si aparece después del código', () => {
    expect(readDirectives("import x from 'y'\n'use client'\n").isClient).toBe(false)
  })
})

describe('analyzeSource', () => {
  it('reconoce el lenguaje por la extensión', () => {
    expect(languageOf('a.tsx')).toBe('tsx')
    expect(languageOf('a.ts')).toBe('typescript')
    expect(languageOf('a.mjs')).toBe('javascript')
    expect(languageOf('a.css')).toBeNull()
  })

  it('saca imports, exports y componentes usados', async () => {
    const source = `'use client'
import { useState } from 'react'
import Boton from '@/components/Boton'
import { formatearPrecio, type Moneda } from '@/lib/formato'
export { util } from './util'

export const PRECIO = 100
export function Pantalla() {
  const [abierto] = useState(false)
  return <Boton abierto={abierto}>{formatearPrecio(PRECIO)}</Boton>
}
export default Pantalla
`
    const facts = await analyzeSource('src/app/page.tsx', source)

    expect(facts.isClient).toBe(true)
    const sources = facts.imports.map((item) => item.source)
    expect(sources).toContain('react')
    expect(sources).toContain('@/components/Boton')
    expect(sources).toContain('@/lib/formato')
    expect(sources).toContain('./util')

    const names = facts.exports.map((item) => item.name)
    expect(names).toContain('PRECIO')
    expect(names).toContain('Pantalla')
    expect(names).toContain('default')

    expect(facts.jsxUsages.map((item) => item.name)).toContain('Boton')
  })

  it('encuentra imports dinámicos y require', async () => {
    const facts = await analyzeSource(
      'src/carga.ts',
      "const mod = await import('./pesado')\nconst fs = require('node:fs')\n",
    )
    const dynamic = facts.imports.find((item) => item.kind === 'dynamic')
    const required = facts.imports.find((item) => item.kind === 'require')
    expect(dynamic?.source).toBe('./pesado')
    expect(required?.source).toBe('node:fs')
  })

  it('sobrevive a un archivo con la sintaxis rota', async () => {
    const roto = `import { algo } from './algo'

export function seRompe() {
  const valor = {
    a: 1,
`
    const facts = await analyzeSource('src/roto.ts', roto)
    // Lo importante: no tira, y lo que sí pudo leer lo devuelve.
    expect(facts.imports.map((item) => item.source)).toContain('./algo')
    expect(facts.exports.map((item) => item.name)).toContain('seRompe')
    // Y deja constancia, con cualquiera de los dos motores.
    expect(facts.parseError).toBeTruthy()
  })

  it('no acusa de rota a una pantalla con JSX, llaves y plantillas', async () => {
    const sana = `import { useState } from 'react'

export function Tarjeta({ nombre }: { nombre: string }) {
  const [abierto, setAbierto] = useState(false)
  const clase = \`tarjeta \${abierto ? 'abierta' : 'cerrada'}\`
  return (
    <div className={clase} onClick={() => setAbierto((v) => !v)}>
      <span>{nombre}</span>
      <p>Usá {'{'} y {'}'} sin miedo</p>
    </div>
  )
}
`
    const facts = await analyzeSource('src/Tarjeta.tsx', sana)
    expect(facts.parseError).toBeUndefined()
  })

  it('no confunde un import escrito dentro de un texto con un import real', async () => {
    const facts = await analyzeSource(
      'src/texto.ts',
      `const ejemplo = "import algo from 'paquete-falso'"\nimport real from './real'\n`,
    )
    const sources = facts.imports.map((item) => item.source)
    expect(sources).toContain('./real')
    expect(sources).not.toContain('paquete-falso')
  })

  it('no analiza archivos gigantes, pero lo aclara', async () => {
    const facts = await analyzeSource('src/gigante.ts', 'a'.repeat(2000), { maxBytes: 100 })
    expect(facts.imports).toHaveLength(0)
    expect(facts.parseError).toBeTruthy()
  })

  it('el lector directo da el mismo resultado que el motor por defecto', async () => {
    const source = "import { a } from './a'\nexport const b = 1\n"
    const pordefecto = await analyzeSource('src/x.ts', source)
    const directo = await analyzeSource('src/x.ts', source, { forceReader: true })
    expect(directo.imports.map((item) => item.source)).toEqual(pordefecto.imports.map((item) => item.source))
    expect(directo.exports.map((item) => item.name)).toEqual(pordefecto.exports.map((item) => item.name))
  })
})
