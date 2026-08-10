/**
 * Una instalación de la GitHub App pertenece a UNA organización.
 *
 * Este archivo existe por un agujero concreto, no por completitud:
 * `listInstallations()` devolvía todas las instalaciones de la GitHub App —GitHub
 * contesta a nivel App, no sabe de nuestras organizaciones— y esa lista alimentaba
 * el asistente de "proyecto nuevo". Con una sola cuenta registrada no se notaba.
 * Con dos, la segunda persona veía en su desplegable las cuentas de la primera y
 * podía listar y auditar sus repositorios privados.
 *
 * Es, palabra por palabra, el hallazgo que este producto busca en apps ajenas.
 *
 * Lo que se prueba, en orden de importancia:
 *
 *  1. **Desde otra organización no se ve nada.** El agujero.
 *  2. **Un compañero de la MISMA organización sí ve la instalación.** Es el
 *     requisito explícito del producto: el acceso es por equipo, no por persona.
 *     Sin este test, "arreglar" el agujero cerrando de más pasaría inadvertido.
 *  3. **Un `installationId` ajeno se rechaza aunque llegue a mano.** El filtro del
 *     desplegable es cosmético: el pedido se arma como uno quiera.
 *  4. **Una instalación ya atada no se roba** volviendo a pasar por la ruta.
 *  5. Al `installation_id` de la barra de direcciones no se le cree: primero se
 *     lo verifica contra GitHub.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  bindInstallationToOrg,
  decodeInstallState,
  encodeInstallState,
  githubStatus,
  findOrgInstallationForOwner,
  installationBelongsToOrg,
  listOrgInstallations,
  setInstallationsApi,
  setInstallationsRegistry,
  type GithubInstallation,
  type InstallationsApi,
  type InstallationsRegistry,
  type OrgInstallation,
} from '@/server/ingest/github'

/* ── Dobles ───────────────────────────────────────────────────────────── */

const ORG_PROPIA = '99bc0b30-1401-4891-bc2d-1f7e74c2bf1b'
const ORG_AJENA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

/** La instalación real que hay en producción hoy, con sus valores de verdad. */
const INSTALACION: GithubInstallation = {
  id: 152524864,
  accountLogin: 'developers-insights',
  accountType: 'User',
  accountId: 305118073,
  allRepositories: true,
}

function apiFalsa(vivas: GithubInstallation[] = [INSTALACION]): InstallationsApi {
  return {
    async listar() {
      return vivas
    },
    async obtener(id) {
      return vivas.find((i) => i.id === id) ?? null
    },
  }
}

function registroFalso(inicial: OrgInstallation[] = []): InstallationsRegistry & {
  filas: Map<number, OrgInstallation>
} {
  const filas = new Map(inicial.map((fila) => [fila.installationId, fila]))
  return {
    filas,
    async listarPorOrg(orgId) {
      return [...filas.values()].filter((fila) => fila.orgId === orgId)
    },
    async buscar(installationId) {
      return filas.get(installationId) ?? null
    },
    async guardar(fila) {
      const previa = filas.get(fila.installationId)
      // El registro real tiene `installation_id` como clave primaria: una
      // instalación no puede quedar atada a dos organizaciones. El doble tiene
      // que comportarse igual o los tests probarían un mundo que no existe.
      if (previa && previa.orgId !== fila.orgId) {
        throw new Error('unique_violation: la instalación ya está atada a otra organización')
      }
      filas.set(fila.installationId, fila)
    },
  }
}

function atada(orgId: string): OrgInstallation {
  return {
    installationId: INSTALACION.id,
    orgId,
    accountLogin: INSTALACION.accountLogin,
    accountType: INSTALACION.accountType,
    accountId: INSTALACION.accountId,
    allRepositories: INSTALACION.allRepositories,
  }
}

beforeAll(() => {
  // El testigo va cifrado con la clave del servidor. En los tests alcanza con una
  // cualquiera: lo que se prueba es que sin ella no se puede fabricar uno.
  process.env.ENCRYPTION_KEY ??= 'clave-de-prueba-para-los-tests-de-caughtcode'
  process.env.GITHUB_APP_SLUG ??= 'caughtcode-pruebas'
})

afterEach(() => {
  setInstallationsApi(null)
  setInstallationsRegistry(null)
})

/* ── 1 · El agujero ───────────────────────────────────────────────────── */

