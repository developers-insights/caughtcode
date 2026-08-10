/**
 * El bucle que decide qué hacer: observar → decidir → actuar.
 *
 * En cada vuelta se toma el árbol de accesibilidad de la página (no el HTML crudo:
 * es más barato y no se rompe cuando el framework reordena clases), se le pasa al
 * modelo junto con el objetivo y lo que ya se hizo, y el modelo devuelve UNA acción.
 * Esa acción se valida con `zod` y pasa por las barreras de seguridad antes de
 * ejecutarse. Si el modelo alucina un formato, el paso se descarta, no se ejecuta.
 *
 * La función que habla con el modelo llega inyectada por parámetro: acá no se importa
 * ningún cliente de IA. Eso permite correr todo el circuito con un modelo falso y
 * determinístico en las pruebas.
 *
 * Lo usan: `src/server/agent/tasks/**`.
 */

import 'server-only'

import { z } from 'zod'
import type { Locator } from 'playwright'

import type { AgentStep, AgentTask } from '@/lib/types/domain'
import type { AgentBrowser } from './browser'
import type { CostMeter } from './cost'
import type { AgentAction, LlmComplete, LlmCompleteJson, TestAccount } from './types'
import { readTextResult } from './types'
import { parseAriaSnapshot, summarizeForModel, type AriaNode, type AriaTree } from './aria'
import { checkAction, type ActionTarget, type GuardContext } from './guards'
import { redactUrl } from './redact'

/** Contrato de lo que el modelo puede pedir. Cualquier otra cosa se rechaza. */
export const AgentActionSchema = z.object({
  action: z.enum(['click', 'fill', 'press', 'goto', 'scroll', 'done', 'give_up']),
  selector: z.string().max(400).optional(),
  value: z.string().max(500).optional(),
  why: z.string().max(400),
})

export interface DriveOptions {
  browser: AgentBrowser
  task: AgentTask
  complete: LlmComplete
  completeJson?: LlmCompleteJson
  cost: CostMeter
  allowDestructive: boolean
  allowedOrigins: string[]
  testAccount?: TestAccount
  /** Datos inventados que el agente puede usar para completar formularios. */
  fakeProfile?: FakeProfile
  maxSteps?: number
  signal?: AbortSignal
  /** Instrucciones extra específicas de la tarea. */
  extraGuidance?: string
}

export interface FakeProfile {
  email: string
  password: string
  fullName: string
  phone: string
}

export interface DriveResult {
  /** Cómo terminó el bucle. */
  ending: 'done' | 'give_up' | 'max_steps' | 'error'
  /** Última explicación del modelo. Se usa para armar la conclusión de la tarea. */
  lastWhy: string
  steps: AgentStep[]
  /** Barreras que se activaron. Sirve para explicar por qué el agente no siguió. */
  blocked: Array<{ code: string; reasonPlain: string }>
  error?: string
}

/** Datos inventados por defecto. Nunca son datos reales de nadie. */
export function defaultFakeProfile(seed = Date.now()): FakeProfile {
  const tag = seed.toString(36).slice(-6)
  return {
    email: `prueba.caughtcode.${tag}@example.com`,
    password: `Prueba-${tag}-2026`,
    fullName: 'Ana Prueba',
    phone: '1122334455',
  }
}

const SYSTEM_RULES = `Sos un agente que prueba aplicaciones web reales para detectar problemas.
Trabajás sobre la app de una persona que no sabe programar: lo que encontrás se le muestra en video.

Reglas:
- Devolvés UNA sola acción por vez, en JSON, sin texto alrededor y sin bloques de código.
- Para "click", "fill" y "press" el campo "selector" tiene que ser una referencia del árbol,
  con la forma exacta ref=eN, tomada de la lista de elementos que te paso.
- Para "goto" el campo "value" lleva la dirección (puede ser relativa, ej. /ajustes).
- Para "fill" el campo "value" lleva el texto a escribir.
- Nunca escribas datos de tarjeta, documentos ni contraseñas que no te haya dado el sistema.
- Si el objetivo ya se cumplió, devolvés {"action":"done"}.
- Si el camino no existe en esta app, devolvés {"action":"give_up"} y explicás en "why"
  DÓNDE buscaste. Eso es un resultado válido y útil, no un fracaso.
- "why" va en español rioplatense, en una frase corta, sin términos técnicos.

Formato exacto:
{"action":"click|fill|press|goto|scroll|done|give_up","selector":"ref=e12","value":"texto","why":"por qué"}`

