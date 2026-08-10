/**
 * La pantalla de comentarios, verificada donde importa:
 *
 *  1. Cero jerga en todo lo que se ve.
 *  2. Ningún componente dibuja una clave completa, ni aunque le llegue sin
 *     enmascarar.
 *  3. La vista previa marca exactamente las líneas que cambian.
 *
 * Los datos salen del motor real corriendo sobre un proyecto de mentira que se
 * escribe en un directorio temporal: nada de fixtures inventadas a mano que se
 * desactualizan sin que nadie se entere.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { detectarJerga } from '@/content/lenguaje'
import { COMENTARIOS } from '@/content/copy'
import { scanProject } from '@/server/comments'
import type { CommentScanResult } from '@/lib/types/domain'

import { enmascararScan } from '@/app/(app)/proyectos/[id]/comentarios/view-model'
import { generarPlan } from '@/app/(app)/proyectos/[id]/comentarios/view-model'
import { alinear, ventanaDeCambio } from '@/components/comments/diff-window'
import { construirModelo, veredicto, type CommentsViewModel } from '@/components/comments/model'
import { redactar } from '@/components/comments/redact'
import type { CleanPlanView } from '@/components/comments/model-clean'
import { CommentScanSummary } from '@/components/comments/comment-scan-summary'
import { ReachSection } from '@/components/comments/reach-section'
import { CommentRow } from '@/components/comments/comment-row'
import { RiskBadge } from '@/components/comments/risk-badge'
import { CleanModeSelector } from '@/components/comments/clean-mode-selector'
import { CleanPreview } from '@/components/comments/clean-preview'
import { FunctionalCommentsPanel } from '@/components/comments/functional-comments-panel'
import { ApplyPanel } from '@/components/comments/apply-panel'

/** Clave con forma de clave de Stripe. No es real: es para ver si se filtra. */
const CLAVE = 'sk_live_51QhZzWXYaBcDeFgHiJkLmNoPqRsTuVwXy'

/**
 * Proyecto de mentira. Los comentarios están escritos a propósito sin ningún
 * término técnico: así, si el test encuentra jerga, la jerga es nuestra y no
 * del código que estamos citando.
 */
const ARCHIVOS: Record<string, string> = {
  'next.config.js': 'module.exports = {}\n',
  'app/page.tsx': [
    "'use client'",
    '',
    '/**',
    ' * Pantalla de inicio de la tienda.',
    ' */',
    'export default function Page() {',
    `  // La clave de cobros es ${CLAVE}`,
    '  const total = 100',
    '  // eslint-disable-next-line no-console',
    '  console.log(total)',
    '  return <main>{/* falta el precio con descuento */}<b>Hola</b></main>',
    '}',
    '',
  ].join('\n'),
  'app/api/cobros/route.ts': [
    '// No tocar: lo arreglamos con Ana la semana que viene.',
    'export async function GET() {',
    '  // devuelve el listado',
    '  return Response.json({ ok: true })',
    '}',
    '',
  ].join('\n'),
}

let repoPath = ''
let scan: CommentScanResult
let modelo: CommentsViewModel
let plan: CleanPlanView

beforeAll(async () => {
  repoPath = await mkdtemp(join(tmpdir(), 'caughtcode-comentarios-'))
  for (const [rel, contenido] of Object.entries(ARCHIVOS)) {
    const destino = join(repoPath, rel)
    await mkdir(join(destino, '..'), { recursive: true })
    await writeFile(destino, contenido, 'utf8')
  }

  scan = enmascararScan(await scanProject(repoPath))
  modelo = construirModelo(scan)
  plan = await generarPlan(repoPath, { mode: 'safe', excluidos: [] })
})

afterAll(async () => {
  if (repoPath) await rm(repoPath, { recursive: true, force: true })
})

/* ── Utilidades ──────────────────────────────────────────────────────────── */

function html(elemento: ReactElement): string {
  return renderToStaticMarkup(elemento)
}

