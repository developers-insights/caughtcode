/**
 * Que el código esté en disco cuando hay que leerlo.
 *
 * El pipeline son trabajos encadenados y cada uno puede correr en otra
 * invocación. En producción la carpeta donde `ingest_repo` dejó el código vive
 * en `/tmp`, que no sobrevive: cuando `index_code` arrancaba, ya no estaba. Y no
 * fallaba nada — el índice salía con cero archivos, la revisión no encontraba
 * nada y la corrida terminaba "exitosa" con un informe en blanco.
 *
 * Lo que se prueba, en orden de importancia:
 *
 *  1. **Si la carpeta se evaporó, el código se trae de nuevo** de la copia que
 *     quedó guardada, y queda donde el análisis lo va a buscar.
 *  2. **Sin carpeta y sin copia se dice claro y no se insiste.** Es lo único
 *     honesto: no hay nada que revisar.
 *  3. **El camino feliz no gasta:** si el código ya está, no se baja nada.
 *  4. Una copia vacía no pasa por buena, que es la misma falla por otro camino.
 */

import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { zipSync } from 'fflate'

import { B, T } from '@/lib/db/tablas'
import { rutaDelCodigo } from '@/server/ingest'
import { asegurarCodigoEnDisco, type AlmacenRepos } from '@/server/ingest/rehidratar'
import { JobError } from '@/server/jobs/errors'

import { DbFalsa } from '../fixtures/checks/db-falsa'
import { zipLimpio } from '../fixtures/zips'

/* ── Dobles ───────────────────────────────────────────────────────────── */

const COPIA = 'org-1/proyecto-1/corridas/corrida-1/codigo.zip'

function almacenFalso(inicial: Record<string, Uint8Array> = {}): AlmacenRepos & {
  descargas: string[]
} {
  const objetos = new Map<string, Uint8Array>(Object.entries(inicial))
  const descargas: string[] = []
  return {
    descargas,
    async descargar(_bucket, ruta) {
      descargas.push(ruta)
      const bytes = objetos.get(ruta)
      if (!bytes) throw new Error(`no hay nada guardado en ${ruta}`)
      return bytes
    },
    async subir(_bucket, ruta, bytes) {
      objetos.set(ruta, bytes)
    },
  }
}

function baseCon(storagePath: string | null): DbFalsa {
  const db = new DbFalsa()
  db.sembrar(T.projects, [{ id: 'proyecto-1', org_id: 'org-1', storage_path: storagePath }])
  return db
}

let raiz: string
let anterior: string | undefined
let registro: string[]

beforeEach(async () => {
  raiz = await mkdtemp(path.join(tmpdir(), 'caughtcode-rehidratar-'))
  anterior = process.env.CAUGHTCODE_STORAGE_DIR
  process.env.CAUGHTCODE_STORAGE_DIR = raiz
  registro = []
})

afterEach(async () => {
  if (anterior === undefined) delete process.env.CAUGHTCODE_STORAGE_DIR
  else process.env.CAUGHTCODE_STORAGE_DIR = anterior
  await rm(raiz, { recursive: true, force: true })
})

const log = (mensaje: string): void => {
  registro.push(mensaje)
}

async function existe(destino: string): Promise<boolean> {
  try {
    await stat(destino)
    return true
  } catch {
    return false
  }
}

/* ── Tests ────────────────────────────────────────────────────────────── */