describe('aislamiento entre organizaciones', () => {
  it('desde otra organización no se ve la instalación ajena', async () => {
    setInstallationsApi(apiFalsa())
    setInstallationsRegistry(registroFalso([atada(ORG_PROPIA)]))

    expect(await listOrgInstallations(ORG_AJENA)).toEqual([])
  })

  it('quien la conectó sí la ve', async () => {
    setInstallationsApi(apiFalsa())
    setInstallationsRegistry(registroFalso([atada(ORG_PROPIA)]))

    const vistas = await listOrgInstallations(ORG_PROPIA)
    expect(vistas.map((i) => i.id)).toEqual([INSTALACION.id])
    expect(vistas[0]!.accountLogin).toBe('developers-insights')
  })

  it('todo el equipo de esa organización la ve: el acceso es por equipo, no por persona', async () => {
    // No hay `userId` en ninguna de estas funciones a propósito. Que el modelo no
    // tenga por dónde filtrar por persona es la garantía: no depende de acordarse.
    setInstallationsApi(apiFalsa())
    setInstallationsRegistry(registroFalso([atada(ORG_PROPIA)]))

    const desdeQuienInstalo = await listOrgInstallations(ORG_PROPIA)
    const desdeUnCompanero = await listOrgInstallations(ORG_PROPIA)
    expect(desdeUnCompanero).toEqual(desdeQuienInstalo)
    expect(desdeUnCompanero).toHaveLength(1)
  })

  it('una instalación que el usuario desinstaló en GitHub deja de aparecer sola', async () => {
    // Sin esperar ningún webhook: si GitHub no la lista, no está viva.
    setInstallationsApi(apiFalsa([]))
    setInstallationsRegistry(registroFalso([atada(ORG_PROPIA)]))

    expect(await listOrgInstallations(ORG_PROPIA)).toEqual([])
  })

  it('una fila plantada en la tabla no sirve si GitHub no la conoce', async () => {
    setInstallationsApi(apiFalsa([INSTALACION]))
    setInstallationsRegistry(
      registroFalso([atada(ORG_PROPIA), { ...atada(ORG_PROPIA), installationId: 999999 }]),
    )

    const vistas = await listOrgInstallations(ORG_PROPIA)
    expect(vistas.map((i) => i.id)).toEqual([INSTALACION.id])
  })
})

/* ── 2 · La otra puerta: entrar por el nombre de la cuenta ────────────── */

describe('buscar la instalación por cuenta dueña del repositorio', () => {
  it('no presta la instalación de otra organización aunque la cuenta coincida', async () => {
    // Este es el camino del worker: "necesito entrar a developers-insights/algo".
    // Buscar por nombre de cuenta en la lista global devuelve la instalación
    // ajena. El cruce tiene que arrancar por la organización.
    setInstallationsApi(apiFalsa())
    setInstallationsRegistry(registroFalso([atada(ORG_PROPIA)]))

    expect(await findOrgInstallationForOwner(ORG_AJENA, 'developers-insights')).toBeNull()
  })

  it('sí la encuentra para su propia organización, sin importar mayúsculas', async () => {
    setInstallationsApi(apiFalsa())
    setInstallationsRegistry(registroFalso([atada(ORG_PROPIA)]))

    const hallada = await findOrgInstallationForOwner(ORG_PROPIA, 'Developers-Insights')
    expect(hallada?.id).toBe(INSTALACION.id)
  })

  it('devuelve null si esa organización no conectó esa cuenta', async () => {
    setInstallationsApi(apiFalsa())
    setInstallationsRegistry(registroFalso([atada(ORG_PROPIA)]))

    expect(await findOrgInstallationForOwner(ORG_PROPIA, 'otra-cuenta')).toBeNull()
    expect(await findOrgInstallationForOwner(ORG_PROPIA, '  ')).toBeNull()
  })
})

/* ── 3 · El id que llega del cliente ──────────────────────────────────── */

describe('un installationId del navegador no se acepta por venir', () => {
  it('rechaza el id de una instalación de otra organización', async () => {
    setInstallationsApi(apiFalsa())
    setInstallationsRegistry(registroFalso([atada(ORG_PROPIA)]))

    expect(await installationBelongsToOrg(INSTALACION.id, ORG_AJENA)).toBe(false)
  })

  it('acepta el id de la propia', async () => {
    setInstallationsApi(apiFalsa())
    setInstallationsRegistry(registroFalso([atada(ORG_PROPIA)]))

    expect(await installationBelongsToOrg(INSTALACION.id, ORG_PROPIA)).toBe(true)
  })

  it('rechaza una instalación que nunca se ató, aunque exista en GitHub', async () => {
    setInstallationsApi(apiFalsa())
    setInstallationsRegistry(registroFalso([]))

    expect(await installationBelongsToOrg(INSTALACION.id, ORG_PROPIA)).toBe(false)
  })

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2])(
    'rechaza %p sin siquiera consultar',
    async (valor) => {
      setInstallationsApi(apiFalsa())
      setInstallationsRegistry({
        async listarPorOrg() {
          return []
        },
        async buscar() {
          throw new Error('no debería consultarse con un id que no es un id')
        },
        async guardar() {
          throw new Error('no debería guardarse nada')
        },
      })

      expect(await installationBelongsToOrg(valor as number, ORG_PROPIA)).toBe(false)
    },
  )
})

