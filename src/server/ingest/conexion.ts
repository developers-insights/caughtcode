import 'server-only'

/**
 * La conexión de solo lectura a la base del usuario: se resuelve cuando se usa,
 * nunca viaja en el payload de un trabajo.
 *
 * ## Qué estaba mal
 *
 * `ingest_repo` descifraba la credencial de `project_connections_caughtcode` una
 * sola vez y metía el `databaseUrl` **en claro** en `jobs.payload`. De ahí se
 * reenviaba a `index_code`, a `run_browser_agent` y a `run_checks`, así que la
 * cadena de conexión quedaba escrita en cuatro filas de `jobs_caughtcode`. La
 * policy de lectura de esa tabla alcanza a **cualquier miembro** de la
 * organización: el rol más bajo del equipo se llevaba la conexión a la base del
 * cliente con un `GET`. El cifrado en reposo de la credencial no servía de nada
 * teniendo una copia legible al lado.
 *
 * ## Cómo funciona ahora
 *
 * En el payload viaja el `projectId` —que ya viajaba— y cada trabajo que de
 * verdad necesita la conexión la lee y la descifra en el momento. El secreto
 * vive en memoria lo que dura el trabajo y no queda escrito en ninguna fila que
 * el cliente pueda leer. Hoy la necesitan dos: `index_code` (para leer el
 * esquema en vivo) y `run_checks` (para los chequeos de permisos). El agente de
 * navegación no la usaba nunca: solo la pasaba de mano en mano.
 *
 * ## Compatibilidad
 *
 * Los trabajos que ya estaban encolados con el secreto adentro siguen
 * funcionando: cada consumidor usa `payload.databaseUrl` si vino, y recién si no
 * vino llama acá. Cuando esos trabajos se drenen, el campo queda sin uso.
 *
 * ## Si no se puede leer
 *
 * Devuelve `null` y lo deja dicho en el log. No tira: que no haya conexión no
 * invalida la revisión del código, solo hace que los chequeos que dependen de la
 * base se salteen y queden marcados como no revisados. Lo que sí no puede pasar
 * es fallar en silencio.
 */

import { T } from '@/lib/db/tablas'
import { describeDbError, type JobsDb } from '@/server/jobs/db'
import { describeError } from '@/server/jobs/errors'

export interface OpcionesConexionBase {
  db: JobsDb
  /** Sin proyecto no hay conexión que buscar. */
  projectId: string | null
  log: (mensaje: string) => void
  /** Descifra la credencial guardada. Separado para poder probarlo. */
  descifrar?: (credencial: string) => Promise<string>
}

/**
 * El import es tardío por lo mismo que en el resto del frente: `@/lib/crypto`
 * exige la clave de cifrado en el entorno, y en los tests no existe.
 */
async function descifrarPorDefecto(credencial: string): Promise<string> {
  const { decryptSecret } = await import('@/lib/crypto')
  return decryptSecret(credencial)
}

export async function leerConexionBase(
  opciones: OpcionesConexionBase,
): Promise<string | null> {
  const { db, projectId, log } = opciones
  if (!projectId) return null

  const { data, error } = await db
    .from(T.projectConnections)
    .select('credentials_ref')
    .eq('project_id', projectId)
    .eq('provider', 'supabase')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    log(
      `No pudimos leer la conexión a tu base (${describeDbError(error)}). ` +
        'El análisis sigue, pero sin comprobar quién puede ver qué.',
    )
    return null
  }

  const credencial = (data as Record<string, unknown> | null)?.credentials_ref
  if (!credencial) return null

  try {
    const url = await (opciones.descifrar ?? descifrarPorDefecto)(String(credencial))
    return url.trim() || null
  } catch (error) {
    log(
      `No pudimos leer la conexión a tu base guardada (${describeError(error)}). ` +
        'El análisis sigue, pero sin comprobar quién puede ver qué.',
    )
    return null
  }
}