export async function drive(options: DriveOptions): Promise<DriveResult> {
  const {
    browser,
    task,
    complete,
    completeJson,
    cost,
    allowDestructive,
    allowedOrigins,
    testAccount,
    fakeProfile = defaultFakeProfile(),
    signal,
    extraGuidance,
  } = options

  const maxSteps = options.maxSteps ?? task.maxSteps
  const guardContext: GuardContext = {
    taskId: task.id,
    allowDestructive,
    allowedOrigins,
    testAccount,
  }

  const blocked: DriveResult['blocked'] = []
  const history: string[] = []
  let lastWhy = ''

  for (let attempt = 0; attempt < maxSteps; attempt += 1) {
    if (signal?.aborted) {
      return { ending: 'error', lastWhy, steps: browser.steps, blocked, error: 'La corrida se canceló.' }
    }
    cost.assertUnderCap()

    let tree: AriaTree
    try {
      tree = parseAriaSnapshot(await browser.page.ariaSnapshot({ mode: 'ai' }))
    } catch (error) {
      return {
        ending: 'error',
        lastWhy,
        steps: browser.steps,
        blocked,
        error: describe(error),
      }
    }

    const prompt = buildPrompt({
      task,
      tree,
      url: redactUrl(browser.page.url()),
      history,
      testAccount,
      fakeProfile,
      remainingSteps: maxSteps - attempt,
      extraGuidance,
    })

    let action: AgentAction
    try {
      action = await askForAction(prompt, { complete, completeJson, cost, task: task.id, signal })
    } catch (error) {
      await browser.record({
        action: 'error',
        note: `No pude decidir el siguiente paso: ${describe(error)}`,
        screenshot: false,
      })
      return { ending: 'error', lastWhy, steps: browser.steps, blocked, error: describe(error) }
    }

    lastWhy = action.why

    if (action.action === 'done' || action.action === 'give_up') {
      await browser.record({
        action: action.action,
        note: action.why,
      })
      return { ending: action.action, lastWhy, steps: browser.steps, blocked }
    }

    const node = resolveNode(tree, action.selector)
    const target = await buildTarget(browser, node, action)
    const verdict = checkAction(action, target, guardContext)

    if (!verdict.allowed) {
      blocked.push({ code: verdict.code, reasonPlain: verdict.reasonPlain })
      const step = await browser.record({
        action: 'blocked',
        target: describeTarget(target, action),
        note: verdict.reasonPlain,
      })
      history.push(`Paso ${step.index}: quise ${describeIntent(action, target)} y me frené. ${verdict.reasonPlain}`)
      continue
    }

    const outcome = await execute(browser, action, node)
    const step = await browser.record({
      action: action.action,
      target: describeTarget(target, action),
      note: outcome.ok ? action.why : `${action.why} — no funcionó: ${outcome.detail}`,
    })
    history.push(
      `Paso ${step.index}: ${describeIntent(action, target)}. ${outcome.ok ? 'Salió bien.' : `Falló: ${outcome.detail}`}`,
    )
  }

  return { ending: 'max_steps', lastWhy, steps: browser.steps, blocked }
}

/* ── Modelo ──────────────────────────────────────────────────────────── */

interface AskOptions {
  complete: LlmComplete
  completeJson?: LlmCompleteJson
  cost: CostMeter
  task: string
  signal?: AbortSignal
}

async function askForAction(prompt: string, options: AskOptions): Promise<AgentAction> {
  const { complete, completeJson, cost, task, signal } = options
  const detail = `agente:${task}`

  if (completeJson) {
    const result = await completeJson(prompt, { purpose: detail, signal })
    cost.recordLlm(result.usage, detail, prompt.length, JSON.stringify(result.json).length)
    return AgentActionSchema.parse(result.json)
  }

  const raw = await complete(prompt, { purpose: detail, maxTokens: 300, signal })
  const { text, usage } = readTextResult(raw)
  cost.recordLlm(usage, detail, prompt.length, text.length)
  return AgentActionSchema.parse(extractJson(text))
}

/** El modelo a veces envuelve el JSON en explicaciones o en un bloque de código. */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1] : text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) {
    throw new Error('El modelo no devolvió una acción con el formato esperado.')
  }
  return JSON.parse(candidate.slice(start, end + 1))
}

function buildPrompt(input: {
  task: AgentTask
  tree: AriaTree
  url: string
  history: string[]
  testAccount?: TestAccount
  fakeProfile: FakeProfile
  remainingSteps: number
  extraGuidance?: string
}): string {
  const credentials = input.testAccount
    ? `Cuenta de prueba autorizada: correo ${input.testAccount.email}, contraseña ${input.testAccount.password}.`
    : 'No hay cuenta de prueba autorizada: no podés iniciar sesión con datos reales.'

  const invented =
    `Datos inventados que sí podés usar en formularios: correo ${input.fakeProfile.email}, ` +
    `contraseña ${input.fakeProfile.password}, nombre ${input.fakeProfile.fullName}, ` +
    `teléfono ${input.fakeProfile.phone}.`

  return [
    SYSTEM_RULES,
    '',
    `OBJETIVO DE ESTA PRUEBA:\n${input.task.goal}`,
    input.extraGuidance ? `\nINDICACIONES EXTRA:\n${input.extraGuidance}` : '',
    '',
    credentials,
    invented,
    `Te quedan ${input.remainingSteps} pasos.`,
    '',
    `DIRECCIÓN ACTUAL: ${input.url}`,
    '',
    'ELEMENTOS DE LA PANTALLA:',
    summarizeForModel(input.tree) || '(la pantalla no expone elementos)',
    '',
    input.history.length > 0 ? `LO QUE YA HICISTE:\n${input.history.slice(-8).join('\n')}` : 'Todavía no hiciste nada.',
    '',
    'Devolvé solo el JSON de la próxima acción.',
  ]
    .filter((line) => line !== '')
    .join('\n')
}

