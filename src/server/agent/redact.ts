/**
 * Tapar lo que no debe quedar registrado en las capturas ni en la grabación.
 *
 * El video del agente es material que después ve el usuario y puede compartir.
 * Todo lo que se grabe queda grabado: no hay forma de "despublicar" un cuadro.
 * Por eso la política es tapar antes de capturar, no limpiar después.
 *
 * QUÉ SE TAPA
 *  - Capturas de pantalla: los campos sensibles se cubren con un rectángulo sólido
 *    al momento de la captura (`page.screenshot({ mask })`). No hay ventana de tiempo
 *    en la que el valor quede visible en el archivo.
 *  - Grabación en video: los campos de pago y de documento se desenfocan por CSS
 *    inyectado antes de que la página cargue, así que el desenfoque también queda
 *    en los cuadros del video, no solo en las capturas.
 *  - Direcciones guardadas en los pasos: se reemplaza el valor de los parámetros que
 *    suelen llevar sesiones o llaves, y también los del fragmento (`#access_token=…`),
 *    que es donde Supabase deja el pase de sesión después de un enlace mágico.
 *
 * QUÉ NO SE PUEDE TAPAR (limitaciones honestas)
 *  - Contenido dentro de un iframe de otro dominio: no podemos inyectarle estilos.
 *    Un formulario de pago embebido (Stripe Elements, Mercado Pago) cae acá.
 *    Mitigación real: el agente tiene prohibido cargar datos de pago (ver `guards.ts`),
 *    así que esos campos quedan vacíos.
 *  - Ventanas del sistema operativo: el autocompletado del navegador, el selector de
 *    archivos y los diálogos nativos no forman parte de la página y no se graban ni
 *    se pueden enmascarar.
 *  - Texto dibujado en un `<canvas>` o WebGL: no es un elemento del árbol, no hay
 *    selector que lo alcance.
 *  - Datos personales que la propia app muestra en pantalla (nombres, correos de
 *    clientes reales en un panel de administración). Eso es contenido del usuario,
 *    no un campo de formulario: taparlo automáticamente arruinaría la demostración.
 *    Se avisa en la interfaz antes de compartir un video.
 *  - El primer cuadro anterior a que corra el script de inyección en una pestaña que
 *    no abrimos nosotros (por ejemplo, una que abre la app con `target="_blank"`).
 */

import 'server-only'

import type { BrowserContext, Locator, Page } from 'playwright'

/** Campos que nunca deben verse: se enmascaran en capturas y se desenfocan en video. */
export const SENSITIVE_FIELD_SELECTORS: string[] = [
  'input[type="password"]',
  'input[autocomplete*="cc-"]',
  'input[autocomplete="current-password"]',
  'input[autocomplete="new-password"]',
  'input[autocomplete="one-time-code"]',
  'input[name*="card" i]',
  'input[name*="tarjeta" i]',
  'input[name*="cvv" i]',
  'input[name*="cvc" i]',
  'input[name*="iban" i]',
  'input[name*="cbu" i]',
  'input[name*="dni" i]',
  'input[name*="cuit" i]',
  'input[name*="cuil" i]',
  'input[name*="passport" i]',
  'input[name*="pasaporte" i]',
  'input[name*="ssn" i]',
  'input[id*="card" i]',
  'input[id*="cvv" i]',
  '[data-caughtcode-redact]',
]

/** Parámetros de dirección que suelen llevar un pase de sesión o una llave. */
const SECRET_URL_PARAMS = [
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'code',
  'session',
  'session_id',
  'sid',
  'key',
  'api_key',
  'apikey',
  'secret',
  'password',
  'pwd',
  'auth',
  'signature',
  'sig',
]

const REDACTED = '[oculto]'

/**
 * Deja la dirección legible pero sin el secreto.
 * Se aplica a todo lo que se guarda en un paso o se muestra al usuario.
 */
export function redactUrl(rawUrl: string): string {
  if (!rawUrl) return rawUrl
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return redactQueryLikeString(rawUrl)
  }

  for (const param of [...url.searchParams.keys()]) {
    if (isSecretParam(param)) url.searchParams.set(param, REDACTED)
  }

  if (url.hash.length > 1) {
    // Supabase y varios proveedores devuelven el pase de sesión en el fragmento.
    url.hash = `#${redactQueryLikeString(url.hash.slice(1))}`
  }

  if (url.username || url.password) {
    url.username = REDACTED
    url.password = ''
  }

  return url.toString()
}

function isSecretParam(name: string): boolean {
  const lower = name.toLowerCase()
  return SECRET_URL_PARAMS.some((secret) => lower === secret || lower.endsWith(`_${secret}`))
}

function redactQueryLikeString(value: string): string {
  if (!value.includes('=')) return value
  return value
    .split('&')
    .map((pair) => {
      const index = pair.indexOf('=')
      if (index < 0) return pair
      const name = pair.slice(0, index)
      return isSecretParam(name) ? `${name}=${REDACTED}` : pair
    })
    .join('&')
}

/** Quita secretos de un texto libre antes de guardarlo o mostrarlo. */
export function redactText(value: string): string {
  return value
    .replace(/\b(?:\d[ -]?){13,19}\b/g, REDACTED) // números de tarjeta
    .replace(/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g, REDACTED)
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, REDACTED)
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, REDACTED)
}

/** Localizadores que Playwright cubre con un rectángulo al sacar la captura. */
export function maskLocators(page: Page): Locator[] {
  return SENSITIVE_FIELD_SELECTORS.map((selector) => page.locator(selector))
}

/**
 * CSS inyectado antes de que la página corra su propio código.
 * Al cambiar cómo se dibuja el elemento, el desenfoque también queda en el video.
 * Los campos de contraseña ya se ven como puntos, así que solo se desenfocan los
 * de pago y documento, que se escriben en claro.
 */
const REDACTION_CSS = `
  input[autocomplete*="cc-"],
  input[name*="card" i], input[name*="tarjeta" i],
  input[name*="cvv" i], input[name*="cvc" i],
  input[name*="iban" i], input[name*="cbu" i],
  input[name*="dni" i], input[name*="cuit" i], input[name*="cuil" i],
  input[name*="passport" i], input[name*="pasaporte" i], input[name*="ssn" i],
  input[id*="card" i], input[id*="cvv" i],
  [data-caughtcode-redact] {
    filter: blur(6px) !important;
  }
`

export async function installRedaction(context: BrowserContext): Promise<void> {
  await context.addInitScript((css: string) => {
    const apply = () => {
      if (document.getElementById('caughtcode-redaction')) return
      const style = document.createElement('style')
      style.id = 'caughtcode-redaction'
      style.textContent = css
      document.head?.appendChild(style)
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', apply, { once: true })
    } else {
      apply()
    }
  }, REDACTION_CSS)
}

/** Resumen de la política, para mostrarlo junto al video antes de compartirlo. */
export const REDACTION_NOTES = {
  covered: [
    'Contraseñas y códigos de un solo uso',
    'Campos de tarjeta, CVV, IBAN y CBU',
    'Campos de documento (DNI, CUIT, pasaporte)',
    'Pases de sesión y llaves que viajan en la dirección',
  ],
  notCovered: [
    'Formularios de pago embebidos de otro sitio',
    'Ventanas del sistema (autocompletado del navegador, elegir archivo)',
    'Texto dibujado dentro de un lienzo o gráfico 3D',
    'Datos de personas que la propia app muestra en pantalla',
  ],
} as const
