/**
 * Las conclusiones se muestran tal cual al usuario y se narran en el video.
 * Si acá se cuela jerga, el producto pierde lo único que lo diferencia.
 */

import { describe, expect, it } from 'vitest'

import { detectarJerga } from '@/content/lenguaje'
import { conclusions, conDesbordeMovil, listPlaces } from '@/server/agent/tasks/conclusions'

/** Genera una muestra de cada conclusión con datos de ejemplo. */
function todasLasConclusiones(): Array<{ nombre: string; texto: string }> {
  const lugares = ['los ajustes', 'el perfil', 'la pantalla de cuenta']
  const url = 'https://mi-app.example'

  return [
    ['appNoResponde', conclusions.appNoResponde(url)],
    ['appPideEntrar', conclusions.appPideEntrar()],
    ['appDetrasDeMuro', conclusions.appDetrasDeMuro()],
    ['sinPermiso', conclusions.sinPermiso('crear una cuenta')],
    ['seCortoPorCosto', conclusions.seCortoPorCosto()],
    ['errorInesperado', conclusions.errorInesperado()],
    ['signupSinConfirmacion', conclusions.signupSinConfirmacion()],
    ['signupPideConfirmar', conclusions.signupPideConfirmar()],
    ['signupNoEncontrado', conclusions.signupNoEncontrado(lugares)],
    ['signupFallo', conclusions.signupFallo()],
    ['loginOk', conclusions.loginOk()],
    ['loginRechazado', conclusions.loginRechazado()],
    ['loginNoEncontrado', conclusions.loginNoEncontrado(lugares)],
    ['logoutOk', conclusions.logoutOk()],
    ['logoutNoEncontrado', conclusions.logoutNoEncontrado(lugares)],
    ['passwordResetFaltante', conclusions.passwordResetFaltante(lugares)],
    ['passwordResetOk', conclusions.passwordResetOk()],
    ['passwordResetIncompleto', conclusions.passwordResetIncompleto()],
    ['deleteAccountFaltante', conclusions.deleteAccountFaltante(lugares)],
    ['deleteAccountEncontrado', conclusions.deleteAccountEncontrado('los ajustes')],
    ['editProfileOk', conclusions.editProfileOk()],
    ['editProfileNoGuarda', conclusions.editProfileNoGuarda()],
    ['editProfileNoEncontrado', conclusions.editProfileNoEncontrado(lugares)],
    ['crossTenantExpuesto', conclusions.crossTenantExpuesto('/factura/2', 'una pantalla titulada "Factura 2"')],
    ['crossTenantIdMutado', conclusions.crossTenantIdMutado('/factura/1', '/factura/2', 'los datos de otra persona')],
    ['crossTenantProtegido', conclusions.crossTenantProtegido('/factura/2')],
    ['crossTenantSinDatos', conclusions.crossTenantSinDatos()],
    ['primaryFlowOk', conclusions.primaryFlowOk('Llegué al listado.')],
    ['primaryFlowTrabado', conclusions.primaryFlowTrabado('Me quedé en el formulario.')],
    ['cookiesAntesDeAceptar', conclusions.cookiesAntesDeAceptar(2, ['Google Analytics', 'Meta Pixel'])],
    ['cookiesOk', conclusions.cookiesOk()],
    ['cookiesSinCartel', conclusions.cookiesSinCartel(1, ['Google Analytics'])],
    ['cookiesSinRastreadores', conclusions.cookiesSinRastreadores()],
    ['legalesCompletos', conclusions.legalesCompletos()],
    ['legalesFaltaUno', conclusions.legalesFaltaUno('términos', 'privacidad')],
    ['legalesFaltanAmbas', conclusions.legalesFaltanAmbas(lugares)],
  ].map(([nombre, texto]) => ({ nombre: nombre as string, texto: texto as string }))
}

describe('conclusiones que lee el usuario', () => {
  it('no usan ningún término prohibido', () => {
    const conJerga = todasLasConclusiones()
      .map(({ nombre, texto }) => ({ nombre, jerga: detectarJerga(texto) }))
      .filter(({ jerga }) => jerga.length > 0)

    expect(conJerga).toEqual([])
  })

  it('están escritas en primera persona y terminan en punto', () => {
    for (const { nombre, texto } of todasLasConclusiones()) {
      expect(texto.trim().endsWith('.'), `${nombre} no termina en punto`).toBe(true)
      expect(texto.length, `${nombre} es demasiado corta`).toBeGreaterThan(30)
      expect(texto.length, `${nombre} es demasiado larga para narrar`).toBeLessThan(340)
    }
  })

  it('las de "no encontré" siempre dicen dónde se buscó', () => {
    const lugares = ['los ajustes', 'el perfil']
    for (const texto of [
      conclusions.deleteAccountFaltante(lugares),
      conclusions.passwordResetFaltante(lugares),
      conclusions.logoutNoEncontrado(lugares),
      conclusions.signupNoEncontrado(lugares),
    ]) {
      expect(texto).toContain('los ajustes')
      expect(texto).toContain('el perfil')
    }
  })

  it('arma listas en prosa', () => {
    expect(listPlaces(['los ajustes'])).toBe('los ajustes')
    expect(listPlaces(['los ajustes', 'el perfil'])).toBe('los ajustes y el perfil')
    expect(listPlaces(['a', 'b', 'c'])).toBe('a, b y c')
  })

  it('suma el desborde en el teléfono solo si lo hubo', () => {
    const base = 'Hice el recorrido.'
    expect(conDesbordeMovil(base, [])).toBe(base)
    const conDesborde = conDesbordeMovil(base, ['una tabla que empieza con "Número"'])
    expect(conDesborde).toContain('teléfono')
    expect(detectarJerga(conDesborde)).toEqual([])
  })
})
