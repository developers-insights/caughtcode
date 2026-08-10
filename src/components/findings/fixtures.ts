/**
 * Datos de ejemplo para ver la pantalla sin base de datos.
 *
 * Se usan solo cuando `CAUGHTCODE_DEMO=1`. El contenido de cada hallazgo sale
 * del catálogo real y se completa con valores concretos: si el catálogo cambia,
 * la demostración cambia sola, y nunca se escribe texto de hallazgo a mano.
 */

import { completar, entrada } from '@/content/catalogo'
import { ONBOARDING } from '@/content/copy'
import type { Evidence, Finding, FindingStatus, VideoScript } from '@/lib/types/domain'
import type { FindingVideo, JobView, RunView } from './view'

/** Mismo proyecto que usa el frente de proyectos, para que el armazón y esta
 *  pantalla hablen del mismo lugar en la demostración. */
export const PROYECTO_DEMO = {
  id: 'demo-project-tienda',
  nombre: 'Tienda de Ana',
}

const CORRIDA = 'run-demo'

/**
 * Estados de la pantalla que se pueden mirar en la demostración.
 *
 * Los tres primeros son los que ocurren **antes** de que haya resultados. Están
 * acá porque son justo los que se veían todos iguales: los tres terminaban
 * mostrando "no encontramos nada serio" sin que nadie hubiera mirado nada.
 */
export type EstadoDemo =
  | 'sin-revisar'
  | 'en-cola'
  | 'revision-fallada'
  | 'listo'
  | 'corriendo'
  | 'vacio'
  | 'error'
  | 'sin-permisos'
  | 'repo-grande'
  | 'job-fallado'

const ESTADOS_DEMO: readonly EstadoDemo[] = [
  'sin-revisar',
  'en-cola',
  'revision-fallada',
  'listo',
  'corriendo',
  'vacio',
  'error',
  'sin-permisos',
  'repo-grande',
  'job-fallado',
]

export function esEstadoDemo(valor: string | undefined): valor is EstadoDemo {
  return ESTADOS_DEMO.includes(valor as EstadoDemo)
}

/* ── Constructor ───────────────────────────────────────────────────────── */

function hallazgo(opciones: {
  id: string
  checkId: string
  valores?: Record<string, string | number>
  evidence: Evidence[]
  rank: number
  status?: FindingStatus
  videoId?: string | null
  confidence?: Finding['confidence']
}): Finding {
  const base = entrada(opciones.checkId)
  const valores = opciones.valores ?? {}

  return {
    id: opciones.id,
    analysisRunId: CORRIDA,
    pillar: base.pillar,
    checkId: base.id,
    severity: base.severity,
    confidence: opciones.confidence ?? base.defaultConfidence,
    status: opciones.status ?? 'open',
    titlePlain: completar(base.titlePlain, valores),
    explanationPlain: completar(base.explanationPlain, valores),
    impactPlain: completar(base.impactPlain, valores),
    fixPrompt: completar(base.fixPrompt, valores),
    evidence: opciones.evidence,
    rank: opciones.rank,
    videoId: opciones.videoId ?? null,
    createdAt: '2026-08-09T14:02:00.000Z',
  }
}

/* ── Los tres destacados ───────────────────────────────────────────────── */

const H1 = hallazgo({
  id: 'f-cross-tenant',
  checkId: 'sec.rls_permissive',
  valores: { tabla: 'pedidos', policy: 'pedidos_select' },
  rank: 1,
  videoId: 'v-cross-tenant',
  evidence: [
    {
      kind: 'recording',
      agentSessionId: 'ses-1',
      startMs: 18_400,
      endMs: 27_900,
      caption:
        'Nos registramos con una cuenta nueva y desde ahí abrimos los pedidos de otra clienta.',
    },
    {
      kind: 'database',
      object: 'pedidos · pedidos_select',
      detail:
        'La regla deja leer cualquier fila con solo estar registrado: no compara contra quién hizo el pedido.',
    },
    {
      kind: 'http',
      url: 'https://tienda-de-ana.vercel.app/api/pedidos?limit=200',
      status: 200,
      detail: 'Devolvió 187 pedidos, con nombre, dirección y teléfono de cada persona.',
    },
  ],
})

const H2 = hallazgo({
  id: 'f-llave-maestra',
  checkId: 'sec.service_role_in_client',
  valores: { archivo: 'src/app/checkout/page.tsx', linea: 14 },
  rank: 2,
  videoId: 'v-llave-maestra',
  evidence: [
    {
      kind: 'code',
      file: 'src/app/checkout/page.tsx',
      line: 14,
      snippet: [
        "'use client'",
        '',
        'import { createClient } from "@supabase/supabase-js"',
        '',
        'const supabase = createClient(',
        '  process.env.NEXT_PUBLIC_SUPABASE_URL!,',
        '  process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY!,',
        ')',
        '',
        'export default function Checkout() {',
      ].join('\n'),
    },
  ],
})

