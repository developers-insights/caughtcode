/**
 * Traducción de jerga a lenguaje llano.
 * Regla dura del producto: cero jerga en texto visible al usuario.
 * Si aparece un término técnico nuevo en la UI, primero se agrega acá.
 */

export const JERGA: Record<string, string> = {
  RLS: 'las reglas que definen quién puede ver qué',
  'row level security': 'las reglas que definen quién puede ver qué',
  policy: 'regla de acceso',
  'service role key': 'la llave maestra de tu base de datos',
  'anon key': 'la llave pública de tu app',
  bucket: 'carpeta de archivos subidos',
  endpoint: 'dirección donde tu app recibe pedidos',
  'route handler': 'dirección donde tu app recibe pedidos',
  'server action': 'acción que corre en tu servidor',
  CORS: 'qué otros sitios pueden hablarle a tu app',
  XSS: 'inyección de código en la pantalla del visitante',
  'source map': 'archivo que revela tu código original',
  JWT: 'el pase que identifica a cada usuario',
  'multi-tenant': 'varios clientes en la misma base',
  PII: 'datos personales',
  tracker: 'código que registra lo que hace el visitante',
  'rate limit': 'tope de pedidos por minuto',
  'security definer': 'función con permisos de administrador',
  'search_path': 'orden en el que la base busca las cosas',
  'axe-core': 'revisión automática de accesibilidad',
  'server component': 'pantalla que se arma en tu servidor',
  'client component': 'pantalla que se arma en el navegador del visitante',
}

/** Términos que nunca deberían aparecer en texto visible al usuario. */
export const TERMINOS_PROHIBIDOS = [
  'RLS',
  'CWE',
  'CVE',
  'OWASP',
  'SARIF',
  'XSS',
  'CSRF',
  'JWT',
  'PII',
  'multi-tenant',
  'endpoint',
  'payload',
  'middleware',
  'crédito',
  'créditos',
]

/**
 * Detecta jerga en un texto destinado al usuario.
 * Lo usan los tests y el chequeo de dogfooding.
 */
