/**
 * Barreras de seguridad del agente.
 *
 * Se evalúan ANTES de ejecutar cualquier acción. Si una barrera rechaza, la acción
 * no se ejecuta: se registra el rechazo como paso y el agente sigue por otro lado.
 * Rechazar de más es aceptable; ejecutar de más no lo es.
 *
 * Las cuatro barreras (reglas duras del producto, ver DECISIONS.md D9):
 *  1. Acción destructiva sin autorización explícita del usuario.
 *  2. Cargar datos de pago, documentos de identidad o contraseñas reales. Nunca.
 *  3. Salir del dominio autorizado del proyecto.
 *  4. Tocar "cerrar cuenta" en una tarea que no es la de borrado de cuenta.
 *
 * Lo usan: `driver.ts` (antes de cada acción) y `tests/agent/guards.test.ts`.
 */

import 'server-only'

import type { AgentTaskId } from '@/lib/types/domain'
import type { AgentAction, TestAccount } from './types'
import { normalize } from './aria'

export type GuardCode =
  | 'destructiva_sin_permiso'
  | 'dato_sensible'
  | 'fuera_del_dominio'
  | 'cierre_de_cuenta_fuera_de_lugar'

export interface GuardBlock {
  allowed: false
  code: GuardCode
  /** Qué pasó, en lenguaje llano. Se muestra tal cual en el detalle del paso. */
  reasonPlain: string
}

export type GuardVerdict = { allowed: true } | GuardBlock

const OK: GuardVerdict = { allowed: true }

/** Lo que el agente sabe del elemento sobre el que va a actuar. */
export interface ActionTarget {
  /** Nombre accesible: el texto que lee una persona. */
  name?: string
  role?: string
  /** Destino, si es un enlace. */
  url?: string
  /** `name`, `id` o `autocomplete` del campo, para saber qué le están pidiendo. */
  fieldName?: string
  fieldType?: string
  fieldAutocomplete?: string
}

export interface GuardContext {
  taskId: AgentTaskId
  /** Llega desde arriba solo si el usuario lo confirmó en la pantalla. */
  allowDestructive: boolean
  /** Orígenes donde el agente puede navegar. Todo lo demás es afuera. */
  allowedOrigins: string[]
  /** Cuenta de prueba habilitada para esta tarea, si hay. */
  testAccount?: TestAccount
}

/* ── Léxicos ─────────────────────────────────────────────────────────── */

/** Verbos y frases que indican que algo se rompe o se pierde. */
const DESTRUCTIVE_PHRASES = [
  'borrar',
  'borra ',
  'eliminar',
  'elimina ',
  'suprimir',
  'vaciar',
  'purgar',
  'dar de baja',
  'darme de baja',
  'darse de baja',
  'cerrar cuenta',
  'cerrar mi cuenta',
  'desactivar cuenta',
  'desactivar mi cuenta',
  'cancelar suscripcion',
  'cancelar mi suscripcion',
  'cancelar plan',
  'cancelar membresia',
  'cancelar pedido',
  'cancelar reserva',
  'transferir',
  'enviar dinero',
  'retirar fondos',
  'restablecer todo',
  'resetear todo',
  'delete',
  'remove account',
  'close account',
  'deactivate account',
  'cancel subscription',
  'cancel plan',
  'wipe',
  'purge',
  'transfer funds',
  'withdraw',
]

/** Objetos inofensivos: borrar un filtro no rompe nada. */
const DESTRUCTIVE_EXCEPTIONS = [
  'filtro',
  'filtros',
  'busqueda',
  'seleccion',
  'formato',
  'borrador',
  'clear filters',
  'clear search',
]

/**
 * Frases de cierre de cuenta. Son las que la tarea de borrado sí puede tocar.
 * Van también las formas imperativas: las apps rioplatenses escriben "Eliminá tu
 * cuenta" y las neutras "Elimina tu cuenta". Sin tildes porque el texto se normaliza.
 */