function aTexto(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/** Todo lo que la pantalla puede llegar a dibujar. */
function piezas(): Array<{ nombre: string; markup: string }> {
  const grupoExpuesto = modelo.grupos.find((g) => g.reach === 'ships_to_browser')!
  const grupoServidor = modelo.grupos.find((g) => g.reach === 'server_only')!
  const grupoLocal = modelo.grupos.find((g) => g.reach === 'build_only')!
  const filaConClave = scan.hits.find((h) => h.risk === 'secret')

  const lista: Array<{ nombre: string; markup: string }> = [
    { nombre: 'CommentScanSummary', markup: html(createElement(CommentScanSummary, { modelo })) },
    { nombre: 'ReachSection expuesto', markup: html(createElement(ReachSection, { grupo: grupoExpuesto })) },
    { nombre: 'ReachSection servidor', markup: html(createElement(ReachSection, { grupo: grupoServidor })) },
    {
      nombre: 'FunctionalCommentsPanel',
      markup: html(createElement(FunctionalCommentsPanel, { funcionales: modelo.funcionales, mode: 'safe' })),
    },
    {
      nombre: 'CleanModeSelector',
      markup: html(createElement(CleanModeSelector, { value: 'safe', onChange: () => {} })),
    },
    { nombre: 'CleanPreview', markup: html(createElement(CleanPreview, { plan })) },
    { nombre: 'ApplyPanel', markup: html(createElement(ApplyPanel, { plan })) },
    { nombre: 'RiskBadge secreto', markup: html(createElement(RiskBadge, { risk: 'secret' })) },
    { nombre: 'RiskBadge nota', markup: html(createElement(RiskBadge, { risk: 'internal_note' })) },
    { nombre: 'RiskBadge pendiente', markup: html(createElement(RiskBadge, { risk: 'todo' })) },
    { nombre: 'RiskBadge código apagado', markup: html(createElement(RiskBadge, { risk: 'disabled_code' })) },
  ]

  if (grupoLocal.total > 0) {
    lista.push({ nombre: 'ReachSection local', markup: html(createElement(ReachSection, { grupo: grupoLocal })) })
  }
  if (filaConClave) {
    lista.push({
      nombre: 'CommentRow con clave',
      markup: html(
        createElement(CommentRow, {
          fila: {
            id: `${filaConClave.file}:${filaConClave.line}`,
            file: filaConClave.file,
            line: filaConClave.line,
            endLine: filaConClave.endLine,
            text: filaConClave.text,
            reach: filaConClave.reach,
            risk: filaConClave.risk,
            functional: filaConClave.functional,
            reason: filaConClave.reason,
          },
        }),
      ),
    })
  }

  return lista
}

/* ── El proyecto de mentira salió como esperábamos ───────────────────────── */

describe('el escaneo del proyecto de prueba', () => {
  it('encuentra la clave y la marca como tal', () => {
    const conClave = scan.hits.filter((h) => h.risk === 'secret')
    expect(conClave.length).toBeGreaterThan(0)
  })

  it('reconoce comentarios que llegan al navegador', () => {
    expect(modelo.exposedCount).toBeGreaterThan(0)
  })
})

/* ── 1. Cero jerga ───────────────────────────────────────────────────────── */

describe('cero jerga en el texto visible', () => {
  it('el copy de producto está limpio', () => {
    const textos = [
      COMENTARIOS.titulo,
      COMENTARIOS.bajada,
      COMENTARIOS.explicacion.titulo,
      COMENTARIOS.explicacion.texto,
      COMENTARIOS.garantia,
      COMENTARIOS.aplicar.titulo,
      COMENTARIOS.aplicar.texto,
      ...Object.values(COMENTARIOS.alcance),
      ...Object.values(COMENTARIOS.riesgo),
      ...Object.values(COMENTARIOS.modos).flatMap((m) => [m.titulo, m.texto]),
    ]

    for (const texto of textos) {
      expect(detectarJerga(texto), `jerga en: ${texto}`).toEqual([])
    }
  })

  it('los veredictos están limpios en todos sus casos', () => {
    const casos: CommentsViewModel[] = [
      { ...modelo, total: 0, exposedCount: 0, exposedSecrets: 0, exposedSensitive: 0 },
      { ...modelo, exposedCount: 0, exposedSecrets: 0, exposedSensitive: 0 },
      { ...modelo, exposedSecrets: 1, exposedSensitive: 1 },
      { ...modelo, exposedSecrets: 3, exposedSensitive: 3 },
      { ...modelo, exposedSecrets: 0, exposedSensitive: 1 },
      { ...modelo, exposedSecrets: 0, exposedSensitive: 4 },
      { ...modelo, exposedSecrets: 0, exposedSensitive: 0 },
    ]

    for (const caso of casos) {
      const v = veredicto(caso)
      expect(detectarJerga(v.titular), `jerga en titular: ${v.titular}`).toEqual([])
      expect(detectarJerga(v.apoyo), `jerga en apoyo: ${v.apoyo}`).toEqual([])
    }
  })

  it('ningún componente dibuja una palabra prohibida', () => {
    for (const { nombre, markup } of piezas()) {
      const texto = aTexto(markup)
      // Se saca lo que es cita del código del usuario: si su comentario dice
      // una palabra técnica, la mostramos igual — es la evidencia.
      const soloNuestro = texto
        .replaceAll(CLAVE, '')
        .replace(/[\w./-]+\.(tsx?|jsx?|css|html|json|patch|zip)/g, '')
      expect(detectarJerga(soloNuestro), `jerga en ${nombre}: ${soloNuestro.slice(0, 300)}`).toEqual([])
    }
  })
})

/* ── 2. Ninguna clave completa en pantalla ───────────────────────────────── */

describe('las claves nunca se dibujan enteras', () => {
  it('el motor entrega el texto ya enmascarado', () => {
    for (const hit of scan.hits) {
      expect(hit.text).not.toContain(CLAVE)
    }
  })

  it('el modelo de vista tampoco la deja pasar', () => {
    for (const grupo of modelo.grupos) {
      for (const fila of [...grupo.destacados, ...grupo.resto]) {
        expect(fila.text).not.toContain(CLAVE)
      }
    }
  })

  it('ningún componente la dibuja', () => {
    for (const { nombre, markup } of piezas()) {
      expect(markup, `${nombre} filtró la clave`).not.toContain(CLAVE)
    }
  })

  it('se ve la versión enmascarada, que es la prueba de que se enmascaró', () => {
    const conClave = scan.hits.find((h) => h.risk === 'secret')!
    expect(conClave.text).toContain('••••')
    expect(conClave.text).toContain('sk_live_')
  })

  it('aunque le llegue una clave sin enmascarar, la fila no la dibuja entera', () => {
    // Defensa en profundidad: el enmascarado de verdad lo hace el servidor,
    // pero un dato viejo guardado antes de que existiera —o un error nuestro
    // más adelante— no puede terminar dibujando la clave.
    const markup = html(
      createElement(CommentRow, {
        fila: {
          id: 'a.ts:1',
          file: 'a.ts',
          line: 1,
          endLine: 1,
          text: `La clave es ${CLAVE}`,
          reach: 'ships_to_browser',
          risk: 'secret',
          functional: false,
        },
      }),
    )
    expect(markup).not.toContain(CLAVE)
    expect(markup).toContain('••••')
  })

  it('el raspado no toca texto normal ni rutas de archivo', () => {
    const intactos = [
      'Acá calculamos el total del carrito.',
      'src/components/comments/comment-scan-summary.tsx',
      'https://tienda-de-ana.vercel.app/checkout',
      'sk_live_••••VwXy',
    ]
    for (const texto of intactos) {
      expect(redactar(texto), `cambió: ${texto}`).toBe(texto)
    }
  })

  it('el raspado es idempotente', () => {
    const unaVez = redactar(`clave ${CLAVE}`)
    expect(redactar(unaVez)).toBe(unaVez)
  })
})

/* ── 3. La vista previa dice la verdad ───────────────────────────────────── */

describe('la vista previa marca solo lo que cambia', () => {
  it('alinea un borrado simple', () => {
    const antes = ['uno', '// se va', 'dos', 'tres']
    const despues = ['uno', 'dos', 'tres']
    expect(alinear(antes, despues)).toEqual(['igual', 'sale', 'igual', 'igual'])
  })

  it('alinea varios borrados separados', () => {
    const antes = ['a', '// x', 'b', 'c', '// y', 'd']
    const despues = ['a', 'b', 'c', 'd']
    expect(alinear(antes, despues)).toEqual(['igual', 'sale', 'igual', 'igual', 'sale', 'igual'])
  })

  it('alinea una línea modificada', () => {
    const antes = ['a', 'const x = 1 // nota', 'b']
    const despues = ['a', 'const x = 1', 'b']
    expect(alinear(antes, despues)).toEqual(['igual', 'cambia', 'igual'])
  })

  it('marca únicamente las líneas del tramo, no todo lo que hay en el medio', () => {
    const antes = ['a', '// se va', 'b', 'c', 'd', 'e', 'f', '// también', 'g']
    const despues = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    const v = ventanaDeCambio(antes.join('\n'), despues.join('\n'))

    expect(v.sinCambios).toBe(false)
    expect(v.tramos).toBe(2)
    // Solo la línea 2: no las siete que hay entre el primer y el último cambio.
    expect(v.antes.highlightLines).toEqual([2])
  })

  it('no inventa cambios cuando los dos textos son iguales', () => {
    const v = ventanaDeCambio('a\nb\nc\n', 'a\nb\nc\n')
    expect(v.sinCambios).toBe(true)
    expect(v.antes.highlightLines).toEqual([])
  })

  it('sobre el plan real, marca menos líneas de las que muestra', () => {
    expect(plan.files.length).toBeGreaterThan(0)
    for (const archivo of plan.files) {
      const v = ventanaDeCambio(archivo.before, archivo.after)
      const mostradas = v.antes.code.split('\n').length
      expect(v.antes.highlightLines.length).toBeLessThanOrEqual(mostradas)
      expect(v.sinCambios).toBe(false)
    }
  })
})

/* ── 4. El alcance manda sobre el color ──────────────────────────────────── */

describe('un comentario que no sale del servidor no se pinta como problema', () => {
  it('la nota interna del servidor va en gris', () => {
    const markup = html(
      createElement(CommentRow, {
        fila: {
          id: 'x.ts:1',
          file: 'x.ts',
          line: 1,
          endLine: 1,
          text: 'No tocar: lo vemos con Ana.',
          reach: 'server_only',
          risk: 'internal_note',
          functional: false,
          reason: 'Es una nota interna del equipo.',
        },
      }),
    )
    expect(markup).not.toContain('incompleto')
    expect(markup).not.toContain('expuesto')
  })

  it('la misma nota, si sale al navegador, sí lleva color', () => {
    const markup = html(
      createElement(CommentRow, {
        fila: {
          id: 'x.tsx:1',
          file: 'x.tsx',
          line: 1,
          endLine: 1,
          text: 'No tocar: lo vemos con Ana.',
          reach: 'ships_to_browser',
          risk: 'internal_note',
          functional: false,
          reason: 'Es una nota interna del equipo.',
        },
      }),
    )
    expect(markup).toContain('incompleto')
  })
})