const H3 = hallazgo({
  id: 'f-recuperar-clave',
  checkId: 'cmp.no_password_reset',
  rank: 3,
  videoId: 'v-recuperar-clave',
  evidence: [
    {
      kind: 'browser',
      url: 'https://tienda-de-ana.vercel.app/ingresar',
      detail:
        'En la pantalla de ingreso no hay ningún enlace para recuperar la contraseña, ni ninguna dirección que lleve a hacerlo.',
    },
    {
      kind: 'recording',
      agentSessionId: 'ses-2',
      startMs: 4_100,
      endMs: 12_600,
      caption: 'Buscamos cómo recuperar la contraseña y no encontramos por dónde.',
    },
  ],
})

/* ── El resto ──────────────────────────────────────────────────────────── */

const RESTO: Finding[] = [
  hallazgo({
    id: 'f-carpeta-abierta',
    checkId: 'sec.public_bucket',
    valores: { bucket: 'comprobantes' },
    rank: 4,
    evidence: [
      {
        kind: 'database',
        object: 'comprobantes',
        detail: 'La carpeta está marcada como pública: cualquiera con el enlace abre los archivos.',
      },
    ],
  }),
  hallazgo({
    id: 'f-codigo-original',
    checkId: 'sec.sourcemaps_public',
    valores: { url: 'https://tienda-de-ana.vercel.app/_next/static/chunks/main.js.map' },
    rank: 5,
    evidence: [
      {
        kind: 'http',
        url: 'https://tienda-de-ana.vercel.app/_next/static/chunks/main.js.map',
        status: 200,
        detail: 'El archivo está publicado y se descarga sin ninguna clave.',
      },
    ],
  }),
  hallazgo({
    id: 'f-sin-tope',
    checkId: 'sec.no_rate_limit',
    valores: { ruta: '/api/ingresar' },
    rank: 6,
    evidence: [
      {
        kind: 'code',
        file: 'src/app/api/ingresar/route.ts',
        line: 8,
        snippet: [
          'export async function POST(request: Request) {',
          '  const { email, password } = await request.json()',
          '  const { data, error } = await supabase.auth.signInWithPassword({',
          '    email,',
          '    password,',
          '  })',
        ].join('\n'),
      },
    ],
  }),
  hallazgo({
    id: 'f-cookies',
    checkId: 'sto.no_cookie_banner',
    valores: { servicios: 'Google Analytics y el píxel de Meta' },
    rank: 7,
    evidence: [
      {
        kind: 'browser',
        url: 'https://tienda-de-ana.vercel.app/',
        detail:
          'Entramos por primera vez y no apareció ningún aviso, pero se cargaron dos servicios que registran lo que hace el visitante.',
      },
    ],
  }),
  hallazgo({
    id: 'f-etiquetas',
    checkId: 'cmp.form_no_labels',
    valores: { archivo: 'src/components/form-contacto.tsx', linea: 22, ruta: '/contacto' },
    rank: 8,
    evidence: [
      {
        kind: 'code',
        file: 'src/components/form-contacto.tsx',
        line: 22,
        endLine: 23,
        snippet: [
          '<form onSubmit={enviar}>',
          '  <input placeholder="Tu nombre" name="nombre" />',
          '  <input placeholder="Tu email" name="email" />',
          '  <button type="submit">Enviar</button>',
          '</form>',
        ].join('\n'),
      },
    ],
  }),
  hallazgo({
    id: 'f-pagina-perdida',
    checkId: 'cmp.no_404_page',
    rank: 9,
    evidence: [
      {
        kind: 'http',
        url: 'https://tienda-de-ana.vercel.app/promo-vieja',
        status: 404,
        detail: 'Aparece la pantalla gris que trae el sistema por defecto, sin salida a ningún lado.',
      },
    ],
  }),
]

/* ── Ya cerrado ────────────────────────────────────────────────────────── */

const CERRADO = hallazgo({
  id: 'f-borrar-cuenta',
  checkId: 'cmp.no_account_deletion',
  rank: 10,
  status: 'fixed',
  evidence: [
    {
      kind: 'browser',
      url: 'https://tienda-de-ana.vercel.app/cuenta',
      detail: 'Ahora hay un botón para borrar la cuenta y pide confirmación antes de hacerlo.',
    },
  ],
})

export const HALLAZGOS_DEMO: Finding[] = [H1, H2, H3, ...RESTO, CERRADO]

/* ── Videos ────────────────────────────────────────────────────────────── */

