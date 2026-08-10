/**
 * Las tareas que necesitan criterio: registro, ingreso, editar el perfil y el
 * recorrido principal de la app.
 *
 * Estas no se pueden resolver con una lista de direcciones porque cada app las
 * resuelve distinto. Acá sí conduce el modelo, paso a paso, con las barreras de
 * seguridad delante de cada acción. Lo que el modelo decide es por dónde ir; lo que
 * el usuario lee lo escribimos nosotros.
 *
 * Lo usan: `src/server/agent/tasks/index.ts`.
 */

import 'server-only'

import { normalize, parseAriaSnapshot } from '../aria'
import { drive, defaultFakeProfile, type DriveResult } from '../driver'
import { conclusions, conDesbordeMovil } from './conclusions'
import {
  PHRASES,
  PLACES,
  findOnScreen,
  loginWith,
  looksLikePaywall,
  openAndRead,
  sweep,
  type TaskContext,
  type TaskOutcomeDraft,
} from './shared'

const CONFIRMATION_PHRASES = [
  'revisa tu correo',
  'revisa tu email',
  'confirma tu correo',
  'confirma tu email',
  'te enviamos un correo',
  'te mandamos un correo',
  'verifica tu correo',
  'verificacion',
  'check your email',
  'confirm your email',
  'verify your email',
  'confirmation link',
]

/* ── Registro ────────────────────────────────────────────────────────── */

export async function runSignup(context: TaskContext): Promise<TaskOutcomeDraft> {
  const { browser, deployedUrl } = context

  const entry = await sweep(browser, deployedUrl, [PLACES.home, ...PLACES.signup], [...PHRASES.signup], {
    stopOnFirstHit: true,
  })

  if (entry.hits.length === 0 && entry.visitedLabels.length > 0) {
    const hasForm = (await browser.page.locator('input[type="password"]').count()) > 0
    if (!hasForm) {
      return {
        outcome: 'not_found',
        conclusionPlain: conclusions.signupNoEncontrado(entry.visitedLabels),
      }
    }
  }

  const fake = defaultFakeProfile()
  const result = await runDriver(context, {
    extraGuidance:
      'Completá el formulario de registro con los datos inventados. Después de enviarlo, ' +
      'fijate si la app te deja entrar directo o si te pide confirmar el correo primero.',
    fakeProfile: fake,
  })

  if (result.ending === 'error') {
    return { outcome: 'error', conclusionPlain: conclusions.errorInesperado() }
  }

  const tree = parseAriaSnapshot(await browser.page.ariaSnapshot({ mode: 'ai' }))
  const haystack = normalize(tree.nodes.map((node) => node.name).join(' '))
  const asksConfirmation = CONFIRMATION_PHRASES.some((phrase) => haystack.includes(normalize(phrase)))
  const stillOnForm = (await browser.page.locator('input[type="password"]').count()) > 0

  if (asksConfirmation) {
    return { outcome: 'completed', conclusionPlain: conclusions.signupPideConfirmar() }
  }
  if (result.ending === 'done' && !stillOnForm) {
    return { outcome: 'completed', conclusionPlain: conclusions.signupSinConfirmacion() }
  }
  if (result.ending === 'give_up') {
    return {
      outcome: 'not_found',
      conclusionPlain: conclusions.signupNoEncontrado(
        entry.visitedLabels.length > 0 ? entry.visitedLabels : ['la portada'],
      ),
    }
  }
  return { outcome: 'blocked', conclusionPlain: conclusions.signupFallo() }
}

/* ── Ingreso ─────────────────────────────────────────────────────────── */

export async function runLogin(context: TaskContext): Promise<TaskOutcomeDraft> {
  const account = context.testAccounts[0]
  const result = await loginWith(context, account)

  if (result.ok) return { outcome: 'completed', conclusionPlain: conclusions.loginOk() }

  if (result.reason === 'sin_formulario') {
    const searched = result.searchedLabels.length > 0 ? result.searchedLabels : ['la portada']
    return { outcome: 'not_found', conclusionPlain: conclusions.loginNoEncontrado(searched) }
  }
  if (result.reason === 'sin_cuenta') {
    return { outcome: 'blocked', conclusionPlain: conclusions.appPideEntrar() }
  }
  return { outcome: 'blocked', conclusionPlain: conclusions.loginRechazado() }
}

/* ── Editar el perfil ────────────────────────────────────────────────── */

