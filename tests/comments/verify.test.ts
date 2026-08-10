import { describe, expect, it } from 'vitest'

import { buildCleanPlan } from '@/server/comments/cleaner'
import { scanFile } from '@/server/comments/scanner'
import { verifyChange } from '@/server/comments/verify'
import { fixture, fixturePath } from '../fixtures/comments/load'

describe('verify — acepta lo que sólo saca comentarios', () => {
  it('acepta un borrado legítimo', () => {
    const r = verifyChange('a.ts', 'const a = 1 // nota\n', 'const a = 1\n')
    expect(r.ok).toBe(true)
  })

  it('acepta el borrado de un contenedor JSX completo', () => {
    const antes = 'const a = <div>\n  {/* nota */}\n  <b />\n</div>\n'
    const despues = 'const a = <div>\n  <b />\n</div>\n'
    expect(verifyChange('a.tsx', antes, despues).ok).toBe(true)
  })

  it('acepta que cambie el espaciado alrededor del texto JSX', () => {
    const antes = '<p>hola {/* x */} mundo</p>\n'
    const despues = '<p>hola mundo</p>\n'
    expect(verifyChange('a.tsx', antes, despues).ok).toBe(true)
  })
})

describe('verify — rechaza cualquier cambio en el código real', () => {
  it('rechaza si desaparece un token', () => {
    const r = verifyChange('a.ts', 'const a = 1 // nota\n', 'const a = // nota\n')
    expect(r.ok).toBe(false)
    expect(r.reason).toBeTruthy()
  })

  it('rechaza si cambia el valor de un literal', () => {
    expect(verifyChange('a.ts', 'const a = 1\n', 'const a = 2\n').ok).toBe(false)
  })

  it('rechaza si se borró texto visible de JSX', () => {
    expect(verifyChange('a.tsx', '<p>hola mundo</p>\n', '<p>hola</p>\n').ok).toBe(false)
  })

  it("rechaza si se tocó la directiva 'use client'", () => {
    const antes = "'use client'\nconst a = 1\n"
    const despues = 'const a = 1\n'
    expect(verifyChange('a.tsx', antes, despues).ok).toBe(false)
  })

  it('rechaza si el resultado deja de parsear', () => {
    const r = verifyChange('a.ts', 'const a = "x" // nota\n', 'const a = "x // nota\n')
    expect(r.ok).toBe(false)
  })

  it('rechaza si cambia el shebang', () => {
    const antes = '#!/usr/bin/env node\nconst a = 1\n'
    const despues = 'const a = 1\n'
    expect(verifyChange('a.js', antes, despues).ok).toBe(false)
  })
})

describe('verify — CSS', () => {
  it('acepta el borrado de un comentario', () => {
    expect(verifyChange('a.css', '/* x */\n.a { color: red }\n', '.a { color: red }\n').ok).toBe(true)
  })

  it('rechaza si cambia una declaración', () => {
    expect(verifyChange('a.css', '.a { color: red }\n', '.a { color: blue }\n').ok).toBe(false)
  })

  it('rechaza si el CSS resultante no parsea', () => {
    expect(verifyChange('a.css', '.a { color: red }\n', '.a { color: red \n').ok).toBe(false)
  })
})

describe('verify — HTML', () => {
  it('acepta el borrado de un comentario', () => {
    expect(verifyChange('a.html', '<p>a</p>\n<!-- x -->\n', '<p>a</p>\n').ok).toBe(true)
  })

  it('rechaza si desaparece una etiqueta', () => {
    expect(verifyChange('a.html', '<p>a</p>\n<b>c</b>\n', '<p>a</p>\n').ok).toBe(false)
  })
})

describe('verify — está enganchado al plan', () => {
  it('todo archivo del plan pasa la verificación', () => {
    const nombres = [
      'client-page.tsx',
      'server-action.ts',
      'legacy-helper.js',
      'banner.js',
      'styles.css',
      'index.html',
      'secrets-note.ts',
      'disabled-code.ts',
      'notes.ts',
      'tool.config.ts',
    ]
    const files = nombres.map((n) => scanFile({ file: fixturePath(n), text: fixture(n) }))
    const plan = buildCleanPlan(files, { mode: 'safe' })
    expect(plan.skipped).toHaveLength(0)
    for (const f of plan.files) {
      expect(verifyChange(f.file, f.before, f.after).ok).toBe(true)
    }
  })

  it('descarta del plan el archivo que no pasa, sin tirar todo abajo', () => {
    const bueno = scanFile({ file: 'bueno.ts', text: 'const a = 1 // nota\n' })
    const malo = scanFile({ file: 'malo.ts', text: 'const b = 2 // nota\n' })
    // Simulamos un motor de limpieza roto para ese archivo.
    const plan = buildCleanPlan([bueno, malo], {
      mode: 'safe',
      transformForTest: (file, text) => (file === 'malo.ts' ? 'const b = 99\n' : undefined),
    })
    expect(plan.files.map((f) => f.file)).toEqual(['bueno.ts'])
    expect(plan.skipped).toHaveLength(1)
    expect(plan.skipped[0]!.file).toBe('malo.ts')
    expect(plan.skipped[0]!.reason).toBeTruthy()
  })
})
