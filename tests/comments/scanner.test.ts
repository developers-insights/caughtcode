import { describe, expect, it } from 'vitest'

import { scanFile } from '@/server/comments/scanner'
import { fixture, fixturePath } from '../fixtures/comments/load'

function scan(name: string) {
  return scanFile({ file: fixturePath(name), text: fixture(name) })
}

describe('scanner — precisión en TS/TSX', () => {
  const res = scan('client-page.tsx')
  const lines = res.hits.map((h) => h.line).sort((a, b) => a - b)

  it('encuentra exactamente los cinco comentarios reales', () => {
    expect(lines).toEqual([5, 9, 13, 16, 20])
  })

  it('no confunde un `//` dentro de un string con un comentario', () => {
    expect(res.hits.some((h) => h.text.includes('ejemplo.com'))).toBe(false)
  })

  it('no confunde `/* */` dentro de un template literal con un comentario', () => {
    expect(res.hits.some((h) => h.text.includes('falso comentario'))).toBe(false)
  })

  it('no confunde `//` dentro de una regex con un comentario', () => {
    expect(res.hits.some((h) => h.text.includes('[^\\s]+'))).toBe(false)
  })

  it('no confunde texto de JSX con un comentario', () => {
    expect(res.hits.some((h) => h.text.includes('esto es texto'))).toBe(false)
  })

  it('no confunde un `//` dentro de un atributo JSX con un comentario', () => {
    expect(res.hits.some((h) => h.text.trim() === 'b"')).toBe(false)
  })

  it('marca como jsx sólo el contenedor `{/* */}` que no tiene nada más', () => {
    const porLinea = new Map(res.hits.map((h) => [h.line, h]))
    expect(porLinea.get(16)!.syntax).toBe('jsx')
    expect(porLinea.get(20)!.syntax).toBe('block')
    expect(porLinea.get(5)!.syntax).toBe('line')
    expect(porLinea.get(13)!.syntax).toBe('block')
  })

  it('los rangos apuntan al texto exacto del comentario', () => {
    for (let i = 0; i < res.hits.length; i++) {
      const r = res.ranges[i]!
      const crudo = res.text.slice(r.pos, r.end)
      expect(crudo.startsWith('//') || crudo.startsWith('/*')).toBe(true)
    }
  })
})

describe('scanner — CSS', () => {
  const res = scan('styles.css')

  it('encuentra los comentarios reales', () => {
    expect(res.hits.map((h) => h.text.trim())).toEqual([
      'paleta principal',
      'expuesto',
      'TODO: unificar con tokens.css',
    ])
  })

  it('no toma como comentario el contenido de `content: "..."`', () => {
    expect(res.hits.some((h) => h.text.includes('no soy comentario'))).toBe(false)
  })

  it('marca la sintaxis como css', () => {
    expect(res.hits.every((h) => h.syntax === 'css')).toBe(true)
  })
})

describe('scanner — HTML', () => {
  const res = scan('index.html')

  it('encuentra los comentarios HTML', () => {
    const html = res.hits.filter((h) => h.syntax === 'html')
    expect(html).toHaveLength(3)
    expect(html.some((h) => h.text.includes('clave'))).toBe(true)
    expect(html.some((h) => h.text.includes('banner de prueba'))).toBe(true)
    expect(html.some((h) => h.text.includes('inline'))).toBe(true)
  })

  it('analiza <style> con el motor de CSS y <script> con el de JS', () => {
    expect(res.hits.some((h) => h.syntax === 'css' && h.text.includes('dentro de style'))).toBe(true)
    expect(res.hits.some((h) => h.syntax === 'line' && h.text.includes('dentro de script'))).toBe(
      true,
    )
  })

  it('no confunde `<!-- -->` escrito dentro de un string de script o css', () => {
    expect(res.hits.some((h) => h.text.includes('tampoco soy comentario'))).toBe(false)
    expect(res.hits.some((h) => h.text.includes('no soy comentario'))).toBe(false)
  })
})

describe('scanner — shebang', () => {
  it('nunca reporta el shebang como comentario', () => {
    const res = scan('banner.js')
    expect(res.hits.some((h) => h.text.includes('/usr/bin/env'))).toBe(false)
    expect(res.hits.some((h) => h.line === 1)).toBe(false)
  })
})

describe('scanner — comentarios de varias líneas', () => {
  it('reporta line y endLine distintas en un bloque multilínea', () => {
    const res = scanFile({ file: 'a.ts', text: 'const a = 1\n/*\n bloque\n largo\n*/\nconst b = 2\n' })
    expect(res.hits).toHaveLength(1)
    expect(res.hits[0]!.line).toBe(2)
    expect(res.hits[0]!.endLine).toBe(5)
  })
})
