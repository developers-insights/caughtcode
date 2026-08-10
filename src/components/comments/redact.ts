/**
 * Última red antes de la pantalla.
 *
 * El enmascarado de verdad lo hace el motor (`src/server/comments/risk.ts`),
 * que conoce cada proveedor y recorta con criterio. Esto **no** es una segunda
 * copia de eso: no clasifica nada ni decide si un comentario es riesgoso. Es
 * un raspado bruto de cadenas con pinta de credencial, para que ni un dato
 * viejo guardado antes de que existiera el enmascarado, ni un error nuestro
 * más adelante, puedan terminar dibujando una clave entera en la pantalla.
 *
 * Que una herramienta que avisa de filtraciones filtre lo que encontró sería
 * la falla más cara que podríamos tener, así que la red va igual aunque el
 * camino normal ya esté cubierto.
 *
 * Es idempotente: sobre un texto ya enmascarado no cambia nada, porque los
 * pedazos que quedan son demasiado cortos para volver a coincidir.
 */

/** Prefijos de proveedor que solos ya delatan una credencial. */
const CON_PREFIJO =
  /\b((?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}|whsec_[A-Za-z0-9_-]{8,}|sb_(?:secret|publishable)_[A-Za-z0-9_-]{8,}|(?:AKIA|ASIA|AIDA|AROA)[0-9A-Z]{12,}|AIza[0-9A-Za-z_-]{16,}|sk-(?:ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/g

/**
 * Cadena larga con mezcla de mayúsculas, minúsculas y dígitos. Es la forma
 * típica de un token. Se pide la mezcla justamente para no tocar palabras,
 * rutas de archivo ni direcciones.
 */
const CON_PINTA_DE_TOKEN =
  /(?<![\w-])(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[A-Z])[A-Za-z0-9_-]{24,}(?![\w-])/g

function tapar(valor: string): string {
  if (valor.length <= 12) return '••••'
  return `${valor.slice(0, 8)}••••${valor.slice(-4)}`
}

/** Deja el texto listo para dibujar: sin ninguna credencial completa. */
export function redactar(texto: string): string {
  return texto.replace(CON_PREFIJO, tapar).replace(CON_PINTA_DE_TOKEN, tapar)
}
