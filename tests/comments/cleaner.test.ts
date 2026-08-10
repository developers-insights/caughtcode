import { describe, expect, it } from 'vitest'

import { buildCleanPlan } from '@/server/comments/cleaner'
import { scanFile } from '@/server/comments/scanner'
import { fixture, fixturePath } from '../fixtures/comments/load'

function planFor(names: string[], mode: 'safe' | 'aggressive' = 'safe') {
  const files = names.map((n) => scanFile({ file: fixturePath(n), text: fixture(n) }))
  return buildCleanPlan(files, { mode })
}

function afterOf(plan: ReturnType<typeof planFor>, name: string): string {
  const f = plan.files.find((x) => x.file === fixturePath(name))
  if (!f) throw new Error(`El plan no incluye ${name}: ${JSON.stringify(plan.skipped)}`)
  return f.after
}

describe('cleaner — modo seguro conserva lo funcional', () => {
  const plan = planFor(['banner.js'], 'safe')
  const after = afterOf(plan, 'banner.js')

  it('nunca toca el shebang', () => {
    expect(after.split('\n')[0]).toBe('#!/usr/bin/env node')
  })

  it('conserva la licencia, el source map y el magic comment', () => {
    expect(after).toContain('/*! caughtcode demo v1.0.0 | MIT */')
    expect(after).toContain('@license MIT')
    expect(after).toContain('//# sourceMappingURL=banner.js.map')
    expect(after).toContain('webpackChunkName')
  })

  it('borra el comentario común', () => {
    expect(after).not.toContain('comun que si se borra')
  })

  it('no cambia ninguna línea de código real', () => {
    expect(after).toContain("import(/* webpackChunkName: \"tarde\" */ './tarde.js')")
    expect(after).toContain("console.log('hola')")
  })
})

describe('cleaner — modo agresivo', () => {
  const plan = planFor(['banner.js'], 'aggressive')
  const after = afterOf(plan, 'banner.js')

  it('conserva licencia, shebang, source map y directivas del compilador', () => {
    expect(after.split('\n')[0]).toBe('#!/usr/bin/env node')
    expect(after).toContain('/*! caughtcode demo v1.0.0 | MIT */')
    expect(after).toContain('@license MIT')
    expect(after).toContain('//# sourceMappingURL=banner.js.map')
  })

  it('borra el magic comment del bundler', () => {
    expect(after).not.toContain('webpackChunkName')
  })
})

describe('cleaner — JSDoc según el modo', () => {
  it('en modo seguro conserva todo el JSDoc de un .ts', () => {
    const after = afterOf(planFor(['server-action.ts'], 'safe'), 'server-action.ts')
    expect(after).toContain('Devuelve los proyectos del usuario')
    expect(after).toContain('eslint-disable-next-line')
    expect(after).not.toContain('TODO: paginar')
  })

  it('en modo agresivo borra el JSDoc y la supresión de lint de un .ts', () => {
    const after = afterOf(planFor(['server-action.ts'], 'aggressive'), 'server-action.ts')
    expect(after).not.toContain('Devuelve los proyectos del usuario')
    expect(after).not.toContain('eslint-disable-next-line')
  })

  it('en un .js conserva el JSDoc con tipos incluso en modo agresivo', () => {
    const after = afterOf(planFor(['legacy-helper.js'], 'safe'), 'legacy-helper.js')
    expect(after).toContain('/** @type {string} */')
    expect(after).toContain('@param {number} a')
    expect(after).not.toContain('comentario comun sin anotaciones')
  })
})