describe('asegurar que el código esté en disco', () => {
  it('lo trae de la copia guardada cuando la carpeta ya no existe', async () => {
    const db = baseCon(COPIA)
    const almacen = almacenFalso({ [COPIA]: zipLimpio() })
    const perdida = path.join(raiz, 'una-carpeta-que-se-borro', 'code')

    const resultado = await asegurarCodigoEnDisco({
      projectId: 'proyecto-1',
      analysisRunId: 'corrida-1',
      repoPath: perdida,
      log,
      almacen,
      db: async () => db,
    })

    expect(resultado.rehidratado).toBe(true)
    expect(almacen.descargas).toEqual([COPIA])

    // Quedó en la ruta canónica de la corrida, que es donde el análisis mira.
    expect(resultado.codeDir).toBe(rutaDelCodigo('proyecto-1', 'corrida-1'))
    expect(await existe(path.join(resultado.codeDir, 'package.json'))).toBe(true)
    expect(await existe(path.join(resultado.codeDir, 'src', 'app', 'page.tsx'))).toBe(true)
    expect(resultado.ingesta?.fileCount).toBe(3)

    // Y el usuario se entera de que hubo que traerlo, sin jerga.
    expect(registro.join(' ')).toMatch(/tu código/i)
    expect(registro.join(' ')).not.toMatch(/zip|storage|bucket|payload/i)
  })

  it('sin carpeta y sin copia lo dice claro y no insiste', async () => {
    const db = baseCon(null)
    const almacen = almacenFalso()

    let capturado: unknown
    try {
      await asegurarCodigoEnDisco({
        projectId: 'proyecto-1',
        analysisRunId: 'corrida-1',
        repoPath: path.join(raiz, 'nunca-existio'),
        log,
        almacen,
        db: async () => db,
      })
    } catch (error) {
      capturado = error
    }

    expect(capturado).toBeInstanceOf(JobError)
    const falla = capturado as JobError
    // Reintentar con el mismo estado daría exactamente lo mismo.
    expect(falla.retryable).toBe(false)
    expect(falla.message).toMatch(/volvé a lanzar la revisión/i)
    expect(falla.message).not.toMatch(/storage|bucket|path|null/i)
    expect(almacen.descargas).toEqual([])
  })

  it('si el código ya está, no baja nada', async () => {
    const db = baseCon(COPIA)
    const almacen = almacenFalso({ [COPIA]: zipLimpio() })
    const codeDir = rutaDelCodigo('proyecto-1', 'corrida-1')
    await mkdir(codeDir, { recursive: true })
    await writeFile(path.join(codeDir, 'package.json'), '{"name":"ya-estaba"}')

    const resultado = await asegurarCodigoEnDisco({
      projectId: 'proyecto-1',
      analysisRunId: 'corrida-1',
      repoPath: codeDir,
      log,
      almacen,
      db: async () => db,
    })

    expect(resultado.rehidratado).toBe(false)
    expect(resultado.codeDir).toBe(codeDir)
    expect(almacen.descargas).toEqual([])
    // Y no se pisó lo que ya estaba.
    expect(await existe(path.join(codeDir, 'package.json'))).toBe(true)
  })

  it('una carpeta vacía no cuenta como código: se rehidrata igual', async () => {
    const db = baseCon(COPIA)
    const almacen = almacenFalso({ [COPIA]: zipLimpio() })
    const codeDir = rutaDelCodigo('proyecto-1', 'corrida-1')
    await mkdir(codeDir, { recursive: true })

    const resultado = await asegurarCodigoEnDisco({
      projectId: 'proyecto-1',
      analysisRunId: 'corrida-1',
      repoPath: codeDir,
      log,
      almacen,
      db: async () => db,
    })

    expect(resultado.rehidratado).toBe(true)
    expect(almacen.descargas).toEqual([COPIA])
  })

  /**
   * El extractor ya rechaza el comprimido sin nada adentro con su propio texto,
   * escrito para el usuario. Lo que importa acá es que esa negativa llegue a la
   * cola como tal —sin reintento y sin jerga— en vez de terminar en una carpeta
   * vacía que después se lee como "no encontramos nada".
   */
  it('una copia vacía no pasa por buena', async () => {
    const db = baseCon(COPIA)
    const almacen = almacenFalso({ [COPIA]: zipSync({}) })

    let capturado: unknown
    try {
      await asegurarCodigoEnDisco({
        projectId: 'proyecto-1',
        analysisRunId: 'corrida-1',
        repoPath: path.join(raiz, 'nunca-existio'),
        log,
        almacen,
        db: async () => db,
      })
    } catch (error) {
      capturado = error
    }

    expect(capturado).toBeInstanceOf(JobError)
    const falla = capturado as JobError
    expect(falla.retryable).toBe(false)
    expect(falla.message).not.toMatch(/zip|buffer|entry|null/i)
  })

  it('usa el bucket de repos, nunca otro', async () => {
    const db = baseCon(COPIA)
    const buckets: string[] = []
    const almacen: AlmacenRepos = {
      async descargar(bucket, ruta) {
        buckets.push(bucket)
        expect(ruta).toBe(COPIA)
        return zipLimpio()
      },
      async subir() {},
    }

    await asegurarCodigoEnDisco({
      projectId: 'proyecto-1',
      analysisRunId: 'corrida-1',
      repoPath: path.join(raiz, 'nunca-existio'),
      log,
      almacen,
      db: async () => db,
    })

    expect(buckets).toEqual([B.repos])
  })

  it('el error de la base no llega crudo a la pantalla', async () => {
    const db = baseCon(COPIA)
    db.fallaEn = { tabla: T.projects, operacion: 'select' }

    let capturado: unknown
    try {
      await asegurarCodigoEnDisco({
        projectId: 'proyecto-1',
        analysisRunId: 'corrida-1',
        repoPath: path.join(raiz, 'nunca-existio'),
        log,
        almacen: almacenFalso({ [COPIA]: zipLimpio() }),
        db: async () => db,
      })
    } catch (error) {
      capturado = error
    }

    const falla = capturado as JobError
    expect(falla.retryable).toBe(true)
    // El texto de PostgREST queda en el log del worker, no en `jobs.last_error`.
    expect(falla.message).not.toMatch(/rechazó|select|postgrest|column/i)
    expect(registro.join(' ')).toMatch(/rechazó el select/)
  })
})

/* ── Aislamiento entre inquilinos ─────────────────────────────────────── */