/* ── Resolución y ejecución ──────────────────────────────────────────── */

function resolveNode(tree: AriaTree, selector?: string): AriaNode | undefined {
  if (!selector) return undefined
  const ref = selector.match(/^(?:ref=)?(e\d+)$/i)?.[1] ?? selector.match(/\[?ref=(e\d+)\]?/i)?.[1]
  if (!ref) return undefined
  return tree.byRef.get(ref)
}

function toLocator(browser: AgentBrowser, selector: string, node?: AriaNode): Locator {
  if (node?.ref) return browser.page.locator(`aria-ref=${node.ref}`)
  const ref = selector.match(/^(?:ref=)?(e\d+)$/i)?.[1]
  if (ref) return browser.page.locator(`aria-ref=${ref}`)
  return browser.page.locator(selector)
}

/** Lee los atributos del campo para que las barreras sepan qué le están pidiendo. */
async function buildTarget(
  browser: AgentBrowser,
  node: AriaNode | undefined,
  action: AgentAction,
): Promise<ActionTarget> {
  const target: ActionTarget = {
    name: node?.name,
    role: node?.role,
    url: node?.url ?? (action.action === 'goto' ? action.value : undefined),
  }

  if (action.action !== 'fill' && action.action !== 'press') return target
  if (!action.selector) return target

  try {
    const locator = toLocator(browser, action.selector, node)
    const attributes = await locator.first().evaluate((element) => {
      const input = element as HTMLInputElement
      return {
        fieldName: input.getAttribute('name') ?? input.getAttribute('id') ?? '',
        fieldType: input.getAttribute('type') ?? '',
        fieldAutocomplete: input.getAttribute('autocomplete') ?? '',
      }
    })
    return { ...target, ...attributes }
  } catch {
    // Si el elemento ya no está, la barrera decide con lo que sabe del árbol.
    return target
  }
}

interface ExecuteOutcome {
  ok: boolean
  detail: string
}

async function execute(
  browser: AgentBrowser,
  action: AgentAction,
  node?: AriaNode,
): Promise<ExecuteOutcome> {
  const page = browser.page
  try {
    switch (action.action) {
      case 'click': {
        if (!action.selector) return { ok: false, detail: 'no me dijo qué tocar' }
        await toLocator(browser, action.selector, node).first().click({ timeout: 8_000 })
        break
      }
      case 'fill': {
        if (!action.selector) return { ok: false, detail: 'no me dijo qué campo completar' }
        await toLocator(browser, action.selector, node)
          .first()
          .fill(action.value ?? '', { timeout: 8_000 })
        break
      }
      case 'press': {
        const key = action.value || 'Enter'
        if (action.selector) {
          await toLocator(browser, action.selector, node).first().press(key, { timeout: 8_000 })
        } else {
          await page.keyboard.press(key)
        }
        break
      }
      case 'goto': {
        const destination = action.value ?? action.selector ?? '/'
        await page.goto(destination, { waitUntil: 'domcontentloaded', timeout: 15_000 })
        break
      }
      case 'scroll': {
        await page.mouse.wheel(0, 600)
        break
      }
      default:
        return { ok: false, detail: 'acción desconocida' }
    }

    // Dar aire a la app para que reaccione antes de la próxima observación.
    await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => {})
    await page.waitForTimeout(250)
    return { ok: true, detail: '' }
  } catch (error) {
    return { ok: false, detail: describe(error) }
  }
}

/* ── Texto para el registro ──────────────────────────────────────────── */

function describeTarget(target: ActionTarget, action: AgentAction): string {
  if (target.name) return target.name
  if (action.action === 'goto') return action.value ?? ''
  return action.selector ?? ''
}

function describeIntent(action: AgentAction, target: ActionTarget): string {
  const what = target.name ? `"${target.name}"` : (action.selector ?? '')
  switch (action.action) {
    case 'click':
      return `tocar ${what}`
    case 'fill':
      return `completar ${what}`
    case 'press':
      return `apretar ${action.value || 'Enter'} en ${what}`
    case 'goto':
      return `ir a ${action.value ?? ''}`
    case 'scroll':
      return 'bajar en la pantalla'
    default:
      return action.action
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message.split('\n')[0].slice(0, 200)
  return String(error).slice(0, 200)
}
