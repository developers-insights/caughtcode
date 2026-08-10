import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { cargarRecursos, construirPagina, esc, raizProyecto, tonoDeSeveridad } from '@/server/video/render/page'
import { ubicarEscenas } from '@/server/video/timing'
import type { VideoScript } from '@/lib/types/domain'

const RAIZ = raizProyecto()

async function leer(relativo: string): Promise<string> {
  return readFile(path.join(RAIZ, relativo), 'utf8')
}

/** Todos los `--cc-*` que declara un archivo CSS. */
function tokensDe(css: string): Set<string> {
  return new Set([...css.matchAll(/(--cc-[\w-]+)\s*:/g)].map((m) => m[1]))
}

describe('la copia de tokens no se puede quedar atrás', () => {
  it('el fallback declara todos los tokens del tema claro de la app', async () => {
    const app = await leer('src/styles/tokens.css')
    const fallback = await leer('video/template/fallback-tokens.css')

    // Solo el primer bloque `:root` de la app: el resto es tema oscuro, y el
    // video se renderiza siempre en claro.
    const bloqueClaro = /:root\s*\{([\s\S]*?)\n\}/.exec(app)
    expect(bloqueClaro, 'no encontré el bloque :root de tokens.css').not.toBeNull()

    const deApp = tokensDe(bloqueClaro![1])
    const deFallback = tokensDe(fallback)
    const faltan = [...deApp].filter((t) => !deFallback.has(t))

    expect(
      faltan,
      `Faltan en video/template/fallback-tokens.css: ${faltan.join(', ')}. ` +
        'Copiá el valor del tema claro de src/styles/tokens.css.',
    ).toEqual([])
  })

  it('los cuatro tonos semánticos existen en los dos archivos', async () => {
    const fallback = tokensDe(await leer('video/template/fallback-tokens.css'))
    for (const tono of ['expuesto', 'incompleto', 'verificado', 'revisar']) {
      expect(fallback.has(`--cc-${tono}-solid`), `falta --cc-${tono}-solid`).toBe(true)
    }
  })
})

describe('la escena no puede tener color propio', () => {
  it('escena.css no escribe ni un color suelto', async () => {
    const css = await leer('video/template/escena.css')
    // Se ignoran los comentarios: ahí sí se pueden nombrar valores.
    const sinComentarios = css.replace(/\/\*[\s\S]*?\*\//g, '')

    const hex = sinComentarios.match(/#[0-9a-f]{3,8}\b/gi) ?? []
    expect(hex, `hay colores hex sueltos: ${hex.join(', ')}`).toEqual([])

    const funciones = sinComentarios.match(/\b(rgb|rgba|hsl|hsla)\(/gi) ?? []
    expect(funciones, `hay colores fuera de los tokens: ${funciones.join(', ')}`).toEqual([])

    // oklch() solo puede aparecer dentro de fallback-tokens.css, no acá.
    expect(sinComentarios).not.toMatch(/oklch\(/)
  })

  it('el gradiente violeta-azul de la IA genérica no aparece', async () => {
    const css = await leer('video/template/escena.css')
    expect(css).not.toMatch(/linear-gradient\([^)]*(purple|violet|indigo|#6366f1|#8b5cf6)/i)
  })
})

describe('la página que se graba', () => {
  const script: VideoScript = {
    kind: 'finding',
    title: 'La llave maestra de tu base está en el navegador',
    scenes: [
      {
        id: 'gancho',
        narration: 'Entramos como cualquiera.',
        caption: 'Entramos como cualquiera',
        visual: { type: 'statement', headline: 'Entramos como cualquiera', tone: 'alarm' },
        durationMs: 7_000,
      },
      {
        id: 'prueba',
        narration: 'Está en el archivo.',
        caption: 'La prueba',
        visual: {
          type: 'code',
          file: 'src/app/panel/page.tsx',
          line: 42,
          snippet: 'const a = 1\nconst b = 2',
          highlight: [42],
        },
        durationMs: 12_000,
      },
    ],
    totalDurationMs: 19_700,
  }

  it('incrusta los tokens y arranca en tema claro', async () => {
    const recursos = await cargarRecursos()
    const html = construirPagina({
      script,
      ubicaciones: ubicarEscenas(script.scenes),
      cues: [],
      tono: 'alarm',
      contexto: 'Un hallazgo',
      grabacionSrc: null,
      recursos,
    })

    expect(recursos.origenTokens).toBe('app')
    expect(html).toContain('--cc-expuesto-solid')
    expect(html).toContain(`data-theme="light"`)
    expect(html).toContain(`data-tono="alarm"`)
  })

  it('escapa el texto del usuario en vez de inyectarlo', async () => {
    const recursos = await cargarRecursos()
    const conInyeccion: VideoScript = {
      ...script,
      scenes: [
        {
          ...script.scenes[0],
          visual: {
            type: 'statement',
            headline: '<img src=x onerror=alert(1)>',
            tone: 'alarm',
          },
        },
      ],
    }
    const html = construirPagina({
      script: conInyeccion,
      ubicaciones: ubicarEscenas(conInyeccion.scenes),
      cues: [],
      tono: 'alarm',
      contexto: '</script><script>alert(2)</script>',
      grabacionSrc: null,
      recursos,
    })

    expect(html).not.toContain('<img src=x')
    expect(html).not.toContain('<script>alert(2)')
    expect(html).toContain(esc('<img src=x onerror=alert(1)>'))
  })

  it('el tono sale de la gravedad, no del gusto', () => {
    expect(tonoDeSeveridad('critical')).toBe('alarm')
    expect(tonoDeSeveridad('high')).toBe('alarm')
    expect(tonoDeSeveridad('medium')).toBe('neutral')
    // Confianza baja nunca se pinta de rojo: todavía no está probado.
    expect(tonoDeSeveridad('critical', true)).toBe('revisar')
  })
})
