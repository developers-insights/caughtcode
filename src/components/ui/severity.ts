/**
 * Traducción de dominio → lenguaje visual.
 *
 * Hay DOS ejes distintos y no hay que mezclarlos:
 *
 *   severity  (critical | high | medium | low)   → cuánto pesa
 *   tone      (expuesto | incompleto | ...)      → qué clase de estado es
 *
 * El color viene del `tone`. El peso visual viene del `emphasis`.
 * Un hallazgo grave y uno menor se distinguen por ESTRUCTURA (marca al
 * margen, fondo teñido, tamaño del título), no solo por color — hay gente
 * que no distingue rojo de verde.
 *
 * Esta es la única fuente de esa traducción. Ningún frente define la suya.
 */

import type { Confidence, FindingStatus, Severity } from '@/lib/types/domain'

export type Tone = 'expuesto' | 'incompleto' | 'verificado' | 'revisar' | 'neutral'

/**
 * Cuánto grita el componente.
 *   stamp   — sello: fondo teñido, marca al margen, título grande. Solo `critical`.
 *   marked  — marca al margen, sin teñir el fondo.
 *   soft    — insignia tenue.
 *   quiet   — un punto y texto. Nada más.
 */
export type Emphasis = 'stamp' | 'marked' | 'soft' | 'quiet'

export interface VisualState {
  tone: Tone
  emphasis: Emphasis
}

/* ── Etiquetas visibles al usuario ─────────────────────────────────────── */

export const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Grave',
  high: 'Importante',
  medium: 'A mejorar',
  low: 'Menor',
}

/** Qué tan urgente es, en una frase. Se usa como subtítulo de la insignia. */
export const SEVERITY_URGENCY: Record<Severity, string> = {
  critical: 'Arreglalo hoy',
  high: 'Arreglalo esta semana',
  medium: 'Cuando puedas',
  low: 'Sin apuro',
}

export const CONFIDENCE_LABEL: Record<Confidence, string> = {
  confirmed: 'Comprobado',
  likely: 'Muy probable',
  to_review: 'A revisar',
}

/** Por qué mostramos ese nivel de confianza. Va en el tooltip. */
export const CONFIDENCE_HINT: Record<Confidence, string> = {
  confirmed: 'Lo probamos y pasó. Podés ver la prueba.',
  likely: 'Encontramos la señal en tu código, pero no lo pudimos probar en vivo.',
  to_review: 'Vimos algo que puede ser esto. Conviene que lo mires vos.',
}

export const STATUS_LABEL: Record<FindingStatus, string> = {
  open: 'Sin resolver',
  fixed: 'Resuelto',
  dismissed: 'Descartado',
}

export const TONE_LABEL: Record<Tone, string> = {
  expuesto: 'Expuesto',
  incompleto: 'Incompleto',
  verificado: 'Verificado',
  revisar: 'A revisar',
  neutral: 'Sin marcar',
}

/* ── Mapeo ─────────────────────────────────────────────────────────────── */

/**
 * Regla, en orden:
 *   1. Resuelto            → verde, callado.
 *   2. Descartado          → neutro, callado.
 *   3. Confianza baja      → azul apagado. Si no estamos seguros, no gritamos.
 *   4. Grave / importante  → rojo.
 *   5. A mejorar           → ámbar.
 *   6. Menor               → neutro. Un hallazgo menor no lleva color.
 */
export function visualFor(input: {
  severity: Severity
  confidence?: Confidence
  status?: FindingStatus
}): VisualState {
  const { severity, confidence = 'confirmed', status = 'open' } = input

  if (status === 'fixed') return { tone: 'verificado', emphasis: 'quiet' }
  if (status === 'dismissed') return { tone: 'neutral', emphasis: 'quiet' }

  if (confidence === 'to_review') {
    return { tone: 'revisar', emphasis: severity === 'critical' ? 'marked' : 'soft' }
  }

  switch (severity) {
    case 'critical':
      return { tone: 'expuesto', emphasis: 'stamp' }
    case 'high':
      return { tone: 'expuesto', emphasis: 'marked' }
    case 'medium':
      return { tone: 'incompleto', emphasis: 'soft' }
    case 'low':
      return { tone: 'neutral', emphasis: 'quiet' }
  }
}

/* ── Clases por tono ───────────────────────────────────────────────────────
   Se exportan como mapas literales (no plantillas) para que Tailwind las vea
   al escanear el archivo. No armes nombres de clase concatenando strings. */

export const TONE_SOFT_BG: Record<Tone, string> = {
  expuesto: 'bg-expuesto-soft',
  incompleto: 'bg-incompleto-soft',
  verificado: 'bg-verificado-soft',
  revisar: 'bg-revisar-soft',
  neutral: 'bg-canvas-sunken',
}

export const TONE_BORDER: Record<Tone, string> = {
  expuesto: 'border-expuesto-border',
  incompleto: 'border-incompleto-border',
  verificado: 'border-verificado-border',
  revisar: 'border-revisar-border',
  neutral: 'border-line',
}

export const TONE_TEXT: Record<Tone, string> = {
  expuesto: 'text-expuesto-text',
  incompleto: 'text-incompleto-text',
  verificado: 'text-verificado-text',
  revisar: 'text-revisar-text',
  neutral: 'text-ink-muted',
}

export const TONE_SOLID_BG: Record<Tone, string> = {
  expuesto: 'bg-expuesto',
  incompleto: 'bg-incompleto',
  verificado: 'bg-verificado',
  revisar: 'bg-revisar',
  neutral: 'bg-ink',
}

export const TONE_ON_SOLID: Record<Tone, string> = {
  expuesto: 'text-expuesto-on',
  incompleto: 'text-incompleto-on',
  verificado: 'text-verificado-on',
  revisar: 'text-revisar-on',
  neutral: 'text-ink-inverse',
}

/** Marca de 3px al margen izquierdo. El recurso que hace que un hallazgo
 *  grave se note desde lejos sin leer una palabra. */
export const TONE_EDGE: Record<Tone, string> = {
  expuesto: 'before:bg-expuesto',
  incompleto: 'before:bg-incompleto',
  verificado: 'before:bg-verificado',
  revisar: 'before:bg-revisar',
  neutral: 'before:bg-line-strong',
}
