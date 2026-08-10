/**
 * Una prueba por barrera de seguridad. Son las reglas que no se negocian:
 * si una de estas se cae, el agente puede romper la app de un usuario.
 */

import { describe, expect, it } from 'vitest'

import {
  allowedOriginsFor,
  checkAction,
  guardAccountDeletionLink,
  guardDestructive,
  guardOutOfScopeDomain,
  guardSensitiveInput,
  looksLikeAccountDeletion,
  type GuardContext,
} from '@/server/agent/guards'
import type { AgentAction, TestAccount } from '@/server/agent/types'

const CUENTA: TestAccount = {
  label: 'a',
  email: 'ana@example.com',
  password: 'Prueba-A-2026',
}

function contexto(overrides: Partial<GuardContext> = {}): GuardContext {
  return {
    taskId: 'primary_flow',
    allowDestructive: false,
    allowedOrigins: ['https://mi-app.example'],
    testAccount: CUENTA,
    ...overrides,
  }
}

function accion(partial: Partial<AgentAction>): AgentAction {
  return { action: 'click', why: 'porque sí', ...partial }
}

describe('barrera 1 — acciones destructivas', () => {
  it('frena un botón de borrar cuando no hay autorización', () => {
    const verdict = guardDestructive(
      accion({ action: 'click', selector: 'ref=e4' }),
      { name: 'Eliminar todas mis facturas', role: 'button' },
      contexto(),
    )
    expect(verdict.allowed).toBe(false)
    if (!verdict.allowed) expect(verdict.code).toBe('destructiva_sin_permiso')
  })

  it('frena cancelar la suscripción, pero no un botón de "Cancelar" común', () => {
    const suscripcion = guardDestructive(
      accion({ selector: 'ref=e9' }),
      { name: 'Cancelar suscripción', role: 'button' },
      contexto(),
    )
    expect(suscripcion.allowed).toBe(false)

    const cerrarDialogo = guardDestructive(
      accion({ selector: 'ref=e10' }),
      { name: 'Cancelar', role: 'button' },
      contexto(),
    )
    expect(cerrarDialogo.allowed).toBe(true)
  })

  it('no frena acciones inofensivas aunque digan "borrar"', () => {
    const verdict = guardDestructive(
      accion({ selector: 'ref=e2' }),
      { name: 'Borrar filtros', role: 'button' },
      contexto(),
    )
    expect(verdict.allowed).toBe(true)
  })

  it('deja pasar cuando el usuario autorizó explícitamente', () => {
    const verdict = guardDestructive(
      accion({ selector: 'ref=e4' }),
      { name: 'Eliminar mi cuenta', role: 'button' },
      contexto({ allowDestructive: true, taskId: 'delete_account' }),
    )
    expect(verdict.allowed).toBe(true)
  })
})

describe('barrera 2 — datos de pago, documentos y contraseñas', () => {
  it('nunca completa un campo de tarjeta, ni con datos inventados', () => {
    const verdict = guardSensitiveInput(
      accion({ action: 'fill', selector: 'ref=e7', value: '4111 1111 1111 1111' }),
      { fieldName: 'cardNumber', fieldAutocomplete: 'cc-number', fieldType: 'text' },
      contexto(),
    )
    expect(verdict.allowed).toBe(false)
    if (!verdict.allowed) expect(verdict.code).toBe('dato_sensible')
  })

  it('nunca completa un campo de documento', () => {
    const verdict = guardSensitiveInput(
      accion({ action: 'fill', selector: 'ref=e8', value: '30111222' }),
      { fieldName: 'dni', fieldType: 'text' },
      contexto(),
    )
    expect(verdict.allowed).toBe(false)
  })

  it('rechaza un valor que parece un secreto aunque el campo se llame cualquier cosa', () => {
    const verdict = guardSensitiveInput(
      accion({ action: 'fill', selector: 'ref=e3', value: 'sk_live_abcdefghijklmnop' }),
      { fieldName: 'nota', fieldType: 'text' },
      contexto(),
    )
    expect(verdict.allowed).toBe(false)
  })

  it('solo escribe la contraseña de la cuenta de prueba autorizada', () => {
    const propia = guardSensitiveInput(
      accion({ action: 'fill', selector: 'ref=e5', value: CUENTA.password }),
      { fieldName: 'password', fieldType: 'password' },
      contexto(),
    )
    expect(propia.allowed).toBe(true)

    const ajena = guardSensitiveInput(
      accion({ action: 'fill', selector: 'ref=e5', value: 'la-clave-real-del-usuario' }),
      { fieldName: 'password', fieldType: 'password' },
      contexto(),
    )
    expect(ajena.allowed).toBe(false)
  })

  it('sin cuenta autorizada no escribe ninguna contraseña', () => {
    const verdict = guardSensitiveInput(
      accion({ action: 'fill', selector: 'ref=e5', value: 'cualquier-cosa' }),
      { fieldName: 'password', fieldType: 'password' },
      contexto({ testAccount: undefined }),
    )
    expect(verdict.allowed).toBe(false)
  })
})

