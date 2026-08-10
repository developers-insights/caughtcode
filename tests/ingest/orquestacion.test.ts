/**
 * La ingesta de punta a punta, sin la cola de por medio.
 *
 * `ingestar()` es el único lugar donde se junta todo lo que ya estaba suelto:
 * traer el archivo, abrirlo con el extractor endurecido, dejar afuera lo que no
 * es código del usuario y reconocer con qué está hecho el proyecto.
 *
 * Lo que se prueba:
 *
 *  1. **Un zip preparado para escribir fuera de la carpeta no escribe nada.** Es
 *     la defensa que no puede fallar nunca.
 *  2. Correrla dos veces sobre la misma corrida deja el código de la última, no
 *     una mezcla de las dos.
 *  3. Lo descartado se puede explicar: cada motivo tiene su texto en castellano.
 */

import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { zipSync } from 'fflate'

import { hayCodigoEnDisco, ingestar, rutaDelCodigo, traerArchivo } from '@/server/ingest'
import { PublicRepoError, setGithubFetch } from '@/server/ingest/github'
import { ZipRejectedError } from '@/server/ingest/zip'
import { bytes, zipConBasura, zipConPathTraversal, zipLimpio } from '../fixtures/zips'

let raiz: string
let anterior: string | undefined

beforeEach(async () => {
  raiz = await mkdtemp(path.join(tmpdir(), 'caughtcode-ingesta-'))
  anterior = process.env.CAUGHTCODE_STORAGE_DIR
  process.env.CAUGHTCODE_STORAGE_DIR = raiz
})

afterEach(async () => {
  setGithubFetch(null)
  if (anterior === undefined) delete process.env.CAUGHTCODE_STORAGE_DIR
  else process.env.CAUGHTCODE_STORAGE_DIR = anterior
  await rm(raiz, { recursive: true, force: true })
})

async function existe(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

describe('ingestar un proyecto', () => {
  it('deja el código en la carpeta de la corrida y dice con qué está hecho', async () => {
    const resultado = await ingestar({
      projectId: 'proyecto-1',
      runId: 'corrida-1',
      fuente: { tipo: 'archivo', bytes: zipLimpio() },
    })

    expect(resultado.codeDir).toBe(rutaDelCodigo('proyecto-1', 'corrida-1'))
    expect(resultado.archivos).toContain('package.json')
    expect(resultado.archivos).toContain('src/app/page.tsx')
    expect(resultado.fileCount).toBe(3)
    expect(resultado.totalBytes).toBeGreaterThan(0)
    expect(resultado.stack.framework).toBe('nextjs')
    expect(await hayCodigoEnDisco(resultado.codeDir)).toBe(true)
  })

  it('agrupa lo descartado con un motivo entendible', async () => {
    const resultado = await ingestar({
      projectId: 'proyecto-1',
      runId: 'corrida-1',
      fuente: { tipo: 'archivo', bytes: zipConBasura() },
    })

    expect(resultado.archivos).toEqual(['package.json', 'src/index.ts'])

    const motivos = resultado.descartes.map((d) => d.motivo)
    expect(motivos).toContain('dependencias')
    expect(motivos).toContain('compilado')

    for (const descarte of resultado.descartes) {
      expect(descarte.cantidad).toBeGreaterThan(0)
      expect(descarte.mensajePlain.length).toBeGreaterThan(10)
      // Lo lee el usuario: nada de jerga del extractor.
      expect(descarte.mensajePlain).not.toMatch(/zip|path|symlink|entry/i)
    }

    // Y lo descartado no quedó igual en el disco.
    expect(await existe(path.join(resultado.codeDir, 'node_modules'))).toBe(false)
  })

  it('un archivo preparado para escribir fuera de la carpeta no escribe nada', async () => {
    await expect(
      ingestar({
        projectId: 'proyecto-1',
        runId: 'corrida-1',
        fuente: { tipo: 'archivo', bytes: zipConPathTraversal() },
      }),
    ).rejects.toBeInstanceOf(ZipRejectedError)

    const codeDir = rutaDelCodigo('proyecto-1', 'corrida-1')
    expect(await readdir(codeDir)).toEqual([])
    // Nada por fuera de la carpeta del proyecto, tampoco.
    expect(await existe(path.join(raiz, 'etc'))).toBe(false)
    expect(await existe(path.join(raiz, '..', 'etc', 'perfil-comprometido'))).toBe(false)
  })

  it('correrla dos veces deja el código de la última, sin restos de la anterior', async () => {
    await ingestar({
      projectId: 'proyecto-1',
      runId: 'corrida-1',
      fuente: { tipo: 'archivo', bytes: zipLimpio() },
    })

    const otro = zipSync({ 'app/package.json': bytes('{"name":"otra"}') })
    const segunda = await ingestar({
      projectId: 'proyecto-1',
      runId: 'corrida-1',
      fuente: { tipo: 'archivo', bytes: otro },
    })

    expect(segunda.archivos).toEqual(['package.json'])
    expect(await existe(path.join(segunda.codeDir, 'src', 'app', 'page.tsx'))).toBe(false)
  })
})

describe('traer el archivo según de dónde venga', () => {
  it('baja el repositorio público a partir de la dirección pegada', async () => {
    const zip = zipLimpio()
    const pedidos: string[] = []
    setGithubFetch((async (entrada: string | URL | Request) => {
      pedidos.push(String(entrada))
      return new Response(zip as unknown as BodyInit, { status: 200 })
    }) as unknown as typeof fetch)

    const traido = await traerArchivo({
      tipo: 'github',
      url: 'https://github.com/mi/app/tree/main',
    })

    expect(traido.origen).toBe('github')
    expect(traido.repo).toEqual({ owner: 'mi', repo: 'app', ref: 'main' })
    expect(traido.bytes.byteLength).toBe(zip.byteLength)
    expect(pedidos[0]).toContain('/repos/mi/app/zipball/main')
  })

  it('una dirección que no es de GitHub se rechaza antes de salir a la red', async () => {
    let salioALaRed = false
    setGithubFetch((async () => {
      salioALaRed = true
      return new Response('', { status: 200 })
    }) as unknown as typeof fetch)

    await expect(
      traerArchivo({ tipo: 'github', url: 'https://mi-app.vercel.app' }),
    ).rejects.toBeInstanceOf(PublicRepoError)
    expect(salioALaRed).toBe(false)
  })
})
