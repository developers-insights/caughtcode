/**
 * No hay forma de recuperar la contraseña.
 *
 * El agente busca el enlace en la pantalla de inicio de sesión y prueba el
 * flujo. Solo se emite si no lo encontró.
 */

import type { FindingDraft } from '@/lib/types/domain'
import { defineCheck } from '../lib/context'
import { chequearFlujoFaltante } from './_flujos'

export const noPasswordReset = defineCheck({
  id: 'cmp.no_password_reset',
  pillar: 'completeness',
  name: 'no-password-reset',
  requires: ['code', 'deployed_app', 'browser_run'],
  async run(ctx): Promise<FindingDraft[]> {
    return chequearFlujoFaltante(ctx, {
      catalogId: 'cmp.no_password_reset',
      taskId: 'password_reset',
      pantallaEsperada: /(login|signin|sign-in|iniciar-sesion|ingresar|entrar)[^/]*\.(tsx|jsx|vue|svelte)$|\/(login|signin|sign-in|iniciar-sesion)\//i,
      senalEnCodigo: /\b(?:resetPasswordForEmail|forgot[-_ ]?password|olvid[eé]|recuperar[-_ ]?contrase|reset[-_ ]?password|updateUser\s*\(\s*\{\s*password)\b/i,
      leyenda: 'Abrimos la pantalla de inicio de sesión y buscamos el enlace para recuperar la contraseña: no está.',
    })
  },
})
