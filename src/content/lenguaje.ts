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
