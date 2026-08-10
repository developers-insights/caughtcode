/**
 * Dónde quedan los archivos que produce el agente.
 *
 * El video, las capturas y el resumen de lo observado son la prueba: sin ellos un
 * hallazgo es una afirmación. Pero viven en el disco del worker, que es efímero —
 * el proceso que arma el video puede ser otro, en otra máquina, media hora después.
 * Por eso todo sube a Storage antes de que el trabajo termine.
 *
 * ## La ruta se deriva de la corrida, no de la fila
 *
 * La convención del proyecto (`supabase/migrations/0009_storage_buckets.sql`) es
 * `<bucket>/<org_id>/<project_id>/...`. Acá abajo va `<analysis_run_id>/<archivo>`
 * y **no** el id de la fila de `agent_sessions`: esa fila se borra y se vuelve a
 * crear en cada reintento, así que su id cambia y cada intento dejaría basura
 * nueva. Con la corrida como prefijo, reintentar sobreescribe lo de antes.
 *
 * La interfaz existe para poder inyectar un doble en los tests: subir a Supabase
 * de verdad desde una prueba unitaria sería lento y frágil.
 */

import type { NombreBucket } from '@/lib/db/tablas'

export interface AgentStorage {
  /** Sube (o pisa) un objeto. */
  subir(bucket: NombreBucket, ruta: string, cuerpo: Uint8Array | string, contentType: string): Promise<void>
  /** Devuelve el contenido como texto, o `null` si no está. */
  bajarTexto(bucket: NombreBucket, ruta: string): Promise<string | null>
}

/**
 * Prefijo de todo lo de una corrida. `org` y `proyecto` primero, para que el día
 * que haga falta una policy por prefijo ya esté la forma correcta.
 */
export function carpetaDeCorrida(orgId: string, projectId: string, analysisRunId: string): string {
  return `${orgId}/${projectId}/${analysisRunId}`
}

/** El resumen de todo lo observado, junto a las grabaciones de esa misma corrida. */
export const ARCHIVO_EVIDENCIA = 'evidencia.json'

/**
 * Implementación real sobre Supabase Storage.
 *
 * El import del cliente es dinámico por el mismo motivo que en `jobs/db.ts`:
 * `@/lib/supabase/admin` empieza con `import 'server-only'` y exige variables de
 * entorno. Cargándolo recién cuando de verdad se va a subir algo, los tests que
 * inyectan un doble nunca lo tocan.
 */
export const supabaseStorage: AgentStorage = {
  async subir(bucket, ruta, cuerpo, contentType) {
    const { createAdminClient } = await import('@/lib/supabase/admin')
    const { error } = await createAdminClient()
      .storage.from(bucket)
      .upload(ruta, cuerpo, { contentType, upsert: true })
    if (error) throw new Error(error.message)
  },

  async bajarTexto(bucket, ruta) {
    const { createAdminClient } = await import('@/lib/supabase/admin')
    const { data, error } = await createAdminClient().storage.from(bucket).download(ruta)
    if (error || !data) return null
    return data.text()
  },
}