const GUION_CROSS_TENANT: VideoScript = {
  kind: 'finding',
  title: H1.titlePlain,
  totalDurationMs: 46_000,
  scenes: [
    {
      id: 's1',
      narration:
        'Creamos una cuenta nueva en tu tienda. Una cuenta común, como la de cualquier persona que te compra.',
      caption: 'Creamos una cuenta común y corriente.',
      visual: { type: 'statement', headline: 'Cuenta nueva', tone: 'neutral' },
      durationMs: 9_000,
    },
    {
      id: 's2',
      narration:
        'Desde esa cuenta pedimos la lista de pedidos. No la nuestra: toda la lista.',
      caption: 'Pedimos la lista completa de pedidos.',
      visual: {
        type: 'recording',
        recordingPath: 'demo/cross-tenant.webm',
        startMs: 9_000,
        endMs: 21_000,
      },
      durationMs: 12_000,
    },
    {
      id: 's3',
      narration:
        'Y volvieron ciento ochenta y siete pedidos de otras personas, con nombre, dirección y teléfono.',
      caption: '187 pedidos ajenos, con dirección y teléfono.',
      visual: { type: 'diagram', kind: 'tenant-leak', caption: 'Datos de otros clientes' },
      durationMs: 13_000,
    },
    {
      id: 's4',
      narration:
        'La regla que decide quién ve qué está mal escrita: alcanza con estar registrado para ver todo.',
      caption: 'Alcanza con estar registrado para ver todo.',
      visual: {
        type: 'code',
        file: 'supabase/policies.sql',
        line: 12,
        snippet: 'create policy pedidos_select on pedidos for select using (true);',
      },
      durationMs: 12_000,
    },
  ],
}

export const VIDEOS_DEMO: Record<string, FindingVideo> = {
  'f-cross-tenant': {
    id: 'v-cross-tenant',
    status: 'ready',
    // Sin archivo real: el reproductor muestra su propio estado de error, que
    // también hay que poder mirar.
    url: '/demo/cross-tenant.mp4',
    durationSeconds: 46,
    transcript: GUION_CROSS_TENANT.scenes.map((s) => s.narration).join(' '),
    script: GUION_CROSS_TENANT,
  },
  'f-llave-maestra': {
    id: 'v-llave-maestra',
    status: 'rendering',
    url: null,
    durationSeconds: null,
    transcript: null,
    script: null,
  },
  'f-recuperar-clave': {
    id: 'v-recuperar-clave',
    status: 'failed',
    url: null,
    durationSeconds: null,
    transcript: null,
    script: null,
  },
}

/* ── Corridas ──────────────────────────────────────────────────────────── */

export const CORRIDA_TERMINADA: RunView = {
  id: CORRIDA,
  status: 'succeeded',
  stage: null,
  progress: 100,
  finishedAt: '2026-08-09T14:09:31.000Z',
  error: null,
}

export const CORRIDA_EN_MARCHA: RunView = {
  id: CORRIDA,
  status: 'running',
  stage: 'Probando quién puede ver los datos de quién',
  progress: 48,
  finishedAt: null,
  error: null,
}

/* ── Trabajos en cola ──────────────────────────────────────────────────── */

function trabajo(over: Partial<JobView> & { id: string }): JobView {
  return {
    kind: 'ingest_repo',
    status: 'queued',
    lastError: null,
    createdAt: '2026-08-09T13:58:00.000Z',
    ...over,
  }
}

export const TRABAJO_EN_COLA = trabajo({ id: 'job-demo-cola' })

/**
 * El motivo sale del copy real de onboarding, el mismo que escribe el motor en
 * `last_error` cuando el repositorio es privado. Nunca se inventa acá el texto
 * de un error: si el mensaje fuera distinto al de producción, la demostración
 * estaría probando una pantalla que no existe.
 */
export const TRABAJO_FALLADO = trabajo({
  id: 'job-demo-fallado',
  status: 'failed',
  lastError: ONBOARDING.erroresDeRepositorio.privado,
})

/** Qué se muestra en cada estado de la demostración. */
export function datosDemo(estado: EstadoDemo): {
  findings: Finding[]
  run: RunView | null
  trabajos: JobView[]
} {
  switch (estado) {
    case 'sin-revisar':
      return { findings: [], run: null, trabajos: [] }
    case 'en-cola':
      return { findings: [], run: null, trabajos: [TRABAJO_EN_COLA] }
    case 'revision-fallada':
      return { findings: [], run: null, trabajos: [TRABAJO_FALLADO] }
    case 'corriendo':
      return { findings: [H1, RESTO[0]!], run: CORRIDA_EN_MARCHA, trabajos: [] }
    case 'vacio':
      return { findings: [], run: CORRIDA_TERMINADA, trabajos: [] }
    default:
      return { findings: HALLAZGOS_DEMO, run: CORRIDA_TERMINADA, trabajos: [] }
  }
}
