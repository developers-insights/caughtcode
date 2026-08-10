/**
 * Las tres pruebas de "flujo que debería existir y no está".
 *
 * Recuperar contraseña, cerrar sesión y borrar la cuenta. Son los hallazgos más
 * fuertes del pilar de completitud porque son binarios: o el camino existe o no.
 * Nada de interpretación.
 *
 * El método es siempre el mismo y por eso se puede mostrar en video: recorrer las
 * pantallas donde una persona buscaría, mirar el árbol de cada una, y decir dónde
 * se buscó. "No lo encontré" sin decir dónde no es evidencia.
 *
 * Lo usan: `src/server/agent/tasks/index.ts`.
 */

import 'server-only'

import { parseAriaSnapshot } from '../aria'
import { conclusions } from './conclusions'
import {
  PHRASES,
  PLACES,
  findOnScreen,
  loginWith,
  openAndRead,
  sweep,
  type TaskContext,
  type TaskOutcomeDraft,
} from './shared'

/* ── Recuperar contraseña ────────────────────────────────────────────── */

export async function runPasswordReset(context: TaskContext): Promise<TaskOutcomeDraft> {
  const { browser, deployedUrl } = context
  const searched: string[] = []

  // 1. La pantalla de ingreso es donde una persona buscaría primero.
  const loginSweep = await sweep(browser, deployedUrl, [PLACES.home, ...PLACES.login], [...PHRASES.login], {
    stopOnFirstHit: true,
  })
  searched.push(...loginSweep.visitedLabels)

  let foundOnLogin = false
  const currentTree = parseAriaSnapshot(await browser.page.ariaSnapshot({ mode: 'ai' }))
  if (findOnScreen(currentTree, [...PHRASES.passwordReset]).length > 0) foundOnLogin = true

  if (!foundOnLogin) {
    // A veces el enlace vive detrás del formulario: se prueba abrir el ingreso real.
    const onLogin = await sweep(browser, deployedUrl, PLACES.login, [...PHRASES.passwordReset], {
      stopOnFirstHit: true,
    })
    for (const label of onLogin.visitedLabels) if (!searched.includes(label)) searched.push(label)
    if (onLogin.hits.length > 0) foundOnLogin = true
  }

  if (foundOnLogin) {
    await browser.record({
      action: 'found',
      note: 'Encontré el enlace para recuperar la contraseña en la pantalla de ingreso.',
    })
    return { outcome: 'completed', conclusionPlain: conclusions.passwordResetOk() }
  }

  // 2. Las direcciones habituales de recuperación, por si el enlace no está pero la pantalla sí.
  const direct = await sweep(browser, deployedUrl, PLACES.passwordReset, [...PHRASES.passwordReset], {
    stopOnFirstHit: true,
  })
  for (const label of direct.visitedLabels) if (!searched.includes(label)) searched.push(label)

  if (direct.hits.length > 0) {
    await browser.record({
      action: 'found',
      note: 'La pantalla de recuperación existe, pero no se llega a ella desde el ingreso.',
    })
    return { outcome: 'completed', conclusionPlain: conclusions.passwordResetIncompleto() }
  }

  if (searched.length === 0) searched.push('la portada')
  await browser.record({
    action: 'not_found',
    note: `Busqué en ${searched.join(', ')} y no hay forma de recuperar la contraseña.`,
  })
  return { outcome: 'not_found', conclusionPlain: conclusions.passwordResetFaltante(searched) }
}

/* ── Cerrar sesión ───────────────────────────────────────────────────── */

export async function runLogout(context: TaskContext): Promise<TaskOutcomeDraft> {
  const account = context.testAccounts[0]
  const login = await loginWith(context, account)
  if (!login.ok) {
    return { outcome: 'blocked', conclusionPlain: conclusions.appPideEntrar() }
  }

  const searched = ['la pantalla donde quedé después de entrar']
  const afterLogin = parseAriaSnapshot(await context.browser.page.ariaSnapshot({ mode: 'ai' }))
  if (findOnScreen(afterLogin, [...PHRASES.logout]).length > 0) {
    await context.browser.record({ action: 'found', note: 'Encontré cómo cerrar la sesión.' })
    return { outcome: 'completed', conclusionPlain: conclusions.logoutOk() }
  }

  const result = await sweep(context.browser, context.deployedUrl, PLACES.account, [...PHRASES.logout], {
    stopOnFirstHit: true,
  })
  for (const label of result.visitedLabels) if (!searched.includes(label)) searched.push(label)

  if (result.hits.length > 0) {
    await context.browser.record({ action: 'found', note: 'Encontré cómo cerrar la sesión.' })
    return { outcome: 'completed', conclusionPlain: conclusions.logoutOk() }
  }

  await context.browser.record({
    action: 'not_found',
    note: `Busqué en ${searched.join(', ')} y no hay forma de salir.`,
  })
  return { outcome: 'not_found', conclusionPlain: conclusions.logoutNoEncontrado(searched) }
}

/* ── Borrar la cuenta ────────────────────────────────────────────────── */

export async function runDeleteAccount(context: TaskContext): Promise<TaskOutcomeDraft> {
  const account = context.testAccounts[0]
  const login = await loginWith(context, account)

  // Sin sesión, las pantallas de cuenta redirigen al ingreso: el resultado no valdría.
  if (!login.ok) {
    return { outcome: 'blocked', conclusionPlain: conclusions.appPideEntrar() }
  }

  const searched: string[] = []
  const afterLogin = parseAriaSnapshot(await context.browser.page.ariaSnapshot({ mode: 'ai' }))
  const onCurrent = findOnScreen(afterLogin, [...PHRASES.deleteAccount])
  if (onCurrent.length > 0) {
    await context.browser.record({
      action: 'found',
      target: onCurrent[0].name,
      note: 'Encontré la opción de borrar la cuenta. No la toqué.',
    })
    return {
      outcome: 'completed',
      conclusionPlain: conclusions.deleteAccountEncontrado('la pantalla principal de la cuenta'),
    }
  }

  const result = await sweep(context.browser, context.deployedUrl, PLACES.account, [...PHRASES.deleteAccount], {
    stopOnFirstHit: true,
  })
  searched.push(...result.visitedLabels)

  if (result.hits.length > 0) {
    await context.browser.record({
      action: 'found',
      target: result.hits[0].node.name,
      note: 'Encontré la opción de borrar la cuenta. No la toqué.',
    })
    return {
      outcome: 'completed',
      conclusionPlain: conclusions.deleteAccountEncontrado(result.hits[0].label),
    }
  }

  if (searched.length === 0) {
    const home = await openAndRead(context.browser, context.deployedUrl, 'Volví a la portada a mirar el menú.')
    searched.push('la portada')
    if (home && findOnScreen(home, [...PHRASES.deleteAccount]).length > 0) {
      return {
        outcome: 'completed',
        conclusionPlain: conclusions.deleteAccountEncontrado('la portada'),
      }
    }
  }

  await context.browser.record({
    action: 'not_found',
    note: `Busqué en ${searched.join(', ')} y no existe la opción de borrar la cuenta.`,
  })
  return { outcome: 'not_found', conclusionPlain: conclusions.deleteAccountFaltante(searched) }
}
