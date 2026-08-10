/**
 * Mide cuánto cuesta de verdad producir un clip.
 *
 * Uso:
 *   npx tsx scripts/medir-cogs.ts               # 3 clips, sin voz (gratis)
 *   npx tsx scripts/medir-cogs.ts --n=5
 *   TTS_PROVIDER=azure npx tsx scripts/medir-cogs.ts --n=3
 *   npx tsx scripts/medir-cogs.ts --grabacion=/ruta/a/una.webm
 *
 * Por qué existe: el precio de venta no se puede fijar con una constante
 * inventada. `pricing.ts` tiene hoy el costo de render marcado como ESTIMADO;
 * este script produce el número medido que lo reemplaza, y de paso deja ver si
 * un cambio nos duplicó el tiempo de máquina por clip.
 *
 * Si no se le pasa una grabación, se fabrica una: levanta una app de mentira en
 * el navegador y graba a Playwright usándola. Así el clip de prueba tiene el
 * mismo material que uno real (una grabación de verdad adentro), no un fondo
 * de color.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { chromium } from 'playwright'

import { completar, entrada } from '@/content/catalogo'
import type { AgentSessionResult, Finding } from '@/lib/types/domain'
import { formatUsd } from '@/server/cost/pricing'
import { promediar, type DesgloseClip } from '@/server/video/cogs'
import { generateVideo } from '@/server/video'

/* ── Argumentos ───────────────────────────────────────────────────────── */

interface Args {
  n: number
  grabacion?: string
  conservar: boolean
}

function leerArgs(argv: string[]): Args {
  const args: Args = { n: 3, conservar: false }
  for (const crudo of argv.slice(2)) {
    const [clave, valor] = crudo.replace(/^--/, '').split('=')
    if (clave === 'n') args.n = Math.max(1, Number(valor) || 3)
    if (clave === 'grabacion') args.grabacion = valor
    if (clave === 'keep' || clave === 'conservar') args.conservar = true
  }
  return args
}

/* ── App de mentira, para tener una grabación real ────────────────────── */