const ACCOUNT_DELETION_PHRASES = [
  'borrar cuenta',
  'borrar mi cuenta',
  'borrar la cuenta',
  'borra tu cuenta',
  'borra mi cuenta',
  'eliminar cuenta',
  'eliminar mi cuenta',
  'eliminar la cuenta',
  'eliminar mi perfil',
  'elimina tu cuenta',
  'elimina mi cuenta',
  'elimina la cuenta',
  'suprimir cuenta',
  'cerrar cuenta',
  'cerrar mi cuenta',
  'cerrar la cuenta',
  'cerra tu cuenta',
  'cierra tu cuenta',
  'desactivar cuenta',
  'desactivar mi cuenta',
  'desactiva tu cuenta',
  'dar de baja',
  'darme de baja',
  'da de baja tu cuenta',
  'baja de la cuenta',
  'delete account',
  'delete my account',
  'delete your account',
  'close account',
  'close your account',
  'deactivate account',
  'remove my account',
]

/** Campos que el agente jamás completa, con ningún valor. */
const NEVER_FILL_FIELD_HINTS = [
  'cc-number',
  'cc-csc',
  'cc-exp',
  'cc-name',
  'card',
  'tarjeta',
  'cvv',
  'cvc',
  'codigo de seguridad',
  'vencimiento',
  'expiry',
  'iban',
  'cbu',
  'cvu',
  'alias bancario',
  'routing',
  'account number',
  'numero de cuenta',
  'dni',
  'cuit',
  'cuil',
  'pasaporte',
  'passport',
  'ssn',
  'social security',
  'nif',
  'curp',
  'rfc',
  'tax id',
]

/** Valores que parecen un secreto real aunque el campo se llame cualquier cosa. */
const SECRET_VALUE_PATTERNS: Array<{ re: RegExp; what: string }> = [
  { re: /\b(?:\d[ -]?){13,19}\b/, what: 'un número de tarjeta' },
  { re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b/, what: 'una llave de Stripe' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, what: 'un pase de GitHub' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, what: 'una llave de Amazon' },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/, what: 'un pase de sesión' },
]

/* ── Barreras ────────────────────────────────────────────────────────── */

/** Corre las cuatro barreras en orden. La primera que rechaza corta. */
export function checkAction(
  action: AgentAction,
  target: ActionTarget,
  context: GuardContext,
): GuardVerdict {
  const barriers = [
    guardOutOfScopeDomain,
    guardSensitiveInput,
    guardAccountDeletionLink,
    guardDestructive,
  ]
  for (const barrier of barriers) {
    const verdict = barrier(action, target, context)
    if (!verdict.allowed) return verdict
  }
  return OK
}

/** Barrera 1 — destructiva sin autorización explícita. */
export function guardDestructive(
  action: AgentAction,
  target: ActionTarget,
  context: GuardContext,
): GuardVerdict {
  if (action.action !== 'click' && action.action !== 'press' && action.action !== 'goto') return OK
  if (context.allowDestructive) return OK

  const haystack = normalize(
    [target.name, target.url, action.value, action.selector].filter(Boolean).join(' '),
  )
  if (haystack.length === 0) return OK
  if (DESTRUCTIVE_EXCEPTIONS.some((exception) => haystack.includes(exception))) return OK

  const hit = DESTRUCTIVE_PHRASES.find((phrase) => haystack.includes(phrase))
  if (!hit) return OK

  return {
    allowed: false,
    code: 'destructiva_sin_permiso',
    reasonPlain:
      'Frené antes de tocar algo que podía borrar o cancelar datos de verdad. ' +
      'Para probar eso hace falta que lo autorices primero.',
  }
}

/** Barrera 2 — datos de pago, documentos o contraseñas del usuario. */
export function guardSensitiveInput(
  action: AgentAction,
  target: ActionTarget,
  context: GuardContext,
): GuardVerdict {
  if (action.action !== 'fill' && action.action !== 'press') return OK
  const value = action.value ?? ''

  const fieldHints = normalize(
    [target.fieldName, target.fieldAutocomplete, target.name, action.selector]
      .filter(Boolean)
      .join(' '),
  )

  if (NEVER_FILL_FIELD_HINTS.some((hint) => fieldHints.includes(hint))) {
    return {
      allowed: false,
      code: 'dato_sensible',
      reasonPlain:
        'La app me pidió datos de pago o de documento. No los cargo nunca, ' +
        'ni siquiera inventados, así que me detuve acá.',
    }
  }

  const secret = SECRET_VALUE_PATTERNS.find((pattern) => pattern.re.test(value))
  if (secret) {
    return {
      allowed: false,
      code: 'dato_sensible',
      reasonPlain: `Frené porque lo que iba a escribir parecía ${secret.what}. No escribo datos así en ningún formulario.`,
    }
  }

  const isPasswordField =
    target.fieldType === 'password' ||
    fieldHints.includes('password') ||
    fieldHints.includes('contrasena') ||
    fieldHints.includes('clave')

  if (isPasswordField) {
    const allowed = context.testAccount?.password
    if (!allowed || value !== allowed) {
      return {
        allowed: false,
        code: 'dato_sensible',
        reasonPlain:
          'La app me pidió una contraseña y la única que puedo usar es la de la cuenta ' +
          'de prueba que autorizaste. No escribo ninguna otra.',
      }
    }
  }

  return OK
}

