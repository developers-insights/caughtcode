/**
 * Archivo de claves versionado.
 *
 * Se emite solo si se cumplen las tres condiciones, porque cada una sola daría
 * un falso positivo:
 *   1. el archivo llegó en el árbol entregado (o sea: está versionado)
 *   2. no es un `.env.example` ni equivalente
 *   3. tiene al menos un valor que parece real, no un relleno
 *
 * Un `.env.example` lleno de `TU_CLAVE_ACA` es buena práctica, no un hallazgo.
 */

import type { Evidence, FindingDraft } from '@/lib/types/domain'
import { defineCheck, draftFrom, evidenciaCodigo } from '../lib/context'
import { archivos } from '../lib/files'
import {
  esArchivoDeEjemplo,
  esValorDeRelleno,
  leerAsignacionesEnv,
  NOMBRES_SENSIBLES,
} from './_patrones'

const ES_ENV = /(^|\/)\.env(\.[A-Za-z0-9_-]+)*$/

export const envCommitted = defineCheck({
  id: 'sec.env_committed',
  pillar: 'security',
  name: 'env-committed',
  requires: ['code'],
  async run(ctx): Promise<FindingDraft[]> {
    const fuentes = await archivos(ctx)
    const gitignore = fuentes.find((a) => a.path === '.gitignore')?.text ?? ''
    const drafts: FindingDraft[] = []

    for (const archivo of fuentes) {
      if (!ES_ENV.test(archivo.path)) continue
      if (esArchivoDeEjemplo(archivo.path)) continue

      const asignaciones = leerAsignacionesEnv(archivo.text)
      const reales = asignaciones.filter(
        (a) => !esValorDeRelleno(a.valor) && a.valor.length >= 8,
      )
      if (reales.length === 0) continue

      const sensibles = reales.filter((a) => NOMBRES_SENSIBLES.test(a.clave))
      const primera = sensibles[0] ?? reales[0]!

      const cubierto = gitignoreCubre(gitignore, archivo.path)

      const evidence: Evidence[] = [
        evidenciaCodigo(
          archivo.path,
          primera.linea,
          // El nombre de la variable sí, el valor jamás.
          `${primera.clave}=••••  (${reales.length} ${reales.length === 1 ? 'valor' : 'valores'} con contenido real en este archivo)`,
        ),
      ]

      if (!cubierto && gitignore.length > 0) {
        evidence.push(
          evidenciaCodigo(
            '.gitignore',
            1,
            `No hay ninguna línea que excluya "${archivo.path}".`,
          ),
        )
      }

      drafts.push(draftFrom('sec.env_committed', { archivo: archivo.path }, evidence))
      ctx.log(`sec.env_committed: ${archivo.path} con ${reales.length} valores reales`)
    }

    return drafts
  },
})

/** `true` si alguna línea del .gitignore excluye esa ruta. */
function gitignoreCubre(gitignore: string, ruta: string): boolean {
  const base = ruta.slice(ruta.lastIndexOf('/') + 1)
  for (const cruda of gitignore.split('\n')) {
    const linea = cruda.trim()
    if (linea === '' || linea.startsWith('#')) continue
    if (linea.startsWith('!')) continue

    const patron = linea.replace(/^\//, '').replace(/\/$/, '')
    if (patron === base || patron === ruta) return true
    if (patron === '.env*' && base.startsWith('.env')) return true
    if (patron.endsWith('*') && base.startsWith(patron.slice(0, -1))) return true
    if (patron.startsWith('*') && base.endsWith(patron.slice(1))) return true
  }
  return false
}
