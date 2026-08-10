/**
 * El guion: convierte un hallazgo en las cuatro escenas del clip.
 *
 * Lo usa: `src/server/video/index.ts` (primera etapa) y `scripts/medir-cogs.ts`.
 *
 * REGLA CENTRAL: **el guion no investiga, narra.** El hallazgo ya viene escrito
 * en lenguaje llano desde `src/content/catalogo.ts`; el agente ya hizo lo que
 * hizo. El modelo solo reescribe eso para el oído: frases cortas, primera
 * persona, rioplatense. Si el modelo agrega un archivo, una línea, una cifra o
 * una URL que no está en el hallazgo ni en la grabación, la salida se rechaza.
 *
 * Por eso hay dos caminos y el orden importa:
 *   1. `guionDeterminista` arma el clip solo con texto del catálogo. Es correcto
 *      por construcción: no puede alucinar porque no inventa nada.
 *   2. El modelo lo reescribe para que suene a persona. Si la reescritura no
 *      pasa los controles, se usa el determinista. Nunca se degrada la verdad
 *      para ganar naturalidad.
 *
 * Sin `import 'server-only'`: corre en vitest y bajo tsx.
 */

import { z } from 'zod'

import { detectarJerga } from '@/content/lenguaje'
import type {
  AgentSessionResult,
  AgentStep,
  CodeIndex,
  Evidence,
  Finding,
  Rect,
  VideoScene,
  VideoSceneVisual,
  VideoScript,
} from '@/lib/types/domain'

import {
  ajustarDuraciones,
  estimarVozMs,
  PRESUPUESTO_CARACTERES,
  type SceneRole,
  type TramoEntrada,
} from './timing'

/* ── Inyección del modelo ─────────────────────────────────────────────── */

export interface LlmUsage {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens?: number
  cacheReadInputTokens?: number
}

export interface CompletionResult {
  text: string
  model?: string
  usage?: LlmUsage
}

/**
 * Completado de texto plano. Se acepta `string` a secas para no imponerle una
 * forma al frente que construya el cliente del modelo.
 */
export type CompleteFn = (args: {
  system: string
  prompt: string
  maxTokens?: number
  temperature?: number
}) => Promise<CompletionResult | string>

/** Completado con esquema. Si el frente de LLM lo provee, se usa este. */
export type CompleteJsonFn = <T>(args: {
  system: string
  prompt: string
  schema: z.ZodType<T>
  maxTokens?: number
}) => Promise<{ value: T; model?: string; usage?: LlmUsage }>

export interface ScriptDeps {
  complete?: CompleteFn
  completeJson?: CompleteJsonFn
  /** Cuánto cuesta el uso reportado. Se inyecta para no atar este módulo a `pricing.ts`. */
  costoLlm?: (model: string, usage: LlmUsage) => number
}

/* ── Salida ───────────────────────────────────────────────────────────── */

export interface ResultadoGuion {
  script: VideoScript
  /** true si el texto salió del modelo; false si es el determinista. */
  usoLlm: boolean
  modelo?: string
  costUsd: number
  usage?: LlmUsage
  /** Avisos de contenido: el modelo, la evidencia, el montaje. */
  avisos: string[]
  /**
   * Avisos de duración, **provisorios**: se calculan con la voz estimada.
   * `generateVideo` los descarta y recalcula con el audio ya grabado, así que
   * no hay que mezclarlos con `avisos` o el usuario ve dos veces lo mismo con
   * números distintos.
   */
  avisosTiempo: string[]
}

/* ── Esquema de lo que puede devolver el modelo ───────────────────────── */

const narracionSchema = (role: SceneRole) =>
  z
    .string()
    .trim()
    .min(PRESUPUESTO_CARACTERES[role].min, `La narración de "${role}" es demasiado corta.`)
    .max(PRESUPUESTO_CARACTERES[role].max, `La narración de "${role}" se pasa del presupuesto.`)