/* ── 4 · Atar la instalación ──────────────────────────────────────────── */

describe('atar una instalación a una organización', () => {
  it('la ata cuando GitHub la reconoce y nadie la reclamó antes', async () => {
    const registro = registroFalso([])
    setInstallationsApi(apiFalsa())
    setInstallationsRegistry(registro)

    const resultado = await bindInstallationToOrg({
      installationId: INSTALACION.id,
      orgId: ORG_PROPIA,
      userId: '5d5ab7e8-04af-4329-8971-a43a0c429720',
    })

    expect(resultado).toMatchObject({ ok: true, yaEstaba: false })
    expect(registro.filas.get(INSTALACION.id)).toMatchObject({
      orgId: ORG_PROPIA,
      accountLogin: 'developers-insights',
      // Los datos de la cuenta salen de GitHub, no de lo que mandó el navegador.
      accountId: 305118073,
      allRepositories: true,
    })
  })

  it('no ata nada si GitHub no conoce esa instalación', async () => {
    const registro = registroFalso([])
    setInstallationsApi(apiFalsa([]))
    setInstallationsRegistry(registro)

    const resultado = await bindInstallationToOrg({ installationId: 42, orgId: ORG_PROPIA })

    expect(resultado).toEqual({ ok: false, motivo: 'no_existe' })
    expect(registro.filas.size).toBe(0)
  })

  it('no se puede robar una instalación ya atada a otra organización', async () => {
    const registro = registroFalso([atada(ORG_PROPIA)])
    setInstallationsApi(apiFalsa())
    setInstallationsRegistry(registro)

    const resultado = await bindInstallationToOrg({
      installationId: INSTALACION.id,
      orgId: ORG_AJENA,
    })

    expect(resultado).toEqual({ ok: false, motivo: 'de_otra_organizacion' })
    expect(registro.filas.get(INSTALACION.id)!.orgId).toBe(ORG_PROPIA)
    // Y sigue visible para su dueña, no quedó a medio camino.
    expect(await listOrgInstallations(ORG_PROPIA)).toHaveLength(1)
  })

  it('volver a pasar por la ruta con la propia instalación la refresca, no la duplica', async () => {
    const registro = registroFalso([{ ...atada(ORG_PROPIA), accountLogin: 'nombre-viejo' }])
    setInstallationsApi(apiFalsa())
    setInstallationsRegistry(registro)

    const resultado = await bindInstallationToOrg({
      installationId: INSTALACION.id,
      orgId: ORG_PROPIA,
    })

    expect(resultado).toMatchObject({ ok: true, yaEstaba: true })
    expect(registro.filas.size).toBe(1)
    expect(registro.filas.get(INSTALACION.id)!.accountLogin).toBe('developers-insights')
  })

  it('el testigo del enlace no reemplaza a la sesión, pero no se puede falsificar', () => {
    const testigo = encodeInstallState(ORG_PROPIA)

    expect(decodeInstallState(testigo)).toBe(ORG_PROPIA)
    // Nadie puede escribir uno a mano sin la clave del servidor.
    expect(decodeInstallState('yo.lo.invente')).toBeNull()
    expect(decodeInstallState('')).toBeNull()
    // Y caduca: un enlace viejo que quedó en un chat no sirve para siempre.
    expect(decodeInstallState(testigo, Date.now() + 3 * 60 * 60 * 1000)).toBeNull()
  })

  it('el enlace de instalación lleva el testigo, y no se rompe si no hay slug', () => {
    const url = githubStatus({ state: encodeInstallState(ORG_PROPIA) }).installUrl
    expect(url).toContain('/installations/new?state=')

    const devuelto = new URL(url!).searchParams.get('state')
    expect(decodeInstallState(devuelto!)).toBe(ORG_PROPIA)

    expect(githubStatus().installUrl).not.toContain('state=')
  })

  it('un id que no es un id se rechaza sin salir a GitHub', async () => {
    setInstallationsApi({
      async listar() {
        return []
      },
      async obtener() {
        throw new Error('no debería preguntarse a GitHub por un id inválido')
      },
    })
    setInstallationsRegistry(registroFalso([]))

    expect(await bindInstallationToOrg({ installationId: -7, orgId: ORG_PROPIA })).toEqual({
      ok: false,
      motivo: 'no_existe',
    })
  })
})
