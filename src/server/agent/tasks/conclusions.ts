/**
 * Las conclusiones que lee el usuario.
 *
 * Este texto va directo a la pantalla y a la narración del video, así que es
 * producto, no logs. Reglas: primera persona, pasado, una idea por frase, cero
 * jerga, y siempre decir DÓNDE se buscó. "No lo encontré" sin decir dónde buscaste
 * no es evidencia, es una opinión.
 *
 * Están todas juntas y son deterministas a propósito: el modelo conduce el navegador,
 * pero no escribe lo que el usuario lee. Así el texto se puede revisar y testear.
 *
 * Lo usan: `src/server/agent/tasks/**` y `tests/agent/conclusions.test.ts`.
 */

import 'server-only'

/** Lista en prosa: "ajustes, perfil y cuenta". */
export function listPlaces(places: string[]): string {
  const clean = places.filter((place) => place.trim().length > 0)
  if (clean.length === 0) return ''
  if (clean.length === 1) return clean[0]
  return `${clean.slice(0, -1).join(', ')} y ${clean[clean.length - 1]}`
}

export const conclusions = {
  /* ── Casos generales ──────────────────────────────────────────────── */

  appNoResponde: (url: string) =>
    `No pude abrir tu app. La dirección ${url} no respondió, así que no llegué a probar nada.`,

  appPideEntrar: () =>
    'Tu app me llevó directo a la pantalla de ingreso y no tengo una cuenta autorizada para entrar, ' +
    'así que hasta acá pude llegar.',

  appDetrasDeMuro: () =>
    'Tu app me pidió pagar para seguir. Frené ahí: no uso medios de pago de verdad.',

  sinPermiso: (accion: string) =>
    `No probé ${accion} porque toca datos de verdad en tu app y todavía no me diste el visto bueno.`,

  seCortoPorCosto: () =>
    'Corté la prueba antes de terminar porque llegué al límite de gasto que fijamos para esta revisión.',

  errorInesperado: () =>
    'La prueba se cortó por un problema técnico de mi lado. No es un hallazgo sobre tu app: hay que repetirla.',

  /* ── Registro ─────────────────────────────────────────────────────── */

  signupSinConfirmacion: () =>
    'Me registré con un correo inventado y entré sin confirmar nada.',

  signupPideConfirmar: () =>
    'Me registré y tu app me pidió confirmar el correo antes de dejarme entrar. Ese es el comportamiento correcto.',

  signupNoEncontrado: (places: string[]) =>
    `Busqué cómo crear una cuenta en ${listPlaces(places)} y no encontré ninguna forma de hacerlo.`,

  signupFallo: () =>
    'Encontré el formulario de registro pero no logré completarlo: se trabó antes de crear la cuenta.',

  /* ── Ingreso y salida ─────────────────────────────────────────────── */

  loginOk: () => 'Entré con la cuenta de prueba y llegué a la parte privada sin problemas.',

  loginRechazado: () =>
    'Encontré la pantalla para entrar, pero la cuenta de prueba no fue aceptada. No pude pasar de ahí.',

  loginNoEncontrado: (places: string[]) =>
    `Busqué la pantalla para iniciar sesión en ${listPlaces(places)} y no existe.`,

  logoutOk: () => 'Entré a la cuenta y cerré la sesión desde el menú sin vueltas.',

  logoutNoEncontrado: (places: string[]) =>
    `Entré a la cuenta y busqué cómo cerrar sesión en ${listPlaces(places)}. No hay ninguna forma de salir.`,

  /* ── Recuperar contraseña ─────────────────────────────────────────── */

  passwordResetFaltante: (places: string[]) =>
    `Me hice pasar por alguien que se olvidó la contraseña. Busqué el enlace para recuperarla en ${listPlaces(places)} ` +
    'y no existe: quien pierda su contraseña se queda afuera de tu app para siempre.',

  passwordResetOk: () =>
    'Pedí recuperar la contraseña y tu app me confirmó que manda un correo con las instrucciones.',

  passwordResetIncompleto: () =>
    'Encontré el enlace para recuperar la contraseña, pero al enviarlo tu app no me confirmó nada. ' +
    'Quien lo use no va a saber si el correo salió.',

  /* ── Borrado de cuenta ────────────────────────────────────────────── */

  deleteAccountFaltante: (places: string[]) =>
    `Busqué cómo borrar mi cuenta en ${listPlaces(places)}. No existe la opción.`,

  deleteAccountEncontrado: (donde: string) =>
    `Encontré la opción de borrar la cuenta en ${donde}. No la ejecuté: solo confirmé que está.`,

  /* ── Perfil ───────────────────────────────────────────────────────── */

  editProfileOk: () => 'Cambié un dato del perfil y al volver a entrar seguía guardado.',

  editProfileNoGuarda: () =>
    'Cambié un dato del perfil y guardé, pero al volver a entrar a la pantalla había vuelto al valor anterior.',

  editProfileNoEncontrado: (places: string[]) =>
    `Busqué dónde editar el perfil en ${listPlaces(places)} y no encontré la pantalla.`,

  /* ── Datos de otra cuenta ─────────────────────────────────────────── */

  crossTenantExpuesto: (url: string, queEs: string) =>
    `Entré con la primera cuenta de prueba y abrí ${url} cambiando el número de la dirección. ` +
    `Esa página es de la otra cuenta y aun así me mostró ${queEs}. Cualquiera que cambie ese número ve datos ajenos.`,

  crossTenantIdMutado: (deUrl: string, aUrl: string, queEs: string) =>
    `Entré con la cuenta de prueba, tomé la dirección ${deUrl} y le cambié el número a mano: ${aUrl}. ` +
    `Tu app me mostró ${queEs} sin preguntar nada. No verificó que ese contenido fuera mío.`,

  crossTenantProtegido: (url: string) =>
    `Entré con la primera cuenta y probé abrir ${url}, que es de la otra cuenta. ` +
    'Tu app me frenó, como corresponde.',

  crossTenantSinDatos: () =>
    'Para esta prueba necesito dos cuentas de prueba y una dirección con número. No pude armar el intento.',

  /* ── Flujo principal ──────────────────────────────────────────────── */

  primaryFlowOk: (resumen: string) => `Hice el recorrido principal de la app de punta a punta. ${resumen}`,

  primaryFlowTrabado: (resumen: string) =>
    `Empecé el recorrido principal como lo haría un visitante nuevo y me trabé antes de terminar. ${resumen}`,

  /* ── Cookies y rastreadores ───────────────────────────────────────── */

  cookiesAntesDeAceptar: (cantidad: number, ejemplos: string[]) =>
    `Apenas abrí tu página, y antes de tocar el cartel de cookies, ya se habían cargado ${cantidad} ` +
    `${cantidad === 1 ? 'rastreador' : 'rastreadores'} (${listPlaces(ejemplos)}). El cartel llega tarde.`,

  cookiesOk: () =>
    'Abrí tu página y esperé sin tocar nada: no se cargó ningún rastreador antes de que aceptara el cartel.',

  cookiesSinCartel: (cantidad: number, ejemplos: string[]) =>
    `Tu página carga ${cantidad} ${cantidad === 1 ? 'rastreador' : 'rastreadores'} (${listPlaces(ejemplos)}) ` +
    'y no muestra ningún cartel de cookies.',

  cookiesSinRastreadores: () =>
    'Abrí tu página y no encontré rastreadores ni cartel de cookies. No hay nada que consentir.',

  /* ── Privacidad y términos ────────────────────────────────────────── */

  legalesCompletos: () => 'Encontré tanto la página de privacidad como la de términos.',

  legalesFaltaUno: (falta: string, encontrado: string) =>
    `Busqué las páginas legales. Encontré la de ${encontrado}, pero la de ${falta} no existe.`,

  legalesFaltanAmbas: (places: string[]) =>
    `Busqué la política de privacidad y los términos en ${listPlaces(places)}. No encontré ninguna de las dos.`,
} as const

/** Suma la observación del teléfono al final de una conclusión, si hubo desborde. */
export function conDesbordeMovil(base: string, offenders: string[]): string {
  if (offenders.length === 0) return base
  return `${base} También la miré en un teléfono: la pantalla se va para el costado y hay que arrastrar para leer (${offenders[0]}).`
}