export const guionLlmSchema = z.object({
  titulo: z.string().trim().min(4).max(90),
  gancho: z.object({
    narracion: narracionSchema('gancho'),
    placa: z.string().trim().min(4).max(64),
  }),
  demostracion: z
    .array(
      z.object({
        narracion: z.string().trim().min(30).max(260),
        rotulo: z.string().trim().min(3).max(60),
      }),
    )
    .min(1)
    .max(3)
    // El tope por tramo no alcanza: tres tramos al máximo se irían muy por
    // encima de los 40 s que admite la demostración. El que manda es el total.
    .refine(
      (tramos) =>
        tramos.reduce((a, t) => a + t.narracion.length, 0) <=
        PRESUPUESTO_CARACTERES.demostracion.max,
      `La demostración entera no puede pasar de ${PRESUPUESTO_CARACTERES.demostracion.max} caracteres.`,
    ),
  prueba: z.object({
    narracion: narracionSchema('prueba'),
    rotulo: z.string().trim().min(3).max(60),
  }),
  accion: z.object({
    narracion: narracionSchema('accion'),
    placa: z.string().trim().min(4).max(64),
  }),
})

export type GuionLlm = z.infer<typeof guionLlmSchema>

/* ── Hechos: todo lo que el guion tiene permitido afirmar ─────────────── */

export interface Hechos {
  /** Texto plano con todo lo verificado. Cualquier dato del guion sale de acá. */
  corpus: string
  archivos: string[]
  urls: string[]
  lineas: number[]
}

export function reunirHechos(
  finding: Finding,
  sessions: AgentSessionResult[],
  index?: CodeIndex | null,
): Hechos {
  const partes: string[] = [
    finding.titlePlain,
    finding.explanationPlain,
    finding.impactPlain,
    finding.fixPrompt,
    finding.checkId,
  ]
  const archivos = new Set<string>()
  const urls = new Set<string>()
  const lineas = new Set<number>()

  for (const e of finding.evidence) {
    partes.push(JSON.stringify(e))
    if (e.kind === 'code') {
      archivos.add(e.file)
      lineas.add(e.line)
      if (e.endLine) lineas.add(e.endLine)
      if (e.snippet) partes.push(e.snippet)
    }
    if (e.kind === 'http' || e.kind === 'browser') urls.add(e.url)
    if (e.kind === 'database') {
      partes.push(e.object, e.detail)
      archivos.add(e.object)
    }
  }

  for (const s of sessions) {
    partes.push(s.conclusionPlain, s.taskId, s.outcome)
    for (const paso of s.steps) {
      partes.push(paso.action, paso.note, paso.url, paso.target ?? '')
      urls.add(paso.url)
    }
  }

  // El índice solo aporta nombres de archivo reales: no es material narrativo.
  for (const r of index?.rankedFiles ?? []) archivos.add(r.file)
  for (const r of index?.routes ?? []) {
    archivos.add(r.file)
    partes.push(r.path)
  }

  return {
    corpus: [...partes, ...archivos, ...urls].join('\n').toLowerCase(),
    archivos: [...archivos],
    urls: [...urls],
    lineas: [...lineas],
  }
}