export function detectarJerga(texto: string): string[] {
  const encontrados: string[] = []
  for (const termino of TERMINOS_PROHIBIDOS) {
    const re = new RegExp(`\\b${termino.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
    if (re.test(texto)) encontrados.push(termino)
  }
  return encontrados
}

/** Disclaimer obligatorio en todo lo relacionado a tienda y consentimiento. */
export const DISCLAIMER_LEGAL =
  'Esto es lo que un revisor de App Store o un regulador podría marcar. No es asesoramiento legal ni un dictamen sobre ninguna ley en particular.'

export const DISCLAIMER_CONFIANZA_MEDIA =
  'Encontramos señales de esto, pero no pudimos confirmarlo del todo. Conviene que lo mires.'

/* ── Errores del motor → lenguaje llano ─────────────────────────────────── */

/**
 * Un error listo para mostrar.
 *
 * `mensaje` es lo único que ve el usuario de entrada. `detalle` es el texto
 * crudo que devolvió el motor: **no se borra**, se reubica detrás de un
 * desplegable. Sirve cuando alguien nos escribe y necesitamos saber qué pasó
 * de verdad.
 */
export interface ErrorLegible {
  mensaje: string
  /** Texto original. `null` cuando el mensaje ya era el original. */
  detalle: string | null
}

/**
 * Señales de que un texto lo escribió una máquina y no una persona.
 *
 * No alcanza con `detectarJerga()`: un error crudo de Postgres como
 * `permission denied for table findings_caughtcode` no contiene ninguno de los
 * términos prohibidos y aun así es ilegible para nuestro usuario.
 */
const SENALES_TECNICAS: readonly RegExp[] = [
  /\bpermission denied\b/i,
  /\bdoes not exist\b/i,
  /\bviolates\b/i,
  /\bconstraint\b/i,
  /\brelation\s+"/i,
  /\bnull value\b/i,
  /\bduplicate key\b/i,
  /\bsyntax error\b/i,
  /\bdeadlock\b/i,
  /\b(cancel+ing) statement\b/i,
  /\b(timeout|timed out)\b/i,
  /\b(ERROR|FATAL|WARNING|DETAIL|HINT|LINE \d+)\s*:/,
  /\bpg_[a-z_]+/i,
  /_caughtcode\b/,
  /\b(select|insert into|update|delete from|alter table|create table|drop table)\s/i,
  /\bE(CONN|TIMEDOUT|NOENT|NOTFOUND|ACCES|PIPE|AI_AGAIN|NOSPC|MFILE|HOSTUNREACH)[A-Z]*\b/,
  /\bPGRST\d+/,
  /\b(TypeError|ReferenceError|SyntaxError|RangeError)\b/,
  /\bError:\s/,
  /\n\s+at\s+\S/,
  /\bstack\s*trace\b/i,
  /\bfetch failed\b/i,
  /\bstatus\s*(code)?\s*[:=]?\s*[45]\d{2}\b/i,
  /\b(undefined|NaN)\b/,
  /\bat\s+\w+\.\w+\s*\(/,
  /[{}[\]<>]{2,}/,
  /\b[0-9A-Z]{5}\b\s*[:)]/,
]

/**
 * Traducciones en las que tenemos confianza suficiente.
 *
 * Deliberadamente corta. Cada línea de acá afirma una causa, y afirmar una
 * causa equivocada es peor que no decir nada: manda al usuario a arreglar algo
 * que no está roto. Si un caso no entra con claridad en ninguno de estos
 * patrones, cae en el mensaje honesto de `SIN_TRADUCCION`.
 */
const TRADUCCIONES: readonly { patron: RegExp; mensaje: string }[] = [
  {
    patron: /\b(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|getaddrinfo|connection refused|could not connect|connection terminated|fetch failed)\b/i,
    mensaje:
      'No pudimos conectarnos a la dirección que nos diste. Fijate que esté bien escrita y que la app esté publicada y respondiendo.',
  },
  {
    patron: /\b(ETIMEDOUT|timed? ?out|timeout|statement timeout|57014)\b/i,
    mensaje:
      'Tardó más de lo que podemos esperar y lo cortamos. Suele pasar con proyectos grandes. Probá de nuevo; si vuelve a pasar, escribinos.',
  },
  {
    patron: /\b(password authentication failed|28P01|invalid api key|bad credentials|invalid token|401|unauthorized)\b/i,
    mensaje:
      'Nos rechazaron el usuario o la clave que nos diste para entrar. Revisala en los ajustes del proyecto y volvé a guardarla.',
  },
  {
    patron: /\b(permission denied|insufficient privilege|42501|403|forbidden)\b/i,
    mensaje:
      'La cuenta que nos diste no tiene permiso para leer lo que necesitábamos. Pedile permiso de lectura a quien la administra, o generá una nueva de solo lectura.',
  },
  {
    patron: /\b(repository not found|404|not found)\b/i,
    mensaje:
      'No encontramos tu proyecto en la dirección que nos diste. Si el repositorio es privado, dale acceso a caughtcode o subí un zip.',
  },
  {
    patron: /\b(too large|payload too large|413|ENOSPC|out of memory|heap out of memory|maximum call stack)\b/i,
    mensaje:
      'Tu proyecto es más grande de lo que podemos procesar de una sola vez. Escribinos y lo corremos por partes.',
  },
  {
    patron: /\b(rate limit|429|too many requests|quota exceeded|overloaded)\b/i,
    mensaje:
      'Llegamos al tope de pedidos por minuto de uno de los servicios que usamos. Esperá unos minutos y volvé a lanzarla.',
  },
  {
    patron: /\b(502|503|504|bad gateway|service unavailable|gateway timeout|internal server error|500)\b/i,
    mensaje:
      'Uno de los servicios que usamos dejó de responder. No es tu app: probá de nuevo en un rato.',
  },
]

/**
 * Lo que decimos cuando el texto es claramente técnico pero no lo entendemos.
 * No inventa una causa: dice que no sabemos y deja el original a mano.
 */
const SIN_TRADUCCION =
  'Se cortó por algo que no sabemos explicar en castellano todavía. Guardamos abajo lo que nos devolvió el motor: si nos lo pasás, lo miramos nosotros.'

/** ¿Este texto lo escribió una máquina? */
export function esTextoTecnico(texto: string): boolean {
  if (detectarJerga(texto).length > 0) return true
  return SENALES_TECNICAS.some((señal) => señal.test(texto))
}

/**
 * Deja cualquier mensaje de error listo para la pantalla.
 *
 * Regla dura: **cero jerga en texto visible**. Nada de lo que devuelve el motor
 * —ni un error de Postgres, ni una traza de Node— llega crudo como texto
 * principal. Tres caminos, en orden:
 *
 * 1. Ya está en criollo (lo escribimos nosotros) → pasa tal cual.
 * 2. Es técnico y lo reconocemos → traducción con qué pasó y qué hacer.
 * 3. Es técnico y no lo reconocemos → decimos que no sabemos. **Nunca se
 *    inventa una causa**: mandar a alguien a arreglar lo que no está roto es
 *    peor que admitir que no entendimos.
 *
 * En los casos 2 y 3 el texto original viaja en `detalle` para mostrarlo
 * plegado. No se pierde información de diagnóstico: se reubica.
 */
export function traducirErrorTecnico(crudo: string | null | undefined): ErrorLegible | null {
  const texto = crudo?.trim()
  if (!texto) return null

  if (!esTextoTecnico(texto)) return { mensaje: texto, detalle: null }

  const conocido = TRADUCCIONES.find(({ patron }) => patron.test(texto))
  return { mensaje: conocido?.mensaje ?? SIN_TRADUCCION, detalle: texto }
}
