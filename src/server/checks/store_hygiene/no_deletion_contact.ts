/**
 * No hay a dónde escribir para pedir la baja de datos.
 *
 * Solo se emite si la app **recolecta datos** (tiene registro o base): una app
 * sin cuentas no necesita a dónde escribir. Y solo si no hay ningún correo ni
 * formulario de contacto en ninguna parte visible.
 */

import type { Evidence, FindingDraft } from '@/lib/types/domain'
import { defineCheck, draftFrom, evidenciaCodigo } from '../lib/context'
import { archivos, esDePrueba } from '../lib/files'

/** Un correo de contacto, en enlace o en texto. */
const HAY_CORREO =
  /mailto:[^\s"'<>]+@[^\s"'<>]+|[\w.+-]+@[\w-]+\.[\w.]{2,}/

/** Una vía de contacto que no es correo. */
const HAY_CONTACTO =
  /(\/contacto|\/contact|\/soporte|\/support|\/ayuda|\/help|formulario\s+de\s+contacto|contact\s+form|escribinos|escríbenos|contactanos|contáctanos)/i

/** La app tiene cuentas: sin eso no hay datos personales que dar de baja. */
const TIENE_CUENTAS =
  /\b(?:signUp|signIn|signInWithPassword|createUser|auth\s*\.\s*|useSession|getUser|registro|login)\b/

export const noDeletionContact = defineCheck({
  id: 'sto.no_deletion_contact',
  pillar: 'store_hygiene',
  name: 'no-deletion-contact',
  requires: ['code'],
  async run(ctx): Promise<FindingDraft[]> {
    const fuentes = await archivos(ctx).then((todos) => todos.filter((a) => !esDePrueba(a.path)))
    if (fuentes.length === 0) return []

    const tieneCuentas = fuentes.some((a) => TIENE_CUENTAS.test(a.text))
    if (!tieneCuentas) return []

    const conContacto = fuentes.find(
      (a) => HAY_CORREO.test(a.text) || HAY_CONTACTO.test(a.text),
    )
    if (conContacto) return []

    // La evidencia es el pie de página: es donde debería estar y donde miramos.
    const referencia =
      fuentes.find((a) => /(footer|pie)[^/]*\.[jt]sx$/i.test(a.path)) ??
      fuentes.find((a) => /^(src\/)?app\/layout\.[jt]sx?$/.test(a.path))
    if (!referencia) return []

    const evidence: Evidence[] = [
      evidenciaCodigo(
        referencia.path,
        1,
        'Buscamos un correo o un formulario de contacto en todo el proyecto y no hay ninguno.',
      ),
    ]

    ctx.log('sto.no_deletion_contact: no hay vía de contacto en ninguna parte del proyecto.')
    return [draftFrom('sto.no_deletion_contact', {}, evidence)]
  },
})