const RE_ARCHIVO = /\b[\w@.-]+(?:\/[\w.-]+)*\.(?:tsx?|jsx?|dart|py|sql|json|ya?ml|env|css|html|md)\b/gi
const RE_BACKTICK = /`([^`]{2,60})`/g
const RE_URL = /https?:\/\/[^\s"'<>)]+/gi
const RE_LINEA = /\bl[íi]nea\s+(\d+)/gi

export interface Desanclaje {
  tipo: 'archivo' | 'identificador' | 'url' | 'linea'
  valor: string
}

/**
 * Busca afirmaciones que el guion no puede respaldar.
 *
 * Qué sí detecta: rutas de archivo, identificadores entre backticks, URLs y
 * "línea N" que no aparecen en el hallazgo ni en la grabación. Son los datos
 * que un usuario no técnico tomaría como ciertos sin poder contrastarlos.
 *
 * Qué NO detecta: una afirmación falsa escrita en prosa común ("cualquiera
 * puede vaciar tu base"). Para eso el control es el presupuesto de caracteres
 * más el hecho de que el texto de partida sale del catálogo, no del modelo.
 */
export function detectarDesanclaje(texto: string, hechos: Hechos): Desanclaje[] {
  const fallos: Desanclaje[] = []
  const corpus = hechos.corpus

  for (const m of texto.matchAll(RE_ARCHIVO)) {
    const valor = m[0]
    if (!corpus.includes(valor.toLowerCase())) fallos.push({ tipo: 'archivo', valor })
  }
  for (const m of texto.matchAll(RE_BACKTICK)) {
    const valor = m[1].trim()
    if (!corpus.includes(valor.toLowerCase())) fallos.push({ tipo: 'identificador', valor })
  }
  for (const m of texto.matchAll(RE_URL)) {
    const valor = m[0].replace(/[.,;:]$/, '')
    if (!corpus.includes(valor.toLowerCase())) fallos.push({ tipo: 'url', valor })
  }
  for (const m of texto.matchAll(RE_LINEA)) {
    const n = Number(m[1])
    if (!hechos.lineas.includes(n)) fallos.push({ tipo: 'linea', valor: m[1] })
  }
  return fallos
}

/* ── Selección de evidencia ───────────────────────────────────────────── */

export interface RecorteGrabacion {
  recordingPath: string
  startMs: number
  endMs: number
  caption: string
  zoom?: Rect
}

/**
 * Empareja la evidencia de grabación con la sesión que la produjo.
 *
 * `Evidence` referencia `agentSessionId` pero `AgentSessionResult` no expone un
 * `id` (ese identificador vive en la fila de `agent_sessions`). Hasta que el
 * contrato se cierre, se empareja por `taskId` y, si no hay match, se usa la
 * primera sesión con grabación. Está anotado en el reporte del frente.
 */
export function elegirRecorte(
  finding: Finding,
  sessions: AgentSessionResult[],
): RecorteGrabacion | null {
  const conGrabacion = sessions.filter((s) => Boolean(s.recordingPath))
  if (conGrabacion.length === 0) return null

  const evidencia = finding.evidence.find((e): e is Extract<Evidence, { kind: 'recording' }> =>
    e.kind === 'recording',
  )

  if (evidencia) {
    const sesion =
      conGrabacion.find((s) => s.taskId === evidencia.agentSessionId) ??
      conGrabacion.find((s) => (s as { id?: string }).id === evidencia.agentSessionId) ??
      conGrabacion[0]
    return {
      recordingPath: sesion.recordingPath!,
      startMs: Math.max(0, evidencia.startMs),
      endMs: Math.max(evidencia.startMs + 1_000, evidencia.endMs),
      caption: evidencia.caption,
    }
  }

  // Sin evidencia de grabación explícita: se muestra el tramo donde el agente
  // llegó más lejos, que es donde está lo interesante.
  const sesion = conGrabacion[0]
  const pasos = sesion.steps
  const desde = pasos.length > 2 ? Math.max(0, pasos[Math.floor(pasos.length / 2)].atMs - 2_000) : 0
  return {
    recordingPath: sesion.recordingPath!,
    startMs: desde,
    endMs: Math.max(desde + 8_000, sesion.durationMs || desde + 20_000),
    caption: sesion.conclusionPlain,
  }
}

export function elegirEvidenciaCodigo(
  finding: Finding,
): Extract<Evidence, { kind: 'code' }> | null {
  return finding.evidence.find((e): e is Extract<Evidence, { kind: 'code' }> => e.kind === 'code') ?? null
}

export type DiagramKind = 'tenant-leak' | 'missing-flow' | 'exposed-key'

export function elegirDiagrama(finding: Finding): DiagramKind {
  const id = finding.checkId.toLowerCase()
  if (/(secret|key|token|env|service_role)/.test(id)) return 'exposed-key'
  if (finding.pillar === 'completeness') return 'missing-flow'
  if (/(rls|tenant|policy|cross|bucket|storage)/.test(id)) return 'tenant-leak'
  return finding.pillar === 'security' ? 'tenant-leak' : 'missing-flow'
}

/* ── Guion determinista ───────────────────────────────────────────────── */

/** Primera oración de un texto, para usar como gancho sin inventar nada. */
export function primeraOracion(texto: string, maxChars: number): string {
  const limpio = texto.replace(/\s+/g, ' ').trim()
  const corte = limpio.search(/[.!?](\s|$)/)
  const oracion = corte > 0 ? limpio.slice(0, corte + 1) : limpio
  if (oracion.length <= maxChars) return oracion
  const recorte = oracion.slice(0, maxChars)
  const ultimoEspacio = recorte.lastIndexOf(' ')
  return `${recorte.slice(0, ultimoEspacio > 20 ? ultimoEspacio : maxChars).trim()}.`
}

/** Parte un texto en oraciones completas, con su puntuación. */
export function enOraciones(texto: string): string[] {
  const limpio = texto.replace(/\s+/g, ' ').trim()
  if (!limpio) return []
  return limpio.match(/[^.!?…]+[.!?…]*/g)?.map((o) => o.trim()).filter(Boolean) ?? [limpio]
}

/**
 * Arma una narración con oraciones **enteras** hasta llenar el presupuesto.
 *
 * Existe porque cortar por caracteres produce basura: pegar la conclusión del
 * agente con el título del hallazgo y recortar a 80 daba
 * "…y entramos al panel La llave." — una frase que no significa nada y que la
 * voz igual iba a leer en voz alta. Es preferible decir menos y decirlo entero.
 * Solo si ni la primera oración entra se recorta, y ahí sí por palabra.
 */
export function armarNarracion(partes: string[], maxChars: number): string {
  const oraciones = partes.flatMap(enOraciones)
  const elegidas: string[] = []
  let largo = 0

  for (const oracion of oraciones) {
    const suma = largo === 0 ? oracion.length : largo + 1 + oracion.length
    if (suma > maxChars) continue
    elegidas.push(oracion)
    largo = suma
  }

  if (elegidas.length > 0) return elegidas.join(' ')

  // Último recurso: ni una oración entera entra. Se corta por palabra.
  const primera = oraciones[0] ?? ''
  if (primera.length <= maxChars) return primera
  const recorte = primera.slice(0, maxChars - 1)
  const ultimoEspacio = recorte.lastIndexOf(' ')
  return `${recorte.slice(0, ultimoEspacio > 20 ? ultimoEspacio : maxChars - 1).trim()}.`
}

function acotar(texto: string, maxChars: number): string {
  return armarNarracion([texto], maxChars)
}

export interface TextosGuion {
  titulo: string
  gancho: { narracion: string; placa: string }
  demostracion: Array<{ narracion: string; rotulo: string }>
  prueba: { narracion: string; rotulo: string }
  accion: { narracion: string; placa: string }
}

/**
 * Textos armados solo con lo que ya está escrito en el hallazgo.
 * Es el piso de calidad y, a la vez, el ejemplo que se le muestra al modelo.
 */
export function guionDeterminista(
  finding: Finding,
  sessions: AgentSessionResult[],
  recorte: RecorteGrabacion | null,
): TextosGuion {
  const sesion = sessions.find((s) => Boolean(s.recordingPath)) ?? sessions[0]

  // El gancho cuenta lo que hicimos. Si el agente dejó una conclusión, esa es
  // la mejor primera frase que existe: es literalmente lo que pasó.
  const ganchoNarracion = armarNarracion(
    sesion ? [puntuar(sesion.conclusionPlain), finding.titlePlain] : [finding.titlePlain],
    PRESUPUESTO_CARACTERES.gancho.max,
  )

  const demoNarracion = armarNarracion(
    recorte ? [puntuar(recorte.caption), finding.explanationPlain] : [finding.explanationPlain],
    PRESUPUESTO_CARACTERES.demostracion.max,
  )

  return {
    titulo: acotar(finding.titlePlain, 90),
    gancho: {
      narracion: ganchoNarracion,
      placa: acotar(finding.titlePlain, 64),
    },
    demostracion: [{ narracion: demoNarracion, rotulo: acotar(recorte?.caption ?? 'Lo que pasó', 60) }],
    prueba: {
      narracion: armarNarracion([finding.impactPlain], PRESUPUESTO_CARACTERES.prueba.max),
      rotulo: 'La prueba',
    },
    accion: {
      narracion: armarNarracion(
        [
          'Abajo del video te dejamos el texto exacto para arreglarlo.',
          'Copialo y pegáselo a la herramienta con la que armaste tu app.',
        ],
        PRESUPUESTO_CARACTERES.accion.max,
      ),
      placa: 'Copiá el arreglo y pegalo',
    },
  }
}

/** Le pone punto final a una frase que no lo trae, para poder encadenarla. */
function puntuar(texto: string): string {
  const limpio = texto.replace(/\s+/g, ' ').trim()
  if (!limpio) return ''
  return /[.!?…]$/.test(limpio) ? limpio : `${limpio}.`
}

/* ── Prompt ───────────────────────────────────────────────────────────── */

export const SISTEMA_GUION = `Sos el guionista de caughtcode. Escribís la narración de un video corto que le explica a una persona NO TÉCNICA algo que encontramos mal en su app.