/** Barrera 3 — salir del dominio autorizado. */
export function guardOutOfScopeDomain(
  action: AgentAction,
  target: ActionTarget,
  context: GuardContext,
): GuardVerdict {
  const candidate = action.action === 'goto' ? (action.value ?? action.selector) : target.url
  if (!candidate) return OK
  if (candidate.startsWith('#') || candidate.startsWith('/')) return OK
  if (/^(mailto|tel|sms|javascript|data|blob):/i.test(candidate)) {
    if (/^javascript:/i.test(candidate)) {
      return {
        allowed: false,
        code: 'fuera_del_dominio',
        reasonPlain: 'Ese enlace ejecutaba código en vez de llevar a una página. No lo abrí.',
      }
    }
    return OK
  }

  let origin: string
  try {
    origin = new URL(candidate, context.allowedOrigins[0]).origin
  } catch {
    return OK
  }

  if (context.allowedOrigins.includes(origin)) return OK

  return {
    allowed: false,
    code: 'fuera_del_dominio',
    reasonPlain: `Ese enlace salía de tu app y llevaba a ${origin}. Me quedé adentro de tu sitio.`,
  }
}

/** Barrera 4 — enlace de cierre de cuenta fuera de la tarea de borrado. */
export function guardAccountDeletionLink(
  action: AgentAction,
  target: ActionTarget,
  context: GuardContext,
): GuardVerdict {
  if (context.taskId === 'delete_account') return OK
  if (action.action !== 'click' && action.action !== 'goto') return OK

  const haystack = normalize([target.name, target.url, action.value].filter(Boolean).join(' '))
  const hit = ACCOUNT_DELETION_PHRASES.find((phrase) => haystack.includes(phrase))
  if (!hit) return OK

  return {
    allowed: false,
    code: 'cierre_de_cuenta_fuera_de_lugar',
    reasonPlain:
      'Encontré la opción de cerrar la cuenta, pero no la toqué porque en este momento ' +
      'estaba probando otra cosa.',
  }
}

/* ── Ayudas para las tareas ──────────────────────────────────────────── */

/** ¿Este texto habla de borrar la cuenta? Lo usa la tarea de borrado para buscar. */
export function looksLikeAccountDeletion(text: string): boolean {
  const haystack = normalize(text)
  return ACCOUNT_DELETION_PHRASES.some((phrase) => haystack.includes(phrase))
}

export function looksDestructive(text: string): boolean {
  const haystack = normalize(text)
  if (DESTRUCTIVE_EXCEPTIONS.some((exception) => haystack.includes(exception))) return false
  return DESTRUCTIVE_PHRASES.some((phrase) => haystack.includes(phrase))
}

/** Orígenes autorizados a partir de la dirección desplegada del proyecto. */
export function allowedOriginsFor(deployedUrl: string): string[] {
  const origins = new Set<string>()
  try {
    const url = new URL(deployedUrl)
    origins.add(url.origin)
    // `www` y el dominio pelado son la misma app para el usuario.
    if (url.hostname.startsWith('www.')) {
      origins.add(`${url.protocol}//${url.hostname.slice(4)}${url.port ? `:${url.port}` : ''}`)
    } else {
      origins.add(`${url.protocol}//www.${url.hostname}${url.port ? `:${url.port}` : ''}`)
    }
  } catch {
    // Dirección inválida: no se autoriza nada y el preflight lo reporta como bloqueado.
  }
  return [...origins]
}
