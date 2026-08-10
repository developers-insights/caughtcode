/**
 * Bajar un repositorio público sin instalar la app de GitHub.
 *
 * Es el camino que hace que se pueda probar el producto hoy: sin credenciales,
 * pegando la dirección del repositorio y nada más.
 *
 * Lo que se prueba, en orden de importancia:
 *
 *  1. **Cada falla tiene una causa clasificada.** La UI elige el texto por el
 *     `code`; si acá devolvemos siempre lo mismo, el usuario lee un mensaje que
 *     no corresponde a lo que le pasó.
 *  2. **Nunca un 404 crudo.** El `message` es para el log; el usuario ve el copy.
 *  3. **Los límites de tamaño se aplican antes de bajar el cuerpo**, no después
 *     de comernos 2 GB de memoria.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { INGEST_LIMITS } from '@/server/ingest/filters'
import {
  PublicRepoError,
  downloadPublicRepoArchive,
  setGithubFetch,
} from '@/server/ingest/github'

/* ── Ayudas ───────────────────────────────────────────────────────────── */

interface Llamada {
  url: string
}

/** `fetch` de mentira: responde por patrón de URL y registra qué se pidió. */
function fetchFalso(rutas: Array<[RegExp, () => Response]>): {
  impl: typeof fetch
  llamadas: Llamada[]
} {
  const llamadas: Llamada[] = []
  const impl = (async (entrada: string | URL | Request) => {
    const url = String(entrada)
    llamadas.push({ url })
    for (const [patron, responder] of rutas) {
      if (patron.test(url)) return responder()
    }
    return new Response('no encontrado', { status: 404 })
  }) as unknown as typeof fetch
  return { impl, llamadas }
}

const ZIP_FALSO = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])

function ok(bytes: Uint8Array = ZIP_FALSO): Response {
  return new Response(bytes as unknown as BodyInit, {
    status: 200,
    headers: { 'content-length': String(bytes.byteLength) },
  })
}

async function capturar(promesa: Promise<unknown>): Promise<PublicRepoError> {
  let capturado: unknown
  try {
    await promesa
  } catch (error) {
    capturado = error
  }
  expect(capturado).toBeInstanceOf(PublicRepoError)
  return capturado as PublicRepoError
}

afterEach(() => {
  setGithubFetch(null)
})

/* ── Tests ────────────────────────────────────────────────────────────── */