Cómo escribís:
- Español rioplatense. Voseo. Primera persona del plural cuando contás lo que hicimos ("entramos", "probamos", "miramos").
- Frases cortas. Una idea por frase. Se va a leer en voz alta.
- Cero jerga. Nada de RLS, endpoint, payload, JWT, token, middleware, multi-tenant, XSS, CSRF, PII, CVE, OWASP.
- Sin dramatizar y sin minimizar. Contás lo que pasó.
- Nunca dictaminás sobre leyes ni sobre reglamentos.

Qué NO hacés, y es lo más importante:
- NO investigás. NO deducís. NO agregás datos.
- No podés nombrar un archivo, una línea, una dirección web ni una cifra que no esté en el material que te paso.
- Si el material no alcanza para una frase, escribís una frase más general en vez de rellenar con algo inventado.

Estructura fija del clip:
1. GANCHO: qué encontramos, en una frase, contada como algo que hicimos.
2. DEMOSTRACIÓN: qué se ve en la grabación, mientras se ve.
3. PRUEBA: el dato duro que lo confirma.
4. ACCIÓN: qué tiene que hacer, concreto. No teoría.

Respondés únicamente con un objeto JSON válido, sin markdown y sin texto alrededor.`

export function construirPrompt(
  finding: Finding,
  sessions: AgentSessionResult[],
  recorte: RecorteGrabacion | null,
  base: TextosGuion,
): string {
  const pasos = sessions
    .flatMap((s) => s.steps.slice(0, 14).map((p) => formatearPaso(s, p)))
    .slice(0, 24)

  const codigo = elegirEvidenciaCodigo(finding)

  return [
    '## Material verificado (esto es todo lo que podés afirmar)',
    '',
    `Título del hallazgo: ${finding.titlePlain}`,
    `Qué pasa: ${finding.explanationPlain}`,
    `Qué puede pasar: ${finding.impactPlain}`,
    `Gravedad interna (no la menciones): ${finding.severity} / confianza ${finding.confidence}`,
    '',
    '### Lo que hizo el agente en la app',
    sessions.length === 0
      ? '(no hubo recorrida del agente para este hallazgo)'
      : sessions.map((s) => `- ${s.taskId}: ${s.outcome}. ${s.conclusionPlain}`).join('\n'),
    pasos.length > 0 ? `\nPasos:\n${pasos.join('\n')}` : '',
    '',
    '### Evidencia en el código',
    codigo
      ? `Archivo ${codigo.file}, línea ${codigo.line}.${codigo.snippet ? `\n${codigo.snippet}` : ''}`
      : '(sin evidencia de código)',
    '',
    recorte ? `### Tramo de la grabación que se va a ver\n${recorte.caption}` : '',
    '',
    '## Versión mecánica (correcta pero acartonada)',
    JSON.stringify(base, null, 2),
    '',
    '## Tu tarea',
    'Reescribí esa versión para que suene a una persona contándolo, sin cambiar ni un hecho.',
    `Respetá los largos: gancho ${PRESUPUESTO_CARACTERES.gancho.min}-${PRESUPUESTO_CARACTERES.gancho.max} caracteres, cada tramo de demostración 30-300, prueba ${PRESUPUESTO_CARACTERES.prueba.min}-${PRESUPUESTO_CARACTERES.prueba.max}, acción ${PRESUPUESTO_CARACTERES.accion.min}-${PRESUPUESTO_CARACTERES.accion.max}.`,
    'La demostración puede tener 1, 2 o 3 tramos: uno por cada momento distinto de la grabación.',
    '',
    'Formato exacto de la respuesta:',
    '{"titulo":"...","gancho":{"narracion":"...","placa":"..."},"demostracion":[{"narracion":"...","rotulo":"..."}],"prueba":{"narracion":"...","rotulo":"..."},"accion":{"narracion":"...","placa":"..."}}',
  ]
    .filter(Boolean)
    .join('\n')
}

