import { describe, expect, it } from 'vitest'

import { classifyFunctional } from '@/server/comments/functional'
import { scanFile } from '@/server/comments/scanner'
import { fixture, fixturePath } from '../fixtures/comments/load'

const ts = { file: 'a.ts' }
const js = { file: 'a.js' }

describe('functional — directivas del compilador', () => {
  it('reconoce las directivas de TypeScript', () => {
    for (const d of ['@ts-ignore', '@ts-expect-error', '@ts-nocheck', '@ts-check']) {
      expect(classifyFunctional(`// ${d}`, ts)).toBe('compiler_directive')
    }
  })

  it('reconoce las pragmas de JSX', () => {
    expect(classifyFunctional('/** @jsx h */', ts)).toBe('compiler_directive')
    expect(classifyFunctional('/** @jsxImportSource preact */', ts)).toBe('compiler_directive')
  })

  it('reconoce las referencias triple slash', () => {
    expect(classifyFunctional('/// <reference types="node" />', ts)).toBe('compiler_directive')
  })
})

describe('functional — supresiones de linters', () => {
  it('reconoce las supresiones habituales', () => {
    const casos = [
      '// eslint-disable-next-line no-console',
      '/* eslint-disable */',
      '// prettier-ignore',
      '// biome-ignore lint/style/noVar: heredado',
      '// oxlint-disable-next-line',
      '/* c8 ignore next */',
      '/* istanbul ignore else */',
      '/* v8 ignore start */',
      '// stylelint-disable-next-line',
    ]
    for (const c of casos) expect(classifyFunctional(c, ts)).toBe('linter')
  })
})

describe('functional — comentarios mágicos de bundlers', () => {
  it('reconoce los de webpack y vite', () => {
    expect(classifyFunctional('/* webpackChunkName: "tarde" */', ts)).toBe('bundler')
    expect(classifyFunctional('/* webpackIgnore: true */', ts)).toBe('bundler')
    expect(classifyFunctional('/* @vite-ignore */', ts)).toBe('bundler')
    expect(classifyFunctional('/* #__PURE__ */', ts)).toBe('bundler')
  })
})

describe('functional — licencias y source maps', () => {
  it('reconoce los bloques preservables', () => {
    expect(classifyFunctional('/*! demo v1 | MIT */', ts)).toBe('license')
    expect(classifyFunctional('/**\n * @license MIT\n */', ts)).toBe('license')
    expect(classifyFunctional('/* @preserve */', ts)).toBe('license')
    expect(classifyFunctional('/* SPDX-License-Identifier: MIT */', ts)).toBe('license')
  })

  it('reconoce los source maps', () => {
    expect(classifyFunctional('//# sourceMappingURL=a.js.map', ts)).toBe('sourcemap')
    expect(classifyFunctional('//# sourceURL=a.js', ts)).toBe('sourcemap')
  })
})

describe('functional — JSDoc según el lenguaje', () => {
  it('en .js el JSDoc con tipos es funcional: borrarlo cambia el chequeo', () => {
    expect(classifyFunctional('/** @type {string} */', js)).toBe('jsdoc_types')
    expect(classifyFunctional('/**\n * @param {number} a\n */', js)).toBe('jsdoc_types')
  })

  it('en .ts el mismo JSDoc es sólo documentación', () => {
    expect(classifyFunctional('/** @param {number} a */', ts)).toBe('jsdoc_doc')
  })

  it('un JSDoc de prosa en .js sin anotaciones de tipo es documentación', () => {
    expect(classifyFunctional('/** Suma dos numeros. */', js)).toBe('jsdoc_doc')
  })

  it('un comentario común no es funcional', () => {
    expect(classifyFunctional('// nota cualquiera', ts)).toBe(null)
    expect(classifyFunctional('/* bloque cualquiera */', ts)).toBe(null)
  })
})

describe('functional — sobre los fixtures', () => {
  it('marca la supresión de eslint y el JSDoc del archivo de servidor', () => {
    const res = scanFile({ file: fixturePath('server-action.ts'), text: fixture('server-action.ts') })
    const eslint = res.hits.find((h) => h.text.includes('eslint-disable'))!
    expect(eslint.functional).toBe(true)
    const jsdoc = res.hits.find((h) => h.text.includes('Devuelve los proyectos'))!
    expect(jsdoc.functional).toBe(true)
    const todo = res.hits.find((h) => h.text.includes('paginar'))!
    expect(todo.functional).toBe(false)
  })

  it('marca licencia, source map y magic comment en banner.js', () => {
    const res = scanFile({ file: fixturePath('banner.js'), text: fixture('banner.js') })
    expect(res.hits.find((h) => h.text.includes('caughtcode demo'))!.functional).toBe(true)
    expect(res.hits.find((h) => h.text.includes('@license'))!.functional).toBe(true)
    expect(res.hits.find((h) => h.text.includes('sourceMappingURL'))!.functional).toBe(true)
    expect(res.hits.find((h) => h.text.includes('webpackChunkName'))!.functional).toBe(true)
    expect(res.hits.find((h) => h.text.includes('comun que si se borra'))!.functional).toBe(false)
  })

  it('explica en castellano por qué se conserva', () => {
    const res = scanFile({ file: fixturePath('banner.js'), text: fixture('banner.js') })
    const lic = res.hits.find((h) => h.text.includes('caughtcode demo'))!
    expect(lic.reason).toBeTruthy()
    expect(lic.reason!.length).toBeGreaterThan(10)
  })
})