const APP_FALSA = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>Mi app</title>
<style>
  *{box-sizing:border-box} body{margin:0;font:16px/1.5 -apple-system,system-ui,sans-serif;background:#f6f7f9;color:#16181d}
  header{background:#fff;border-bottom:1px solid #e3e6ea;padding:14px 28px;display:flex;gap:12px;align-items:center}
  .logo{width:26px;height:26px;border-radius:7px;background:#2b6cb0}
  main{max-width:760px;margin:44px auto;padding:0 24px}
  h1{font-size:30px;margin:0 0 6px} p.sub{color:#5a6270;margin:0 0 28px}
  .tarjeta{background:#fff;border:1px solid #e3e6ea;border-radius:12px;padding:26px;box-shadow:0 1px 3px rgba(0,0,0,.05)}
  label{display:block;font-size:13px;font-weight:600;margin:16px 0 6px}
  input{width:100%;padding:11px 13px;border:1px solid #cbd2da;border-radius:8px;font-size:15px}
  button{margin-top:22px;padding:11px 20px;background:#2b6cb0;color:#fff;border:0;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer}
  table{width:100%;border-collapse:collapse;margin-top:18px;font-size:14px}
  th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #eef0f3}
  th{color:#5a6270;font-size:12px;text-transform:uppercase;letter-spacing:.06em}
  .oculto{display:none}
</style></head>
<body>
<header><div class="logo"></div><strong>Mi app</strong></header>
<main>
  <section id="registro">
    <h1>Crear cuenta</h1><p class="sub">Empezá gratis, sin tarjeta.</p>
    <div class="tarjeta">
      <label for="correo">Tu correo</label><input id="correo" placeholder="vos@ejemplo.com">
      <label for="clave">Contraseña</label><input id="clave" type="password" placeholder="••••••••">
      <button id="crear">Crear cuenta</button>
    </div>
  </section>
  <section id="panel" class="oculto">
    <h1>Panel</h1><p class="sub">Pedidos de todos los clientes</p>
    <div class="tarjeta">
      <table><thead><tr><th>Cliente</th><th>Correo</th><th>Total</th></tr></thead>
      <tbody id="filas"></tbody></table>
    </div>
  </section>
</main>
<script>
  document.getElementById('crear').addEventListener('click', function () {
    document.getElementById('registro').classList.add('oculto')
    document.getElementById('panel').classList.remove('oculto')
    var datos = [
      ['Laura Giménez', 'laura@otraempresa.com', '$ 48.200'],
      ['Marcos Peña', 'marcos@otraempresa.com', '$ 12.900'],
      ['Sofía Ruiz', 'sofia@tercera.com', '$ 7.450'],
      ['Diego Salas', 'diego@tercera.com', '$ 91.000']
    ]
    var cuerpo = document.getElementById('filas')
    datos.forEach(function (fila, i) {
      setTimeout(function () {
        var tr = document.createElement('tr')
        fila.forEach(function (celda) {
          var td = document.createElement('td')
          td.textContent = celda
          tr.appendChild(td)
        })
        cuerpo.appendChild(tr)
      }, i * 420)
    })
  })
</script>
</body></html>`

/**
 * Graba a Playwright usando la app de mentira: registro, clic, y el panel
 * mostrando datos de otras personas. Es exactamente la forma de la evidencia
 * que produce el agente de navegación.
 */
async function fabricarGrabacion(dir: string): Promise<string> {
  const dirVideo = path.join(dir, 'grabacion-agente')
  await mkdir(dirVideo, { recursive: true })
  const paginaPath = path.join(dir, 'app-falsa.html')
  await writeFile(paginaPath, APP_FALSA, 'utf8')

  const navegador = await chromium.launch({ headless: true })
  const contexto = await navegador.newContext({
    viewport: { width: 1280, height: 800 },
    recordVideo: { dir: dirVideo, size: { width: 1280, height: 800 } },
  })
  const pagina = await contexto.newPage()

  await pagina.goto(`file://${paginaPath}`)
  await pagina.waitForTimeout(2_200)
  await pagina.click('#correo')
  await pagina.type('#correo', 'cualquiera@ejemplo.com', { delay: 85 })
  await pagina.waitForTimeout(700)
  await pagina.click('#clave')
  await pagina.type('#clave', 'unaclave123', { delay: 85 })
  await pagina.waitForTimeout(900)
  await pagina.click('#crear')
  await pagina.waitForTimeout(3_400)
  await pagina.mouse.move(640, 520)
  await pagina.waitForTimeout(2_600)

  await contexto.close()
  await navegador.close()

  const { readdir, rename } = await import('node:fs/promises')
  const archivos = (await readdir(dirVideo)).filter((f) => f.endsWith('.webm'))
  const destino = path.join(dir, 'grabacion-agente.webm')
  await rename(path.join(dirVideo, archivos[0]), destino)
  return destino
}

/* ── Material de prueba ───────────────────────────────────────────────── */

const ARCHIVO = 'src/app/panel/page.tsx'
const LINEA = 42

function hallazgoDePrueba(): Finding {
  const cat = entrada('sec.service_role_in_client')
  const valores = { archivo: ARCHIVO, linea: LINEA }
  return {
    id: 'medicion-cogs',
    analysisRunId: 'corrida-medicion',
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
        file: ARCHIVO,
        line: LINEA,
        endLine: LINEA + 4,
        snippet: [
          'const supabase = createClient(',
          '  process.env.NEXT_PUBLIC_SUPABASE_URL,',
          '  process.env.SUPABASE_SERVICE_ROLE_KEY,',
          ')',
          'export default function Panel() {',
        ].join('\n'),
      },
      {
        kind: 'recording',
        agentSessionId: 'signup',
        startMs: 2_000,
        endMs: 12_000,
        caption: 'Creamos una cuenta y vimos los pedidos de otros clientes',
      },
    ],
    rank: 1,
    createdAt: new Date().toISOString(),
    videoId: null,
  }
}

function sesionDePrueba(recordingPath: string): AgentSessionResult {
  return {
    taskId: 'signup',
    outcome: 'completed',
    conclusionPlain: 'Nos registramos en tu app como un usuario más y entramos al panel',
    steps: [
      { index: 0, atMs: 0, action: 'abrir', url: 'https://demo.test/', note: 'Cargó la pantalla de registro' },
      {
        index: 1,
        atMs: 2_400,
        action: 'escribir',
        target: 'campo de correo',
        url: 'https://demo.test/',
        note: 'Pusimos un correo cualquiera',
      },
      {
        index: 2,
        atMs: 5_600,
        action: 'clic',
        target: 'botón de crear cuenta',
        url: 'https://demo.test/',
        note: 'La cuenta quedó creada sin confirmar nada',
      },
      {
        index: 3,
        atMs: 7_800,
        action: 'ver',
        url: 'https://demo.test/panel',
        note: 'El panel mostró pedidos de otros clientes',
      },
    ],
    recordingPath,
    durationMs: 12_000,
    costUsd: 0.03,
  }
}

/* ── Tabla ────────────────────────────────────────────────────────────── */

function tabla(filas: string[][]): string {
  const anchos = filas[0].map((_, c) => Math.max(...filas.map((f) => f[c].length)))
  const linea = (f: string[]) => f.map((celda, c) => celda.padEnd(anchos[c])).join('  ')
  return [linea(filas[0]), anchos.map((a) => '─'.repeat(a)).join('  '), ...filas.slice(1).map(linea)].join(
    '\n',
  )
}

/* ── Programa ─────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  const args = leerArgs(process.argv)
  const base = await mkdtemp(path.join(tmpdir(), 'caughtcode-cogs-'))

  console.log(`\n▸ Midiendo el costo de ${args.n} clip(s)`)
  console.log(`  voz: ${process.env.TTS_PROVIDER ?? 'azure (default)'}`)
  console.log(`  motor: ${process.env.VIDEO_RENDERER ?? 'web (default)'}`)
  console.log(`  carpeta: ${base}\n`)

  const grabacion = args.grabacion ?? (await fabricarGrabacion(base))
  if (!args.grabacion) console.log(`  grabación de prueba: ${grabacion}\n`)

  const finding = hallazgoDePrueba()
  const sessions = [sesionDePrueba(grabacion)]

  const clips: DesgloseClip[] = []
  const avisosVistos = new Set<string>()

  for (let i = 0; i < args.n; i++) {
    const arranque = Date.now()
    process.stdout.write(`  clip ${i + 1}/${args.n} … `)

    const resultado = await generateVideo({
      finding: { ...finding, id: `medicion-${i + 1}` },
      projectId: 'proyecto-de-medicion',
      sessions,
      workspaceDir: base,
      forzar: true,
    })

    clips.push(resultado.desglose)
    for (const aviso of resultado.avisos) avisosVistos.add(aviso)
    console.log(
      `${resultado.durationSeconds.toFixed(1)} s de video · ${formatUsd(resultado.costUsd)} · ${(
        (Date.now() - arranque) / 1000
      ).toFixed(1)} s de reloj`,
    )
  }

  const media = promediar(clips)
  if (!media) return

  console.log('\n── Costo promedio por clip ──────────────────────────────\n')
  console.log(
    tabla([
      ['Etapa', 'Costo', 'Unidades'],
      ['Guion (modelo)', formatUsd(media.guionUsd), clips[0].guionUsd > 0 ? '1 llamada' : 'sin modelo'],
      ['Voz', formatUsd(media.vozUsd), `${media.caracteresNarrados} caracteres`],
      ['Render + mezcla', formatUsd(media.renderUsd), `${(media.computeMs / 1000).toFixed(1)} s de máquina`],
      ['TOTAL', formatUsd(media.totalUsd), `${(media.videoMs / 1000).toFixed(1)} s de video`],
    ]),
  )

  console.log('\n── Calibración para pricing.ts ──────────────────────────\n')
  console.log(
    `  RENDER_COMPUTE_MINUTES_PER_VIDEO_SECOND medido: ${media.calibracion.minutosPorSegundoDeVideo}`,
  )
  console.log(`  el render tarda ${media.calibracion.vecesTiempoReal}x lo que dura el clip`)
  console.log(`  muestras: ${clips.length}\n`)

  if (avisosVistos.size > 0) {
    console.log('── Avisos ───────────────────────────────────────────────\n')
    for (const aviso of avisosVistos) console.log(`  · ${aviso}`)
    console.log('')
  }

  if (args.conservar) {
    console.log(`  Los archivos quedaron en ${base}\n`)
  } else {
    await rm(base, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error('\n✗ La medición falló:\n')
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
