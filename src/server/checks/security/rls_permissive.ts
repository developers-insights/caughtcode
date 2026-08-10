/**
 * Un usuario puede ver los datos de otro.
 *
 * Este es el chequeo estrella y el más delicado del producto. No alcanza con
 * leer la regla y opinar: se **prueba**, haciéndose pasar por un usuario y
 * pidiendo filas de otro. Si vuelven filas, está demostrado; si no vuelven, no
 * se dice nada.
 *
 * Dos caminos, en este orden:
 *
 *  1. **Regla abierta a simple vista** (`using (true)`): no necesita base viva.
 *     Es lectura del esquema, y es concluyente: la regla dice que sí a todo.
 *
 *  2. **Prueba en vivo**: se simula al usuario A y se piden filas de B.
 *     Es la evidencia fuerte, la que se puede narrar en el video.
 *
 * TODO lo que toca la base del usuario pasa por `conSondaDeLectura`, que abre
 * la transacción, la deja en solo lectura y hace `rollback` en `finally`.
 * **Nunca se escribe nada.** Ver `../lib/pg-readonly.ts` para las cuatro
 * barreras que lo garantizan.
 */

import type { DbSchemaSnapshot, FindingDraft } from '@/lib/types/domain'
import { defineCheck, draftFrom, evidenciaBase } from '../lib/context'
import type { CheckRunContext } from '../lib/context'
import { conLecturaSimple, conSondaDeLectura } from '../lib/pg-readonly'
import type { SqlConnect } from '../lib/pg-readonly'
import {
  alcanzaUsuariosComunes,
  citarIdentificador,
  citarTabla,
  columnaDueno,
  esReglaAbierta,
  reglasDeLectura,
  tablasPublicas,
} from './_esquema'

/** Tope de tablas que se prueban en vivo. Cada una son dos conexiones. */
const MAX_TABLAS_EN_VIVO = 20

type Tabla = DbSchemaSnapshot['tables'][number]

export const rlsPermissive = defineCheck({
  id: 'sec.rls_permissive',
  pillar: 'security',
  name: 'rls-permissive',
  requires: ['database'],
  async run(ctx): Promise<FindingDraft[]> {
    const drafts: FindingDraft[] = []
    const yaReportadas = new Set<string>()

    // ── 1. Reglas abiertas a simple vista ────────────────────────────────
    for (const tabla of tablasPublicas(ctx.index.dbSchema)) {
      if (!tabla.rlsEnabled) continue // eso es sec.rls_disabled, no esto

      const abiertas = reglasDeLectura(tabla).filter(
        (p) => esReglaAbierta(p) && alcanzaUsuariosComunes(p),
      )
      if (abiertas.length === 0) continue

      const politica = abiertas[0]!
      yaReportadas.add(tabla.name)
      drafts.push(
        draftFrom(
          'sec.rls_permissive',
          { tabla: tabla.name, policy: politica.name },
          [
            evidenciaBase(
              `${tabla.schema}.${tabla.name}`,
              `La regla "${politica.name}" (${politica.command}) está escrita como "using (true)": ` +
                `deja pasar cualquier fila a cualquiera que esté logueado, sin comparar contra el dueño.`,
            ),
          ],
        ),
      )
      ctx.log(`sec.rls_permissive (por lectura del esquema): ${tabla.name}`)
    }

    // ── 2. Prueba en vivo ────────────────────────────────────────────────
    const enVivo = await probarEnVivo(ctx, yaReportadas)
    drafts.push(...enVivo)

    return drafts
  },
})

async function probarEnVivo(
  ctx: CheckRunContext,
  yaReportadas: Set<string>,
): Promise<FindingDraft[]> {
  const databaseUrl = ctx.databaseUrl
  const connect = ctx.connect
  if (!databaseUrl || !connect) return []

  const candidatas = tablasPublicas(ctx.index.dbSchema)
    .filter((t) => t.rlsEnabled && !yaReportadas.has(t.name))
    .filter((t) => columnaDueno(t) !== null)
    .slice(0, MAX_TABLAS_EN_VIVO)

  if (candidatas.length === 0) return []

  const drafts: FindingDraft[] = []

  for (const tabla of candidatas) {
    try {
      const draft = await probarTabla(ctx, tabla, databaseUrl, connect)
      if (draft) drafts.push(draft)
    } catch (error) {
      // Una tabla que no se puede sondear no es un hallazgo: es una tabla que
      // no se pudo revisar. Se registra y se sigue.
      ctx.log(
        `sec.rls_permissive: no se pudo probar ${tabla.name}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  return drafts
}

async function probarTabla(
  ctx: CheckRunContext,
  tabla: Tabla,
  databaseUrl: string,
  connect: SqlConnect,
): Promise<FindingDraft | null> {
  const dueno = columnaDueno(tabla)
  if (!dueno) return null

  const tablaCitada = citarTabla(tabla.schema, tabla.name)
  const duenoCitado = citarIdentificador(dueno)

  // Paso 1 — dos dueños distintos. Solo lectura, dentro de su propio rollback.
  const duenos = await conLecturaSimple(databaseUrl, connect, async (q) => {
    const { rows } = await q(
      `select distinct ${duenoCitado} as dueno from ${tablaCitada} where ${duenoCitado} is not null limit 2`,
    )
    return rows.map((r) => r.dueno).filter((v): v is string => typeof v === 'string')
  })

  // Con menos de dos dueños no hay nada que demostrar: no se puede saber si la
  // regla separa usuarios porque no hay dos usuarios.
  if (duenos.length < 2) return null

  const [usuarioA, usuarioB] = duenos as [string, string]

  // Paso 2 — la prueba. Nos hacemos pasar por A y pedimos filas de B.
  const filasAjenas = await conSondaDeLectura(
    databaseUrl,
    connect,
    { sub: usuarioA, role: 'authenticated' },
    async (q) => {
      const { rows } = await q(
        `select count(*)::text as total from ${tablaCitada} where ${duenoCitado} = $1`,
        [usuarioB],
      )
      const total = rows[0]?.total
      return typeof total === 'string' ? Number.parseInt(total, 10) : 0
    },
  )

  if (!Number.isFinite(filasAjenas) || filasAjenas <= 0) return null

  const politica =
    reglasDeLectura(tabla).find(alcanzaUsuariosComunes)?.name ??
    reglasDeLectura(tabla)[0]?.name ??
    tabla.policies[0]?.name ??
    'sin nombre'

  ctx.log(`sec.rls_permissive (probado en vivo): ${tabla.name}, ${filasAjenas} filas ajenas`)

  return draftFrom(
    'sec.rls_permissive',
    { tabla: tabla.name, policy: politica },
    [
      evidenciaBase(
        `${tabla.schema}.${tabla.name}`,
        `Entramos con la identidad de un usuario y pedimos filas de otro: ` +
          `nos devolvió ${filasAjenas} ${filasAjenas === 1 ? 'fila que no le pertenece' : 'filas que no le pertenecen'}. ` +
          `La comparación se hace por la columna "${dueno}". ` +
          `La prueba se hizo dentro de una transacción que se deshace sola: no se escribió nada en tu base.`,
      ),
    ],
  )
}