function formatearPaso(sesion: AgentSessionResult, paso: AgentStep): string {
  const donde = paso.target ? ` sobre ${paso.target}` : ''
  return `- [${sesion.taskId} +${Math.round(paso.atMs / 1000)}s] ${paso.action}${donde} en ${paso.url}. ${paso.note}`
}

/* ── Validación de la salida del modelo ───────────────────────────────── */

export interface Rechazo {
  motivo: string
  detalle: string[]
}

export function validarGuion(guion: GuionLlm, hechos: Hechos): Rechazo | null {
  const textos = [
    guion.titulo,
    guion.gancho.narracion,
    guion.gancho.placa,
    ...guion.demostracion.flatMap((d) => [d.narracion, d.rotulo]),
    guion.prueba.narracion,
    guion.prueba.rotulo,
    guion.accion.narracion,
    guion.accion.placa,
  ]

  const jerga = [...new Set(textos.flatMap((t) => detectarJerga(t)))]
  if (jerga.length > 0) {
    return { motivo: 'El guion usa jerga que el usuario no tiene por qué conocer.', detalle: jerga }
  }

  const desanclados = textos.flatMap((t) => detectarDesanclaje(t, hechos))
  if (desanclados.length > 0) {
    return {
      motivo: 'El guion afirma cosas que no están en el hallazgo ni en la grabación.',
      detalle: desanclados.map((d) => `${d.tipo}: ${d.valor}`),
    }
  }

  return null
}