describe('cleaner — comentarios dentro de JSX', () => {
  const after = afterOf(planFor(['client-page.tsx'], 'safe'), 'client-page.tsx')

  it('borra el contenedor `{...}` completo, no deja `{}` colgando', () => {
    expect(after).not.toContain('este comentario llega al navegador')
    expect(after).not.toMatch(/\{\s*\}/)
  })

  it('conserva el código real de JSX', () => {
    expect(after).toContain('<div className="wrap">')
    expect(after).toContain('<input value={q} onChange={(e) => setQ(e.target.value)} />')
    expect(after).toContain('Busca algo /* esto es texto, no comentario */ aca')
    expect(after).toContain('<span title="a // b">')
  })

  it('borra el comentario que está dentro de una expresión sin romperla', () => {
    expect(after).not.toContain('comentario dentro de expresion')
    expect(after).toMatch(/<em>\{tpl\}<\/em>/)
  })

  it("nunca toca la directiva 'use client'", () => {
    expect(after.split('\n')[0]).toBe("'use client'")
  })

  it('conserva el string, el template y la regex intactos', () => {
    expect(after).toContain('const url = "https://ejemplo.com//api"')
    expect(after).toContain('const tpl = `un /* falso comentario */ y ${q} final`')
    expect(after).toContain('const re = /https?:\\/\\/[^\\s]+/g')
  })
})

describe('cleaner — limpieza de líneas', () => {
  it('borra la línea entera cuando el comentario la ocupaba solo', () => {
    const f = scanFile({ file: 'a.ts', text: 'const a = 1\n// solo\nconst b = 2\n' })
    const plan = buildCleanPlan([f], { mode: 'safe' })
    expect(plan.files[0]!.after).toBe('const a = 1\nconst b = 2\n')
  })

  it('deja el código y borra el comentario al final de línea', () => {
    const f = scanFile({ file: 'a.ts', text: 'const a = 1 // nota\n' })
    const plan = buildCleanPlan([f], { mode: 'safe' })
    expect(plan.files[0]!.after).toBe('const a = 1\n')
  })

  it('no deja más de una línea en blanco de más', () => {
    const texto = 'const a = 1\n\n// uno\n// dos\n// tres\n\nconst b = 2\n'
    const f = scanFile({ file: 'a.ts', text: texto })
    const plan = buildCleanPlan([f], { mode: 'safe' })
    expect(plan.files[0]!.after).toBe('const a = 1\n\nconst b = 2\n')
  })

  it('conserva la indentación del código que queda', () => {
    const f = scanFile({ file: 'a.ts', text: 'function f() {\n  // nota\n  return 1\n}\n' })
    const plan = buildCleanPlan([f], { mode: 'safe' })
    expect(plan.files[0]!.after).toBe('function f() {\n  return 1\n}\n')
  })
})

describe('cleaner — CSS', () => {
  it('borra los comentarios sin tocar las reglas', () => {
    const after = afterOf(planFor(['styles.css'], 'safe'), 'styles.css')
    expect(after).not.toContain('paleta principal')
    expect(after).not.toContain('TODO: unificar')
    expect(after).toContain('content: "/* no soy comentario */"')
    expect(after).toContain('--rojo: #b3261e;')
  })
})

describe('cleaner — HTML', () => {
  it('borra los comentarios HTML y los de dentro de script y style', () => {
    const after = afterOf(planFor(['index.html'], 'safe'), 'index.html')
    expect(after).not.toContain('sk_live_')
    expect(after).not.toContain('sacar el banner')
    expect(after).not.toContain('dentro de style')
    expect(after).not.toContain('dentro de script')
    // El comentario estaba entre dos palabras: queda un solo espacio, nunca cero.
    expect(after).toContain('<p>Hola mundo</p>')
    expect(after).toContain('content: "<!-- no soy comentario -->"')
    expect(after).toContain('const s = "<!-- tampoco soy comentario -->"')
  })
})

