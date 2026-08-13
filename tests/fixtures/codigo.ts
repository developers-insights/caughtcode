/**
 * Dobles del helper que garantiza que el código esté en disco
 * (`@/server/ingest/rehidratar`).
 *
 * Desde que `index_code` y `run_checks` se aseguran de tener el código antes de
 * leerlo, un test que les pasa una carpeta inventada intenta bajar la copia de
 * Storage y se va a la base de verdad. Estos dobles cortan eso: dicen "el código
 * ya está donde vino" sin tocar ni disco ni red.
 */

import type { asegurarCodigoEnDisco } from '@/server/ingest/rehidratar'

/** El código ya estaba en la carpeta que llegó en el payload. */
export function codigoYaEnDisco(): typeof asegurarCodigoEnDisco {
  return async ({ repoPath }) => ({ codeDir: repoPath, rehidratado: false, ingesta: null })
}

/** Hubo que rehidratarlo, y quedó en `codeDir`. Registra cada llamada. */
export function codigoRehidratado(codeDir: string): typeof asegurarCodigoEnDisco & {
  llamadas: string[]
} {
  const llamadas: string[] = []
  const doble = (async ({ repoPath }) => {
    llamadas.push(repoPath)
    return { codeDir, rehidratado: true, ingesta: null }
  }) as typeof asegurarCodigoEnDisco & { llamadas: string[] }
  doble.llamadas = llamadas
  return doble
}