/* ── Armado de escenas ────────────────────────────────────────────────── */

function tonoDeHallazgo(finding: Finding): 'alarm' | 'neutral' | 'ok' {
  if (finding.confidence === 'to_review') return 'neutral'
  return finding.severity === 'critical' || finding.severity === 'high' ? 'alarm' : 'neutral'
}

export function montarEscenas(
  finding: Finding,
  textos: TextosGuion,
  recorte: RecorteGrabacion | null,
): { escenas: Array<VideoScene & { role: SceneRole }>; avisos: string[] } {
  const avisos: string[] = []
  const codigo = elegirEvidenciaCodigo(finding)
  const escenas: Array<VideoScene & { role: SceneRole }> = []

  escenas.push({
    id: 'gancho',
    role: 'gancho',
    narration: textos.gancho.narracion,
    caption: textos.gancho.placa,
    visual: { type: 'statement', headline: textos.gancho.placa, tone: tonoDeHallazgo(finding) },
    durationMs: estimarVozMs(textos.gancho.narracion),
  })

  const tramos = textos.demostracion
  if (recorte) {
    const total = Math.max(1_000, recorte.endMs - recorte.startMs)
    const porTramo = Math.floor(total / tramos.length)
    tramos.forEach((tramo, i) => {
      const startMs = recorte.startMs + i * porTramo
      const visual: VideoSceneVisual = {
        type: 'recording',
        recordingPath: recorte.recordingPath,
        startMs,
        endMs: i === tramos.length - 1 ? recorte.endMs : startMs + porTramo,
        zoom: i === tramos.length - 1 ? recorte.zoom : undefined,
      }
      escenas.push({
        id: `demo-${i + 1}`,
        role: 'demostracion',
        narration: tramo.narracion,
        caption: tramo.rotulo,
        visual,
        durationMs: estimarVozMs(tramo.narracion),
      })
    })
  } else {
    avisos.push('No hay grabación del agente: la demostración se cuenta con un esquema.')
    escenas.push({
      id: 'demo-1',
      role: 'demostracion',
      narration: tramos.map((t) => t.narracion).join(' '),
      caption: tramos[0]?.rotulo ?? 'Lo que encontramos',
      visual: { type: 'diagram', kind: elegirDiagrama(finding), caption: tramos[0]?.rotulo ?? '' },
      durationMs: estimarVozMs(tramos.map((t) => t.narracion).join(' ')),
    })
  }

  const visualPrueba: VideoSceneVisual = codigo
    ? {
        type: 'code',
        file: codigo.file,
        line: codigo.line,
        endLine: codigo.endLine,
        snippet: codigo.snippet ?? '',
        highlight: [codigo.line],
      }
    : { type: 'diagram', kind: elegirDiagrama(finding), caption: textos.prueba.rotulo }

  if (!codigo) avisos.push('El hallazgo no trae archivo y línea: la prueba se muestra como esquema.')

  escenas.push({
    id: 'prueba',
    role: 'prueba',
    narration: textos.prueba.narracion,
    caption: textos.prueba.rotulo,
    visual: visualPrueba,
    durationMs: estimarVozMs(textos.prueba.narracion),
  })

  escenas.push({
    id: 'accion',
    role: 'accion',
    narration: textos.accion.narracion,
    caption: textos.accion.placa,
    visual: { type: 'statement', headline: textos.accion.placa, sub: undefined, tone: 'neutral' },
    durationMs: estimarVozMs(textos.accion.narracion),
  })

  return { escenas, avisos }
}