describe("cleaner — las directivas ('use client' y compañía) son intocables", () => {
  // No son comentarios, pero viven pegadas a ellos arriba de todo. Si una se
  // borra o deja de ser la primera sentencia, el archivo cambia de significado:
  // un componente de servidor pasa a cliente, o al revés.
  const DIRECTIVAS = ['use client', 'use server', 'use cache', 'use strict'] as const

  /** Primera línea que no es ni comentario ni espacio en blanco. */
  function primeraSentencia(texto: string): string {
    return (
      texto
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l !== '' && !l.startsWith('//') && !l.startsWith('/*') && !l.startsWith('*')) ??
      ''
    )
  }

  for (const modo of ['safe', 'aggressive'] as const) {
    for (const directiva of DIRECTIVAS) {
      it(`conserva '${directiva}' al principio del archivo en modo ${modo}`, () => {
        const texto = [
          '// nota que se tiene que borrar',
          `'${directiva}'`,
          '',
          '// otra nota',
          "import { algo } from './algo'",
          '',
          'export const x = algo',
          '',
        ].join('\n')
        const f = scanFile({ file: 'src/app/pantalla.tsx', text: texto })
        const plan = buildCleanPlan([f], { mode: modo })
        const after = plan.files[0]!.after

        expect(plan.skipped).toHaveLength(0)
        expect(after).toContain(`'${directiva}'`)
        expect(primeraSentencia(after)).toBe(`'${directiva}'`)
        expect(after).not.toContain('nota que se tiene que borrar')
        expect(after).toContain("import { algo } from './algo'")
      })

      it(`conserva '${directiva}' dentro de una función en modo ${modo}`, () => {
        const texto = [
          'export async function traer() {',
          '  // comentario justo antes de la directiva',
          `  '${directiva}'`,
          '  return 1',
          '}',
          '',
        ].join('\n')
        const f = scanFile({ file: 'src/app/acciones.ts', text: texto })
        const plan = buildCleanPlan([f], { mode: modo })
        const after = plan.files[0]!.after

        expect(after).toContain(`  '${directiva}'`)
        expect(after).not.toContain('comentario justo antes')
        // Sigue siendo la primera sentencia del cuerpo.
        const cuerpo = after.split('\n').slice(1)
        expect(cuerpo.find((l) => l.trim() !== '')!.trim()).toBe(`'${directiva}'`)
      })
    }
  }
})

describe('cleaner — un archivo que no se puede leer con certeza se descarta', () => {
  // Regresión: cada `<a b={` abre un intento de JSX que sólo falla al final del
  // archivo. Al descartarse se reescanea la misma región, y con muchos `<` el
  // costo se vuelve cuadrático. Antes colgaba el proceso hasta quedarse sin
  // memoria; ahora hay un tope y el archivo simplemente queda afuera del plan.
  const veneno = `const x = ${'<a b={'.repeat(400)}\n`

  it('termina rápido en vez de colgarse', () => {
    const t = Date.now()
    const f = scanFile({ file: 'src/app/veneno.tsx', text: veneno })
    expect(Date.now() - t).toBeLessThan(2000)
    expect(f.ok).toBe(false)
  })

  it('queda afuera del plan, con motivo, y no arrastra a los demás', () => {
    const malo = scanFile({ file: 'src/app/veneno.tsx', text: veneno })
    const bueno = scanFile({ file: 'src/app/sano.ts', text: 'const a = 1 // nota\n' })
    const plan = buildCleanPlan([malo, bueno], { mode: 'safe' })

    expect(plan.files.map((f) => f.file)).toEqual(['src/app/sano.ts'])
    expect(plan.skipped).toHaveLength(1)
    expect(plan.skipped[0]!.file).toBe('src/app/veneno.tsx')
    expect(plan.skipped[0]!.reason).toBeTruthy()
  })
})

describe('cleaner — contabilidad del plan', () => {
  it('cuenta borrados y conservados por archivo', () => {
    const plan = planFor(['banner.js', 'server-action.ts'], 'safe')
    expect(plan.mode).toBe('safe')
    expect(plan.totalRemoved).toBeGreaterThan(0)
    expect(plan.totalKept).toBeGreaterThan(0)
    for (const f of plan.files) {
      expect(f.before).not.toBe(f.after)
      expect(f.removed).toBeGreaterThan(0)
    }
  })

  it('no incluye archivos sin nada para borrar', () => {
    const f = scanFile({ file: 'a.ts', text: 'const a = 1\n' })
    const plan = buildCleanPlan([f], { mode: 'safe' })
    expect(plan.files).toHaveLength(0)
    expect(plan.totalRemoved).toBe(0)
  })
})
