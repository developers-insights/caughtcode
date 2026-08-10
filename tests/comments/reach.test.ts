import { describe, expect, it } from 'vitest'

import { computeReach } from '@/server/comments/reach'
import { fixture, fixturePath } from '../fixtures/comments/load'
import type { RouteInfo } from '@/lib/types/domain'

const nextApp = { framework: 'nextjs-app' } as const

function reachOf(name: string) {
  return computeReach(fixturePath(name), fixture(name), nextApp).reach
}

describe('reach — señales explícitas', () => {
  it("un archivo con 'use client' propio llega al navegador", () => {
    expect(reachOf('client-page.tsx')).toBe('ships_to_browser')
  })

  it('un archivo del App Router sin directiva se queda en el servidor', () => {
    expect(reachOf('server-action.ts')).toBe('server_only')
  })

  it('un route handler se queda en el servidor', () => {
    expect(reachOf('secrets-note.ts')).toBe('server_only')
  })

  it('el HTML de public/ siempre llega al navegador', () => {
    expect(reachOf('index.html')).toBe('ships_to_browser')
  })

  it('el CSS siempre llega al navegador', () => {
    expect(reachOf('styles.css')).toBe('ships_to_browser')
  })

  it('los scripts y configs son sólo de build', () => {
    expect(reachOf('banner.js')).toBe('build_only')
    expect(reachOf('tool.config.ts')).toBe('build_only')
  })

  it('los tests son sólo de build', () => {
    expect(computeReach('src/lib/a.test.ts', '', nextApp).reach).toBe('build_only')
    expect(computeReach('src/__tests__/b.ts', '', nextApp).reach).toBe('build_only')
  })
})

describe('reach — herencia de "use client" desde los layouts', () => {
  const routes: RouteInfo[] = [
    {
      path: '/panel',
      file: 'src/app/panel/layout.tsx',
      kind: 'layout',
      isDynamic: false,
      isClient: true,
      looksProtected: true,
    },
    {
      path: '/panel',
      file: 'src/app/panel/page.tsx',
      kind: 'page',
      isDynamic: false,
      isClient: true,
      looksProtected: true,
    },
  ]

  it('una página sin directiva bajo un layout cliente llega al navegador', () => {
    const r = computeReach('src/app/panel/page.tsx', 'export default function P() {}', {
      framework: 'nextjs-app',
      routes,
    })
    expect(r.reach).toBe('ships_to_browser')
  })

  it('un archivo suelto en la misma carpeta hereda el layout cliente', () => {
    const r = computeReach('src/app/panel/tabla.tsx', 'export function Tabla() {}', {
      framework: 'nextjs-app',
      routes,
    })
    expect(r.reach).toBe('ships_to_browser')
  })

  it('sin rutas, la misma página se considera de servidor', () => {
    const r = computeReach('src/app/panel/page.tsx', 'export default function P() {}', nextApp)
    expect(r.reach).toBe('server_only')
  })
})

describe('reach — señales de código de cliente sin directiva', () => {
  it('un módulo que usa hooks o window se trata como código de navegador', () => {
    const conHook = computeReach('src/lib/usar.ts', "import { useState } from 'react'\n", nextApp)
    expect(conHook.reach).toBe('ships_to_browser')

    const conWindow = computeReach('src/lib/tema.ts', 'export const w = window.innerWidth\n', nextApp)
    expect(conWindow.reach).toBe('ships_to_browser')
  })

  it("un módulo con import 'server-only' nunca llega al navegador", () => {
    const r = computeReach('src/lib/secreto.ts', "import 'server-only'\nimport { useState } from 'react'\n", nextApp)
    expect(r.reach).toBe('server_only')
  })
})

describe('reach — proyectos que no son Next.js', () => {
  it('en una SPA todo el código fuente llega al navegador', () => {
    const r = computeReach('src/lib/notes.ts', 'export const A = 1', { framework: 'spa' })
    expect(r.reach).toBe('ships_to_browser')
  })

  it('en Pages Router, pages/api se queda en el servidor', () => {
    expect(computeReach('pages/index.tsx', '', { framework: 'nextjs-pages' }).reach).toBe(
      'ships_to_browser',
    )
    expect(computeReach('pages/api/hola.ts', '', { framework: 'nextjs-pages' }).reach).toBe(
      'server_only',
    )
  })
})

describe('reach — siempre explica por qué', () => {
  it('devuelve una razón en castellano, sin jerga', () => {
    const r = computeReach(fixturePath('client-page.tsx'), fixture('client-page.tsx'), nextApp)
    expect(r.reason.length).toBeGreaterThan(10)
    expect(r.reason).not.toMatch(/RSC|SSR|bundle/i)
  })
})