/**
 * Las dos entradas que este módulo recibe de afuera son la carpeta del payload y
 * la ruta guardada en `projects_caughtcode.storage_path`. Ninguna de las dos es
 * confiable:
 *
 *  - `storage_path` es una columna que **cualquier miembro** de la organización
 *    puede escribir por PostgREST (la policy de update no la protege y la tabla
 *    no tiene trigger guarda), y el descargador corre con `service_role`, que
 *    ignora las políticas del bucket. Apuntándola al .zip de otra empresa, el
 *    worker se lo bajaba, lo descomprimía en el workspace propio y publicaba
 *    hallazgos con fragmentos de código ajeno.
 *  - `repoPath` viaja en el payload y hoy lo escribe siempre el servidor, pero en
 *    el worker largo de Render conviven en disco los workspaces de varios
 *    inquilinos: es la única pieza de la cadena que no se validaba.
 */
describe('nunca se abre código de otro inquilino', () => {
  const AJENA_OTRA_ORG = 'org-2/proyecto-9/corridas/corrida-9/codigo.zip'
  const AJENA_MISMO_ORG = 'org-1/proyecto-9/corridas/corrida-9/codigo.zip'
  const CON_SALTO = 'org-1/proyecto-1/../../org-2/proyecto-9/codigo.zip'

  for (const [caso, ruta] of [
    ['apunta a otra organización', AJENA_OTRA_ORG],
    ['apunta a otro proyecto', AJENA_MISMO_ORG],
    ['se escapa del prefijo con ..', CON_SALTO],
  ] as const) {
    it(`no baja la copia guardada si ${caso}`, async () => {
      const db = baseCon(ruta)
      const almacen = almacenFalso({ [ruta]: zipLimpio() })

      let capturado: unknown
      try {
        await asegurarCodigoEnDisco({
          projectId: 'proyecto-1',
          analysisRunId: 'corrida-1',
          repoPath: path.join(raiz, 'nunca-existio'),
          log,
          almacen,
          db: async () => db,
        })
      } catch (error) {
        capturado = error
      }

      // Lo único que importa de verdad: no se tocó el bucket.
      expect(almacen.descargas, 'bajó un archivo que no es de este proyecto').toEqual([])

      const falla = capturado as JobError
      expect(falla).toBeInstanceOf(JobError)
      // Se trata como "no hay copia": acá no hay otro origen al que caer, y
      // volver a lanzar la revisión reescribe `storage_path` con una ruta
      // canónica. El cliente con una ruta histórica rara queda a un click, no
      // sin servicio.
      expect(falla.code).toBe('sin_copia_guardada')
      expect(falla.retryable).toBe(false)
      expect(falla.message).toMatch(/volvé a lanzar la revisión/i)
      // Y el mensaje no le cuenta a nadie qué ruta había ni de quién era.
      expect(falla.message).not.toMatch(/org-2|proyecto-9|codigo\.zip/)
    })
  }

  it('ignora una carpeta del payload que no es de este proyecto y trae la propia', async () => {
    const db = baseCon(COPIA)
    const almacen = almacenFalso({ [COPIA]: zipLimpio() })

    // El workspace de otro inquilino, con código adentro, en el mismo disco del
    // worker largo. Antes bastaba con que existiera para que se analizara.
    const ajena = path.join(raiz, 'otro-inquilino', 'code')
    await mkdir(ajena, { recursive: true })
    await writeFile(path.join(ajena, 'secreto-de-otro.ts'), 'export const clave = "no mires"\n')

    const resultado = await asegurarCodigoEnDisco({
      projectId: 'proyecto-1',
      analysisRunId: 'corrida-1',
      repoPath: ajena,
      log,
      almacen,
      db: async () => db,
    })

    expect(resultado.codeDir, 'analizó la carpeta de otro').toBe(
      rutaDelCodigo('proyecto-1', 'corrida-1'),
    )
    expect(resultado.rehidratado).toBe(true)
    expect(almacen.descargas).toEqual([COPIA])
    expect(await existe(path.join(resultado.codeDir, 'secreto-de-otro.ts'))).toBe(false)
    expect(await existe(path.join(resultado.codeDir, 'package.json'))).toBe(true)
  })

  /**
   * El contrapeso: endurecer no puede volverse una traba. Una subcarpeta del
   * workspace del proyecto —el caso normal— pasa sin bajar nada.
   */
  it('una carpeta que sí cuelga del proyecto se acepta tal cual', async () => {
    const db = baseCon(COPIA)
    const almacen = almacenFalso({ [COPIA]: zipLimpio() })
    const propia = rutaDelCodigo('proyecto-1', 'otra-corrida')
    await mkdir(propia, { recursive: true })
    await writeFile(path.join(propia, 'package.json'), '{"name":"ya-estaba"}')

    const resultado = await asegurarCodigoEnDisco({
      projectId: 'proyecto-1',
      analysisRunId: 'corrida-1',
      repoPath: propia,
      log,
      almacen,
      db: async () => db,
    })

    expect(resultado.codeDir).toBe(propia)
    expect(resultado.rehidratado).toBe(false)
    expect(almacen.descargas).toEqual([])
  })
})
