import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { appRoutePath, detectRoutes, pagesRoutePath } from '@/server/analysis/routes'
import type { RouteInfo } from '@/lib/types/domain'
import { materializeFixture } from '../fixtures/mini-next'

describe('derivación de la URL pública', () => {
  it('ignora los grupos de rutas', () => {
    expect(appRoutePath(['(marketing)', 'precios'])).toEqual({ path: '/precios', isDynamic: false })
  })

  it('marca dinámica una ruta con corchetes', () => {
    expect(appRoutePath(['blog', '[slug]'])).toEqual({ path: '/blog/[slug]', isDynamic: true })
  })

  it('descarta las carpetas privadas', () => {
    expect(appRoutePath(['_borradores'])).toBeNull()
  })

  it('ignora las rutas paralelas e interceptadas', () => {
    expect(appRoutePath(['@modal', 'foto'])).toEqual({ path: '/foto', isDynamic: false })
    expect(appRoutePath(['(.)foto'])).toEqual({ path: '/', isDynamic: false })
  })

  it('la raíz es /', () => {
    expect(appRoutePath([])).toEqual({ path: '/', isDynamic: false })
  })

  it('resuelve el Pages Router', () => {
    expect(pagesRoutePath('index.tsx')).toEqual({ path: '/', isDynamic: false })
    expect(pagesRoutePath('blog/[slug].tsx')).toEqual({ path: '/blog/[slug]', isDynamic: true })
    expect(pagesRoutePath('_app.tsx')).toBeNull()
  })
})

describe('detectRoutes sobre un proyecto real en disco', () => {
  let root: string
  let cleanup: () => Promise<void>
  let routes: RouteInfo[]

  beforeAll(async () => {
    const fixture = await materializeFixture()
    root = fixture.root
    cleanup = fixture.cleanup
    routes = await detectRoutes(root)
  })

  afterAll(async () => {
    await cleanup()
  })

  it('encuentra exactamente las pantallas esperadas', () => {
    const pages = routes.filter((route) => route.kind === 'page').map((route) => route.path)
    expect(pages).toEqual(['/', '/dashboard', '/dashboard/[id]', '/precios'])
  })

  it('no publica las carpetas que empiezan con guion bajo', () => {
    expect(routes.some((route) => route.file.includes('_borradores'))).toBe(false)
  })

  it('reconoce la API como api, no como pantalla', () => {
    const api = routes.find((route) => route.path === '/api/webhook')
    expect(api?.kind).toBe('api')
    expect(api?.isClient).toBe(false)
  })

  it('marca dinámica solo la ruta con corchetes', () => {
    expect(routes.find((route) => route.path === '/dashboard/[id]')?.isDynamic).toBe(true)
    expect(routes.find((route) => route.path === '/precios')?.isDynamic).toBe(false)
  })

  it('hereda "use client" del layout del panel', () => {
    // Ninguna de las dos páginas declara 'use client': lo heredan del layout.
    expect(routes.find((route) => route.path === '/dashboard' && route.kind === 'page')?.isClient).toBe(true)
    expect(routes.find((route) => route.path === '/dashboard/[id]')?.isClient).toBe(true)
    expect(routes.find((route) => route.path === '/precios')?.isClient).toBe(false)
  })

  it('marca protegido el panel y no la landing ni los precios', () => {
    expect(routes.find((route) => route.path === '/dashboard' && route.kind === 'page')?.looksProtected).toBe(true)
    expect(routes.find((route) => route.path === '/dashboard/[id]')?.looksProtected).toBe(true)
    expect(routes.find((route) => route.path === '/')?.looksProtected).toBe(false)
    expect(routes.find((route) => route.path === '/precios')?.looksProtected).toBe(false)
  })

  it('apunta a archivos que existen de verdad', () => {
    for (const route of routes) {
      expect(route.file.startsWith('src/app/')).toBe(true)
    }
  })
})