describe('bajar un repositorio público', () => {
  it('trae el código y lo devuelve tal cual', async () => {
    const { impl, llamadas } = fetchFalso([[/zipball/, () => ok()]])
    setGithubFetch(impl)

    const bytes = await downloadPublicRepoArchive({ owner: 'mi', repo: 'app' })

    expect(Array.from(bytes)).toEqual(Array.from(ZIP_FALSO))
    expect(llamadas[0].url).toBe('https://api.github.com/repos/mi/app/zipball')
  })

  it('pide la rama cuando la dirección la traía', async () => {
    const { impl, llamadas } = fetchFalso([[/zipball/, () => ok()]])
    setGithubFetch(impl)

    await downloadPublicRepoArchive({ owner: 'mi', repo: 'app', ref: 'feature/pantalla nueva' })

    expect(llamadas[0].url).toBe(
      'https://api.github.com/repos/mi/app/zipball/feature/pantalla%20nueva',
    )
  })

  it('no manda ninguna credencial: es una consulta anónima', async () => {
    let headers: Headers | null = null
    const impl = (async (_entrada: unknown, init?: RequestInit) => {
      headers = new Headers(init?.headers)
      return ok()
    }) as unknown as typeof fetch
    setGithubFetch(impl)

    await downloadPublicRepoArchive({ owner: 'mi', repo: 'app' })

    expect(headers).not.toBeNull()
    expect((headers as unknown as Headers).get('authorization')).toBeNull()
  })

  it('si el repositorio no aparece pero la cuenta existe, la causa es de permisos', async () => {
    const { impl } = fetchFalso([
      [/zipball/, () => new Response('{"message":"Not Found"}', { status: 404 })],
      [/\/users\//, () => new Response('{"login":"mi"}', { status: 200 })],
    ])
    setGithubFetch(impl)

    const error = await capturar(downloadPublicRepoArchive({ owner: 'mi', repo: 'app' }))

    expect(error.code).toBe('privado')
    // El texto del error es para el log del worker, no para la pantalla.
    expect(error.message).toMatch(/404/)
  })

  it('si tampoco existe la cuenta, la dirección está mal', async () => {
    const { impl } = fetchFalso([
      [/zipball/, () => new Response('{"message":"Not Found"}', { status: 404 })],
      [/\/users\//, () => new Response('{"message":"Not Found"}', { status: 404 })],
      [/\/orgs\//, () => new Response('{"message":"Not Found"}', { status: 404 })],
    ])
    setGithubFetch(impl)

    const error = await capturar(downloadPublicRepoArchive({ owner: 'nadie', repo: 'app' }))

    expect(error.code).toBe('no_existe')
  })

  it('reconoce cuando GitHub nos frena por consultar de más', async () => {
    const { impl } = fetchFalso([
      [
        /zipball/,
        () =>
          new Response('{"message":"API rate limit exceeded"}', {
            status: 403,
            headers: { 'x-ratelimit-remaining': '0' },
          }),
      ],
    ])
    setGithubFetch(impl)

    const error = await capturar(downloadPublicRepoArchive({ owner: 'mi', repo: 'app' }))
    expect(error.code).toBe('demasiados_intentos')
  })

  it('también reconoce el 429', async () => {
    const { impl } = fetchFalso([[/zipball/, () => new Response('', { status: 429 })]])
    setGithubFetch(impl)

    const error = await capturar(downloadPublicRepoArchive({ owner: 'mi', repo: 'app' }))
    expect(error.code).toBe('demasiados_intentos')
  })

  it('corta antes de bajar nada si el repositorio pesa más de lo permitido', async () => {
    let cuerpoLeido = false
    const impl = (async () => {
      const response = new Response('x', {
        status: 200,
        headers: { 'content-length': String(INGEST_LIMITS.maxArchiveBytes + 1) },
      })
      const original = response.arrayBuffer.bind(response)
      response.arrayBuffer = async () => {
        cuerpoLeido = true
        return original()
      }
      return response
    }) as unknown as typeof fetch
    setGithubFetch(impl)

    const error = await capturar(downloadPublicRepoArchive({ owner: 'mi', repo: 'app' }))

    expect(error.code).toBe('demasiado_grande')
    expect(cuerpoLeido).toBe(false)
  })

  it('corta igual si el tamaño declarado mentía', async () => {
    const gordo = new Uint8Array(1024)
    setGithubFetch((async () =>
      new Response(gordo as unknown as BodyInit, { status: 200 })) as unknown as typeof fetch)

    const error = await capturar(
      downloadPublicRepoArchive({ owner: 'mi', repo: 'app' }, { maxBytes: 100 }),
    )
    expect(error.code).toBe('demasiado_grande')
  })

  it('un problema de red es un problema de red, no "no existe"', async () => {
    setGithubFetch((async () => {
      throw new Error('getaddrinfo ENOTFOUND api.github.com')
    }) as unknown as typeof fetch)

    const error = await capturar(downloadPublicRepoArchive({ owner: 'mi', repo: 'app' }))
    expect(error.code).toBe('red')
  })

  it('un error del lado de GitHub tampoco es "no existe"', async () => {
    const { impl } = fetchFalso([[/zipball/, () => new Response('', { status: 502 })]])
    setGithubFetch(impl)

    const error = await capturar(downloadPublicRepoArchive({ owner: 'mi', repo: 'app' }))
    expect(error.code).toBe('red')
  })
})
