/**
 * Puente entre el agente y el modelo.
 *
 * El agente pide una función `complete(prompt)` y no quiere saber nada del
 * proveedor: así se puede correr con un modelo falso en las pruebas y cambiar de
 * proveedor sin tocar el motor. El wrapper del proyecto (`@/server/llm/client`)
 * ya devuelve el consumo y el costo real de cada llamada, así que acá se pasa
 * ese número tal cual en vez de estimarlo — el costo que ve el usuario es el que
 * se pagó, no una cuenta nuestra.
 */

import 'server-only'

import { complete as completeAnthropic, defaultModel } from '@/server/llm/client'
import type { LlmComplete } from './types'

/**
 * Instrucción de sistema del agente. Corta y en castellano: el que la lee es un
 * modelo, pero lo que decide termina describiéndose al usuario en su idioma.
 */
const SISTEMA =
  'Sos un auditor que prueba una aplicación web como lo haría una persona real. ' +
  'Elegís un paso por vez sobre lo que se ve en pantalla. Nunca inventás elementos ' +
  'que no estén en la lista que te pasan.'

export function crearComplete(): LlmComplete {
  return async (prompt, options) => {
    const resultado = await completeAnthropic({
      system: SISTEMA,
      messages: [{ role: 'user', content: prompt }],
      maxTokens: options?.maxTokens ?? 700,
      detail: options?.purpose ? `agente: ${options.purpose}` : 'agente navegando tu app',
      ...(options?.signal ? { signal: options.signal } : {}),
    })

    return {
      text: resultado.text,
      usage: {
        inputTokens: resultado.usage.inputTokens,
        outputTokens: resultado.usage.outputTokens,
        costUsd: resultado.costUsd,
        model: resultado.model,
      },
    }
  }
}

export { defaultModel }