/* ── Entrada principal ────────────────────────────────────────────────── */

/**
 * Arma el guion de un hallazgo.
 *
 * @param index Índice de código, solo para reconocer nombres de archivo reales.
 *              Puede faltar; el guion no depende de él.
 */
export async function buildScript(
  finding: Finding,
  sessions: AgentSessionResult[],
  index?: CodeIndex | null,
  deps: ScriptDeps = {},
): Promise<ResultadoGuion> {
  const avisos: string[] = []
  const recorte = elegirRecorte(finding, sessions)
  const hechos = reunirHechos(finding, sessions, index)
  const base = guionDeterminista(finding, sessions, recorte)

  let textos = base
  let usoLlm = false
  let modelo: string | undefined
  let usage: LlmUsage | undefined
  let costUsd = 0

  if (deps.complete || deps.completeJson) {
    const prompt = construirPrompt(finding, sessions, recorte, base)
    try {
      const salida = await pedirGuion(prompt, deps)
      modelo = salida.model
      usage = salida.usage
      if (usage && modelo && deps.costoLlm) costUsd = deps.costoLlm(modelo, usage)

      const rechazo = validarGuion(salida.value, hechos)
      if (rechazo) {
        avisos.push(`${rechazo.motivo} Se usa la versión mecánica. (${rechazo.detalle.join(', ')})`)
      } else {
        textos = salida.value
        usoLlm = true
      }
    } catch (error) {
      avisos.push(
        `No se pudo generar el guion con el modelo, se usa la versión mecánica: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  } else {
    avisos.push('Sin modelo inyectado: el guion sale directo del catálogo.')
  }

  const { escenas, avisos: avisosMontaje } = montarEscenas(finding, textos, recorte)
  avisos.push(...avisosMontaje)

  // Duraciones provisorias. Las definitivas salen del audio real, en index.ts.
  const entrada: TramoEntrada[] = escenas.map((e) => ({
    role: e.role,
    audioMs: e.durationMs,
    materialMaxMs:
      e.visual.type === 'recording' ? e.visual.endMs - e.visual.startMs : undefined,
  }))
  const ajuste = ajustarDuraciones(entrada)

  const scenes: VideoScene[] = escenas.map((e, i) => ({
    id: e.id,
    narration: e.narration,
    caption: e.caption,
    visual: e.visual,
    durationMs: ajuste.tramos[i].durationMs,
  }))

  const script: VideoScript = {
    kind: 'finding',
    title: textos.titulo,
    scenes,
    totalDurationMs: ajuste.totalMs,
  }

  return { script, usoLlm, modelo, costUsd, usage, avisos, avisosTiempo: ajuste.avisos }
}

async function pedirGuion(
  prompt: string,
  deps: ScriptDeps,
): Promise<{ value: GuionLlm; model?: string; usage?: LlmUsage }> {
  if (deps.completeJson) {
    return deps.completeJson({
      system: SISTEMA_GUION,
      prompt,
      schema: guionLlmSchema,
      maxTokens: 1_600,
    })
  }

  const crudo = await deps.complete!({
    system: SISTEMA_GUION,
    prompt,
    maxTokens: 1_600,
    temperature: 0.4,
  })
  const texto = typeof crudo === 'string' ? crudo : crudo.text
  const json = extraerJson(texto)
  const parsed = guionLlmSchema.safeParse(json)
  if (!parsed.success) {
    throw new Error(
      `La respuesta del modelo no cumple el formato: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    )
  }
  return {
    value: parsed.data,
    model: typeof crudo === 'string' ? undefined : crudo.model,
    usage: typeof crudo === 'string' ? undefined : crudo.usage,
  }
}

/** Los modelos a veces envuelven el JSON en ```json. Lo sacamos sin drama. */
export function extraerJson(texto: string): unknown {
  const sinCerca = texto.replace(/```(?:json)?/gi, '').trim()
  const inicio = sinCerca.indexOf('{')
  const fin = sinCerca.lastIndexOf('}')
  if (inicio < 0 || fin <= inicio) {
    throw new Error('El modelo no devolvió un objeto JSON.')
  }
  return JSON.parse(sinCerca.slice(inicio, fin + 1))
}