export async function runEditProfile(context: TaskContext): Promise<TaskOutcomeDraft> {
  const login = await loginWith(context, context.testAccounts[0])
  if (!login.ok) {
    return { outcome: 'blocked', conclusionPlain: conclusions.appPideEntrar() }
  }

  const entry = await sweep(context.browser, context.deployedUrl, PLACES.account, [...PHRASES.editProfile], {
    stopOnFirstHit: true,
  })
  if (entry.hits.length === 0) {
    const labels = entry.visitedLabels.length > 0 ? entry.visitedLabels : ['la pantalla de cuenta']
    return { outcome: 'not_found', conclusionPlain: conclusions.editProfileNoEncontrado(labels) }
  }

  const marker = `Ana Prueba ${Date.now().toString(36).slice(-4)}`
  const result = await runDriver(context, {
    extraGuidance:
      `Cambiá el nombre visible del perfil por exactamente "${marker}" y guardá. ` +
      'Cuando lo hayas guardado, terminá.',
  })

  if (result.ending === 'error') {
    return { outcome: 'error', conclusionPlain: conclusions.errorInesperado() }
  }

  // La prueba real: volver a entrar a la pantalla y ver si el cambio sobrevivió.
  const reopened = await openAndRead(
    context.browser,
    entry.hits[0].url,
    'Volví a entrar al perfil para ver si el cambio quedó guardado.',
  )
  const persisted =
    reopened !== null && normalize(reopened.text).includes(normalize(marker))

  return persisted
    ? { outcome: 'completed', conclusionPlain: conclusions.editProfileOk() }
    : { outcome: 'completed', conclusionPlain: conclusions.editProfileNoGuarda() }
}

/* ── Recorrido principal ─────────────────────────────────────────────── */

export async function runPrimaryFlow(context: TaskContext): Promise<TaskOutcomeDraft> {
  const home = await openAndRead(context.browser, context.deployedUrl, 'Abrí tu app como un visitante nuevo.')
  if (!home) {
    return { outcome: 'blocked', conclusionPlain: conclusions.appNoResponde(context.deployedUrl) }
  }

  const result = await runDriver(context, {
    extraGuidance:
      'Hacé lo principal que ofrece la app desde la portada, como un visitante que entra ' +
      'por primera vez. Si llegás a una pantalla de pago, frená ahí y terminá.',
  })

  if (result.ending === 'error') {
    return { outcome: 'error', conclusionPlain: conclusions.errorInesperado() }
  }

  const tree = parseAriaSnapshot(await context.browser.page.ariaSnapshot({ mode: 'ai' }))
  if (looksLikePaywall(tree)) {
    return { outcome: 'blocked', conclusionPlain: conclusions.appDetrasDeMuro() }
  }
  if (findOnScreen(tree, [...PHRASES.login]).length > 0 && context.testAccounts.length === 0) {
    return { outcome: 'blocked', conclusionPlain: conclusions.appPideEntrar() }
  }

  const summary = result.lastWhy.trim().length > 0 ? capitalize(result.lastWhy.trim()) : 'Terminé el recorrido.'
  const overflow = context.mobileOverflow

  const base =
    result.ending === 'done'
      ? conclusions.primaryFlowOk(summary)
      : conclusions.primaryFlowTrabado(summary)

  return {
    outcome: result.ending === 'done' ? 'completed' : 'blocked',
    conclusionPlain: conDesbordeMovil(base, overflow?.overflow ? overflow.offenders : []),
  }
}

/* ── Ayuda común ─────────────────────────────────────────────────────── */

async function runDriver(
  context: TaskContext,
  options: { extraGuidance?: string; fakeProfile?: ReturnType<typeof defaultFakeProfile> },
): Promise<DriveResult> {
  return drive({
    browser: context.browser,
    task: context.task,
    complete: context.complete,
    completeJson: context.completeJson,
    cost: context.cost,
    allowDestructive: context.allowDestructive,
    allowedOrigins: context.allowedOrigins,
    testAccount: context.testAccounts[0],
    fakeProfile: options.fakeProfile,
    signal: context.signal,
    extraGuidance: options.extraGuidance,
  })
}

function capitalize(text: string): string {
  const trimmed = text.replace(/^["']|["']$/g, '')
  const withStop = /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`
  return withStop.charAt(0).toUpperCase() + withStop.slice(1)
}
