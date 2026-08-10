/**
 * Se puede registrar con un correo inventado.
 *
 * Este no funciona como los otros tres flujos: acá el problema no es que falte
 * algo, sino que el registro **funcionó de más**. La prueba es una sesión de
 * `signup` que terminó `completed` con un correo que no existe.
 *
 * Si el agente quedó `blocked` (le pidieron confirmar el correo), eso significa
 * justamente que la verificación **sí** está: no se emite nada.
 */

import type { Evidence, FindingDraft } from '@/lib/types/domain'
import { defineCheck, draftFrom, evidenciaCodigo, evidenciaGrabacion } from '../lib/context'
import { archivos, esDePrueba } from '../lib/files'
import { idDeSesion, rangoDeSesion, sesion } from '../agent-input'

/** Configuración que exige confirmar el correo antes de entrar. */
const EXIGE_CONFIRMACION =
  /\b(?:email_confirm|emailRedirectTo|confirmEmail|email_confirmed_at|verifyOtp|enable_confirmations|EMAIL_CONFIRM)\b/

export const noEmailVerification = defineCheck({
  id: 'cmp.no_email_verification',
  pillar: 'completeness',
  name: 'no-email-verification',
  requires: ['code', 'deployed_app'],
  async run(ctx): Promise<FindingDraft[]> {
    const registro = sesion(ctx.agent, 'signup')
    if (!registro) return []
    // Solo cuenta si el agente llegó a usar la app sin confirmar nada.
    if (registro.outcome !== 'completed') return []

    const { startMs, endMs } = rangoDeSesion(registro)
    const evidence: Evidence[] = [
      evidenciaGrabacion(
        idDeSesion(registro),
        startMs,
        endMs,
        'Nos registramos con una dirección de correo inventada y entramos a la app sin confirmar nada.',
      ),
    ]

    // Si además el código no pide confirmación, se dice de dónde sale.
    const fuentes = await archivos(ctx)
    const registroEnCodigo = fuentes.find(
      (a) =>
        !esDePrueba(a.path) &&
        /\bsignUp\s*\(/.test(a.text) &&
        !EXIGE_CONFIRMACION.test(a.text),
    )
    if (registroEnCodigo) {
      evidence.push(
        evidenciaCodigo(
          registroEnCodigo.path,
          1,
          'Acá se crea la cuenta y no se pide confirmar la dirección de correo.',
        ),
      )
    }

    ctx.log('cmp.no_email_verification: registro completado sin confirmar el correo.')
    return [
      draftFrom('cmp.no_email_verification', {}, evidence, {
        confidence: registroEnCodigo ? 'confirmed' : 'likely',
      }),
    ]
  },
})