describe('barrera 3 — salir del dominio autorizado', () => {
  it('frena una navegación a otro sitio', () => {
    const verdict = guardOutOfScopeDomain(
      accion({ action: 'goto', value: 'https://otro-sitio.example/promo' }),
      {},
      contexto(),
    )
    expect(verdict.allowed).toBe(false)
    if (!verdict.allowed) expect(verdict.code).toBe('fuera_del_dominio')
  })

  it('frena un enlace externo aunque el click parezca interno', () => {
    const verdict = guardOutOfScopeDomain(
      accion({ action: 'click', selector: 'ref=e3' }),
      { name: 'Seguinos', url: 'https://twitter.com/algo' },
      contexto(),
    )
    expect(verdict.allowed).toBe(false)
  })

  it('deja pasar direcciones relativas y del mismo sitio', () => {
    expect(guardOutOfScopeDomain(accion({ action: 'goto', value: '/ajustes' }), {}, contexto()).allowed).toBe(true)
    expect(
      guardOutOfScopeDomain(
        accion({ action: 'goto', value: 'https://mi-app.example/ajustes' }),
        {},
        contexto(),
      ).allowed,
    ).toBe(true)
  })

  it('frena enlaces que ejecutan código', () => {
    const verdict = guardOutOfScopeDomain(
      accion({ action: 'click', selector: 'ref=e1' }),
      { url: 'javascript:alert(1)' },
      contexto(),
    )
    expect(verdict.allowed).toBe(false)
  })

  it('acepta el dominio con y sin www', () => {
    const origins = allowedOriginsFor('https://mi-app.example/inicio')
    expect(origins).toContain('https://mi-app.example')
    expect(origins).toContain('https://www.mi-app.example')
  })
})

describe('barrera 4 — cierre de cuenta fuera de lugar', () => {
  it('no toca "eliminar mi cuenta" mientras prueba otra cosa', () => {
    const verdict = guardAccountDeletionLink(
      accion({ selector: 'ref=e12' }),
      { name: 'Eliminar mi cuenta', role: 'link' },
      contexto({ taskId: 'edit_profile' }),
    )
    expect(verdict.allowed).toBe(false)
    if (!verdict.allowed) expect(verdict.code).toBe('cierre_de_cuenta_fuera_de_lugar')
  })

  it('sí lo permite en la prueba de borrado de cuenta', () => {
    const verdict = guardAccountDeletionLink(
      accion({ selector: 'ref=e12' }),
      { name: 'Eliminar mi cuenta', role: 'link' },
      contexto({ taskId: 'delete_account' }),
    )
    expect(verdict.allowed).toBe(true)
  })

  it('reconoce las variantes en las que la app puede escribirlo', () => {
    expect(looksLikeAccountDeletion('Dar de baja')).toBe(true)
    expect(looksLikeAccountDeletion('Eliminá tu cuenta')).toBe(true)
    expect(looksLikeAccountDeletion('Delete account')).toBe(true)
    expect(looksLikeAccountDeletion('Editar perfil')).toBe(false)
  })
})

describe('las cuatro juntas', () => {
  it('el cierre de cuenta gana sobre lo destructivo y devuelve el motivo correcto', () => {
    const verdict = checkAction(
      accion({ selector: 'ref=e12' }),
      { name: 'Eliminar mi cuenta', role: 'button' },
      contexto({ taskId: 'logout' }),
    )
    expect(verdict.allowed).toBe(false)
    if (!verdict.allowed) expect(verdict.code).toBe('cierre_de_cuenta_fuera_de_lugar')
  })

  it('una acción común pasa las cuatro', () => {
    const verdict = checkAction(
      accion({ selector: 'ref=e2' }),
      { name: 'Ver reportes', role: 'link', url: '/reportes' },
      contexto(),
    )
    expect(verdict.allowed).toBe(true)
  })

  it('el motivo del rechazo se explica sin jerga', () => {
    const verdict = checkAction(
      accion({ action: 'fill', selector: 'ref=e7', value: '4111111111111111' }),
      { fieldName: 'cc-number' },
      contexto(),
    )
    expect(verdict.allowed).toBe(false)
    if (!verdict.allowed) {
      expect(verdict.reasonPlain.length).toBeGreaterThan(20)
      expect(verdict.reasonPlain).not.toMatch(/selector|guard|barrier|null|undefined/i)
    }
  })
})
