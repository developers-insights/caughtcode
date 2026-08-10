/**
 * Variable privada marcada como pública.
 *
 * `NEXT_PUBLIC_` no es una etiqueta: es una instrucción al empaquetador para
 * que meta el valor dentro del JavaScript que baja al navegador. Si adentro hay
 * un secreto, ya está publicado.
 *
 * Se descartan las que son públicas por diseño (la llave `anon` de Supabase, la
 * publicable de Stripe): denunciarlas sería el falso positivo de manual.
 */

import type { FindingDraft } from '@/lib/types/domain'
import { defineCheck, draftFrom, evidenciaCodigo } from '../lib/context'
import { archivos, coincidencias, esDePrueba } from '../lib/files'
import { pareceSecreto } from '../lib/mask'
import {
  esArchivoDeEjemplo,
  esPublicaPorDiseno,
  esValorDeRelleno,
  leerAsignacionesEnv,
  NOMBRES_SENSIBLES,
} from './_patrones'

/** Prefijos que publican el valor en el navegador, por framework. */
const PREFIJOS_PUBLICOS = /^(NEXT_PUBLIC_|VITE_|REACT_APP_|PUBLIC_|EXPO_PUBLIC_|NUXT_PUBLIC_|GATSBY_)/

/**
 * La misma variable, pero nombrada directo en el código en vez de en un `.env`.
 * Acá no vemos el valor —solo el nombre—, así que el hallazgo sale como
 * probable, no como comprobado.
 */
const NOMBRE_PUBLICO_SENSIBLE =
  /\b(?:NEXT_PUBLIC|VITE|REACT_APP|EXPO_PUBLIC|NUXT_PUBLIC|GATSBY)_[A-Z0-9_]*(?:SECRET|TOKEN|API_?KEY|APIKEY|ACCESS_?KEY|PRIVATE_?KEY|PASSWORD|CREDENTIAL|SERVICE_ROLE)[A-Z0-9_]*\b/g

export const publicEnvSecret = defineCheck({
  id: 'sec.public_env_secret',
  pillar: 'security',
  name: 'public-env-secret',
  requires: ['code'],
  async run(ctx): Promise<FindingDraft[]> {
    const fuentes = await archivos(ctx)
    const drafts: FindingDraft[] = []
    const vistas = new Set<string>()

    for (const archivo of fuentes) {
      if (esDePrueba(archivo.path)) continue
      if (esArchivoDeEjemplo(archivo.path)) continue
      if (!/(^|\/)\.env/.test(archivo.path)) continue

      for (const { clave, valor, linea } of leerAsignacionesEnv(archivo.text)) {
        if (!PREFIJOS_PUBLICOS.test(clave)) continue
        if (vistas.has(clave)) continue
        if (esPublicaPorDiseno(clave)) continue
        if (!NOMBRES_SENSIBLES.test(clave)) continue
        if (esValorDeRelleno(valor)) continue
        if (!pareceSecreto(valor)) continue

        vistas.add(clave)
        drafts.push(
          draftFrom(
            'sec.public_env_secret',
            { variable: clave, archivo: archivo.path, linea },
            [
              evidenciaCodigo(
                archivo.path,
                linea,
                `${clave}=••••  (el prefijo empaqueta este valor dentro del sitio)`,
              ),
            ],
          ),
        )
        ctx.log(`sec.public_env_secret: ${clave} en ${archivo.path}:${linea}`)
      }
    }

    for (const archivo of fuentes) {
      if (esDePrueba(archivo.path) || esArchivoDeEjemplo(archivo.path)) continue
      if (/(^|\/)\.env/.test(archivo.path)) continue

      for (const { match, linea, lineaTexto } of coincidencias(archivo.text, NOMBRE_PUBLICO_SENSIBLE)) {
        const clave = match[0].toUpperCase()
        if (vistas.has(clave)) continue
        if (esPublicaPorDiseno(clave)) continue
        vistas.add(clave)

        drafts.push(
          draftFrom(
            'sec.public_env_secret',
            { variable: clave, archivo: archivo.path, linea },
            [evidenciaCodigo(archivo.path, linea, lineaTexto.trim())],
            // No vimos el valor, solo el nombre: no se afirma con certeza.
            { confidence: 'likely' },
          ),
        )
      }
    }

    return drafts
  },
})
