/**
 * Parseo de direcciones de GitHub.
 *
 * Esto lo alimenta una persona copiando y pegando de la barra del navegador, así
 * que la tolerancia no es un lujo: `.git`, barra final, `/tree/rama`, `www.`,
 * mayúsculas y parámetros de más son casos normales, no casos raros.
 *
 * Y la otra mitad importa igual: lo que NO es un repositorio de GitHub tiene que
 * devolver `null` para que la UI muestre "esa no parece una dirección de GitHub"
 * en vez de salir a pedirle un zip a un servidor cualquiera.
 */

import { describe, it, expect } from 'vitest'
import { parseGithubUrl } from '@/server/ingest/github'

describe('parseGithubUrl', () => {
  it('lee la forma normal que se copia del navegador', () => {
    expect(parseGithubUrl('https://github.com/vercel/next.js')).toEqual({
      owner: 'vercel',
      repo: 'next.js',
    })
  })

  it('tolera barra final, .git, www y mayúsculas del host', () => {
    const esperado = { owner: 'vercel', repo: 'next.js' }
    expect(parseGithubUrl('https://github.com/vercel/next.js/')).toEqual(esperado)
    expect(parseGithubUrl('https://github.com/vercel/next.js.git')).toEqual(esperado)
    expect(parseGithubUrl('https://www.github.com/vercel/next.js')).toEqual(esperado)
    expect(parseGithubUrl('HTTPS://GitHub.com/vercel/next.js')).toEqual(esperado)
    expect(parseGithubUrl('github.com/vercel/next.js')).toEqual(esperado)
    expect(parseGithubUrl('  https://github.com/vercel/next.js  ')).toEqual(esperado)
  })

  it('acepta la forma corta usuario/proyecto', () => {
    expect(parseGithubUrl('vercel/next.js')).toEqual({ owner: 'vercel', repo: 'next.js' })
  })

  it('acepta la dirección de clonar por ssh', () => {
    expect(parseGithubUrl('git@github.com:vercel/next.js.git')).toEqual({
      owner: 'vercel',
      repo: 'next.js',
    })
  })

  it('saca la rama de /tree/, incluso si la rama tiene barras', () => {
    expect(parseGithubUrl('https://github.com/mi/app/tree/main')).toEqual({
      owner: 'mi',
      repo: 'app',
      ref: 'main',
    })
    expect(parseGithubUrl('https://github.com/mi/app/tree/feature/pantalla-nueva')).toEqual({
      owner: 'mi',
      repo: 'app',
      ref: 'feature/pantalla-nueva',
    })
    // `/tree/` sin nada atrás no es una rama.
    expect(parseGithubUrl('https://github.com/mi/app/tree/')).toEqual({ owner: 'mi', repo: 'app' })
  })

  it('ignora lo que viene después del repositorio si no es una rama', () => {
    expect(parseGithubUrl('https://github.com/mi/app?tab=readme-ov-file#instalacion')).toEqual({
      owner: 'mi',
      repo: 'app',
    })
    expect(parseGithubUrl('https://github.com/mi/app/issues/12')).toEqual({
      owner: 'mi',
      repo: 'app',
    })
  })

  it('devuelve null cuando no es una dirección de GitHub', () => {
    expect(parseGithubUrl('')).toBeNull()
    expect(parseGithubUrl('   ')).toBeNull()
    expect(parseGithubUrl('https://gitlab.com/mi/app')).toBeNull()
    expect(parseGithubUrl('https://github.com/solo-usuario')).toBeNull()
    expect(parseGithubUrl('https://github.com/')).toBeNull()
    expect(parseGithubUrl('mi app')).toBeNull()
    expect(parseGithubUrl('https://mi-app.vercel.app')).toBeNull()
  })

  it('devuelve null ante nombres que intentan escaparse de la ruta', () => {
    expect(parseGithubUrl('https://github.com/../../etc')).toBeNull()
    expect(parseGithubUrl('https://github.com/mi/..')).toBeNull()
    expect(parseGithubUrl('https://github.com/mi/app%2F..%2F..')).toBeNull()
  })
})
