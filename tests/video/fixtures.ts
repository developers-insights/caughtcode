/**
 * Material de prueba para el frente de video.
 * Sale del catálogo real (`src/content/catalogo.ts`), no de texto inventado:
 * si el catálogo cambia y el video deja de funcionar, queremos enterarnos acá.
 */

import { completar, entrada } from '@/content/catalogo'
import type { AgentSessionResult, Finding } from '@/lib/types/domain'

export const ARCHIVO_EJEMPLO = 'src/app/panel/page.tsx'
export const LINEA_EJEMPLO = 42

export function hallazgoDeEjemplo(parciales: Partial<Finding> = {}): Finding {
  const cat = entrada('sec.service_role_in_client')
  const valores = { archivo: ARCHIVO_EJEMPLO, linea: LINEA_EJEMPLO }

  return {
    id: 'hallazgo-demo',
    analysisRunId: 'corrida-demo',
    pillar: cat.pillar,
    checkId: cat.id,
    severity: cat.severity,
    confidence: cat.defaultConfidence,
    status: 'open',
    titlePlain: completar(cat.titlePlain, valores),
    explanationPlain: completar(cat.explanationPlain, valores),
    impactPlain: completar(cat.impactPlain, valores),
    fixPrompt: completar(cat.fixPrompt, valores),
    evidence: [
      {
        kind: 'code',
        file: ARCHIVO_EJEMPLO,
        line: LINEA_EJEMPLO,
        endLine: LINEA_EJEMPLO + 4,
        snippet: [
          "const supabase = createClient(",
          "  process.env.NEXT_PUBLIC_SUPABASE_URL,",
          "  process.env.SUPABASE_SERVICE_ROLE_KEY,",
          ")",
          "export default function Panel() {",
        ].join('\n'),
      },
      {
        kind: 'recording',
        agentSessionId: 'signup',
        startMs: 3_000,
        endMs: 28_000,
        caption: 'Nos creamos una cuenta y entramos al panel',
      },
    ],
    rank: 1,
    createdAt: '2026-08-09T12:00:00.000Z',
    ...parciales,
  }
}

export function sesionDeEjemplo(parciales: Partial<AgentSessionResult> = {}): AgentSessionResult {
  return {
    taskId: 'signup',
    outcome: 'completed',
    conclusionPlain: 'Nos registramos en tu app como un usuario más y entramos sin problema',
    steps: [
      { index: 0, atMs: 0, action: 'abrir', url: 'https://demo.test/', note: 'Cargó la pantalla de inicio' },
      {
        index: 1,
        atMs: 4_200,
        action: 'escribir',
        target: 'campo de correo',
        url: 'https://demo.test/registro',
        note: 'Completamos el registro con un correo cualquiera',
      },
      {
        index: 2,
        atMs: 12_800,
        action: 'clic',
        target: 'botón de crear cuenta',
        url: 'https://demo.test/registro',
        note: 'La cuenta quedó creada al toque',
      },
      {
        index: 3,
        atMs: 21_400,
        action: 'abrir',
        url: 'https://demo.test/panel',
        note: 'Entramos al panel sin que nos pidiera nada más',
      },
    ],
    recordingPath: '/tmp/no-existe/grabacion.webm',
    durationMs: 30_000,
    costUsd: 0.04,
    ...parciales,
  }
}
