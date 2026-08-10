import { describe, expect, it } from 'vitest'

import { CATALOGO, completar } from '@/content/catalogo'
import { detectarJerga } from '@/content/lenguaje'
import type { Finding } from '@/lib/types/domain'
import { ojalDeEscena } from '@/server/video/render/page'
import {
  armarNarracion,
  buildScript,
  detectarDesanclaje,
  elegirDiagrama,
  elegirRecorte,
  extraerJson,
  guionDeterminista,
  reunirHechos,
  validarGuion,
  type GuionLlm,
} from '@/server/video/script'
import { CLIP_MAX_MS, CLIP_MIN_MS, PRESUPUESTO_CARACTERES } from '@/server/video/timing'

import { ARCHIVO_EJEMPLO, hallazgoDeEjemplo, sesionDeEjemplo } from './fixtures'

const hallazgo = hallazgoDeEjemplo()
const sesiones = [sesionDeEjemplo()]

describe('estructura del clip', () => {
  it('son cuatro momentos, en orden', async () => {
    const { script } = await buildScript(hallazgo, sesiones, null)
    expect(script.scenes.map((s) => s.id)).toEqual(['gancho', 'demo-1', 'prueba', 'accion'])
  })

  it('la demostración usa la grabación y la prueba usa el código', async () => {
    const { script } = await buildScript(hallazgo, sesiones, null)
    expect(script.scenes[1].visual.type).toBe('recording')
    expect(script.scenes[2].visual).toMatchObject({ type: 'code', file: ARCHIVO_EJEMPLO, line: 42 })
  })

  it('sin grabación la demostración cae en un esquema, y lo avisa', async () => {
    const sinRecording = hallazgoDeEjemplo({
      evidence: hallazgo.evidence.filter((e) => e.kind !== 'recording'),
    })
    const { script, avisos } = await buildScript(sinRecording, [], null)
    expect(script.scenes[1].visual.type).toBe('diagram')
    expect(avisos.join(' ')).toMatch(/no hay grabación/i)
  })

  it('sin modelo inyectado igual sale un guion, y lo dice', async () => {
    const { usoLlm, avisos, script } = await buildScript(hallazgo, sesiones, null)
    expect(usoLlm).toBe(false)
    expect(avisos.join(' ')).toMatch(/sin modelo/i)
    expect(script.scenes.every((s) => s.narration.trim().length > 0)).toBe(true)
  })
})

describe('el guion no habla más de lo que se puede probar', () => {
  it('detecta un archivo que no está en el material', () => {
    const hechos = reunirHechos(hallazgo, sesiones, null)
    const fallos = detectarDesanclaje('Lo vimos en src/lib/secreto.ts, bien escondido.', hechos)
    expect(fallos).toContainEqual({ tipo: 'archivo', valor: 'src/lib/secreto.ts' })
  })

  it('deja pasar el archivo que sí está en la evidencia', () => {
    const hechos = reunirHechos(hallazgo, sesiones, null)
    expect(detectarDesanclaje(`Está en ${ARCHIVO_EJEMPLO}.`, hechos)).toHaveLength(0)
  })

  it('detecta una línea inventada', () => {
    const hechos = reunirHechos(hallazgo, sesiones, null)
    expect(detectarDesanclaje('Mirá la línea 999.', hechos)).toContainEqual({
      tipo: 'linea',
      valor: '999',
    })
    expect(detectarDesanclaje('Mirá la línea 42.', hechos)).toHaveLength(0)
  })

  it('detecta una dirección web inventada', () => {
    const hechos = reunirHechos(hallazgo, sesiones, null)
    expect(detectarDesanclaje('Entramos a https://otra-cosa.test/admin', hechos)).toContainEqual({
      tipo: 'url',
      valor: 'https://otra-cosa.test/admin',
    })
    expect(detectarDesanclaje('Entramos a https://demo.test/panel', hechos)).toHaveLength(0)
  })

  it('rechaza el guion del modelo si inventa algo', () => {
    const hechos = reunirHechos(hallazgo, sesiones, null)
    const inventado = guionLlmValido({
      prueba: {
        narracion:
          'La llave de administrador quedó escrita en src/config/claves.ts y viaja al navegador de cualquiera que abra tu sitio.',
        rotulo: 'La prueba',
      },
    })
    const rechazo = validarGuion(inventado, hechos)
    expect(rechazo?.motivo).toMatch(/no están en el hallazgo/i)
  })

  it('rechaza el guion del modelo si mete jerga', () => {
    const hechos = reunirHechos(hallazgo, sesiones, null)
    const conJerga = guionLlmValido({
      gancho: { narracion: 'Encontramos que tu RLS quedó mal configurada del todo.', placa: 'Mirá esto' },
    })
    const rechazo = validarGuion(conJerga, hechos)
    expect(rechazo?.motivo).toMatch(/jerga/i)
    expect(rechazo?.detalle).toContain('RLS')
  })

  it('acepta un guion que se queda dentro del material', () => {
    const hechos = reunirHechos(hallazgo, sesiones, null)
    expect(validarGuion(guionLlmValido(), hechos)).toBeNull()
  })

  it('cuando el modelo se sale del libreto, se usa el guion mecánico', async () => {
    const { usoLlm, avisos, script } = await buildScript(hallazgo, sesiones, null, {
      complete: async () =>
        JSON.stringify(
          guionLlmValido({
            prueba: {
              narracion:
                'La llave de administrador quedó escrita en src/inventado/archivo.ts y viaja al navegador de cualquiera que abra tu sitio.',
              rotulo: 'La prueba',
            },
          }),
        ),
    })
    expect(usoLlm).toBe(false)
    expect(avisos.join(' ')).toMatch(/no están en el hallazgo/i)
    expect(script.scenes[2].narration).not.toContain('src/inventado')
  })

  it('usa el guion del modelo cuando está bien', async () => {
    const bueno = guionLlmValido()
    const { usoLlm, script } = await buildScript(hallazgo, sesiones, null, {
      complete: async () => ({ text: '```json\n' + JSON.stringify(bueno) + '\n```', model: 'claude-sonnet-5' }),
    })
    expect(usoLlm).toBe(true)
    expect(script.title).toBe(bueno.titulo)
    expect(script.scenes[0].narration).toBe(bueno.gancho.narracion)
  })

  it('si el modelo falla, el clip igual se hace', async () => {
    const { usoLlm, avisos } = await buildScript(hallazgo, sesiones, null, {
      complete: async () => {
        throw new Error('se cayó la red')
      },
    })
    expect(usoLlm).toBe(false)
    expect(avisos.join(' ')).toMatch(/se cayó la red/)
  })
})

describe('duración', () => {
  it('el guion nace dentro de la banda de D12', async () => {
    const { script } = await buildScript(hallazgo, sesiones, null)
    expect(script.totalDurationMs).toBeGreaterThanOrEqual(CLIP_MIN_MS)
    expect(script.totalDurationMs).toBeLessThanOrEqual(CLIP_MAX_MS)
  })

  it('la suma de las escenas coincide con el total', async () => {
    const { script } = await buildScript(hallazgo, sesiones, null)
    const suma = script.scenes.reduce((a, s) => a + s.durationMs, 0)
    expect(script.totalDurationMs).toBeGreaterThanOrEqual(suma)
  })
})

describe('dogfooding: nuestra propia narración no puede tener jerga', () => {
  const muestra = CATALOGO.slice(0, 40)

  it.each(muestra.map((c) => [c.id, c] as const))(
    'el guion mecánico de %s habla en castellano llano',
    (_id, cat) => {
      const valores = { archivo: 'src/app/pagina.tsx', linea: 12, tabla: 'pedidos', proveedor: 'Stripe' }
      const finding: Finding = {
        ...hallazgoDeEjemplo(),
        checkId: cat.id,
        pillar: cat.pillar,
        severity: cat.severity,
        titlePlain: completar(cat.titlePlain, valores),
        explanationPlain: completar(cat.explanationPlain, valores),
        impactPlain: completar(cat.impactPlain, valores),
      }
      const textos = guionDeterminista(finding, [sesionDeEjemplo()], elegirRecorte(finding, [sesionDeEjemplo()]))
      const narraciones = [
        textos.gancho.narracion,
        ...textos.demostracion.map((d) => d.narracion),
        textos.prueba.narracion,
        textos.accion.narracion,
      ]
      for (const n of narraciones) expect(detectarJerga(n)).toEqual([])
    },
  )
})

describe('la narración nunca queda cortada a mitad de frase', () => {
  // Regresión: el gancho pegaba la conclusión del agente con el título y
  // recortaba a 80 caracteres, lo que producía "…y entramos al panel La llave."
  // La voz leía eso en voz alta.
  it('descarta la oración que no entra en vez de cortarla', () => {
    const salida = armarNarracion(
      ['Nos registramos en tu app como un usuario más y entramos al panel.', 'La llave maestra de tu base está en el navegador.'],
      80,
    )
    expect(salida).toBe('Nos registramos en tu app como un usuario más y entramos al panel.')
    expect(salida).not.toMatch(/La llave$/)
  })

  it('suma oraciones enteras mientras entren', () => {
    expect(armarNarracion(['Una. Dos. Tres.'], 200)).toBe('Una. Dos. Tres.')
    expect(armarNarracion(['Una. Dos. Tres.'], 9)).toBe('Una. Dos.')
  })

  it('toda narración generada termina en puntuación', () => {
    const textos = guionDeterminista(hallazgo, sesiones, elegirRecorte(hallazgo, sesiones))
    const narraciones = [
      textos.gancho.narracion,
      ...textos.demostracion.map((d) => d.narracion),
      textos.prueba.narracion,
      textos.accion.narracion,
    ]
    for (const n of narraciones) expect(n).toMatch(/[.!?…]$/)
  })

  it('respeta el presupuesto de cada tramo', () => {
    const textos = guionDeterminista(hallazgo, sesiones, elegirRecorte(hallazgo, sesiones))
    expect(textos.gancho.narracion.length).toBeLessThanOrEqual(PRESUPUESTO_CARACTERES.gancho.max)
    expect(textos.prueba.narracion.length).toBeLessThanOrEqual(PRESUPUESTO_CARACTERES.prueba.max)
    expect(textos.accion.narracion.length).toBeLessThanOrEqual(PRESUPUESTO_CARACTERES.accion.max)
  })

  it('el ojal no repite lo que dice el titular', async () => {
    const { script } = await buildScript(hallazgo, sesiones, null)
    const accion = script.scenes.find((s) => s.id === 'accion')!
    const titular = accion.visual.type === 'statement' ? accion.visual.headline : ''
    expect(ojalDeEscena('accion').toLowerCase()).not.toBe(titular.toLowerCase())
    expect(titular.toLowerCase()).not.toContain(ojalDeEscena('accion').toLowerCase())
  })
})

describe('elección de esquema', () => {
  it('una clave expuesta se dibuja como una llave', () => {
    expect(elegirDiagrama(hallazgoDeEjemplo({ checkId: 'sec.secret_in_repo' }))).toBe('exposed-key')
  })
  it('un problema de completitud se dibuja como un recorrido', () => {
    expect(elegirDiagrama(hallazgoDeEjemplo({ checkId: 'comp.no_logout', pillar: 'completeness' }))).toBe(
      'missing-flow',
    )
  })
  it('un dato que se filtra entre cuentas se dibuja como una fuga', () => {
    expect(elegirDiagrama(hallazgoDeEjemplo({ checkId: 'sec.rls_permissive' }))).toBe('tenant-leak')
  })
})

describe('extracción de JSON', () => {
  it('aguanta que venga envuelto en markdown', () => {
    expect(extraerJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
  })
  it('aguanta texto antes y después', () => {
    expect(extraerJson('Acá va: {"a":1} listo')).toEqual({ a: 1 })
  })
  it('avisa cuando no hay JSON', () => {
    expect(() => extraerJson('no hay nada')).toThrow(/JSON/)
  })
})

function guionLlmValido(parciales: Partial<GuionLlm> = {}): GuionLlm {
  return {
    titulo: 'La llave maestra de tu base está a la vista',
    gancho: {
      narracion: 'Nos registramos en tu app y entramos al panel sin que nos pidiera nada.',
      placa: 'Entramos como un usuario más',
    },
    demostracion: [
      {
        narracion:
          'Mirá lo que hicimos. Nos creamos una cuenta con un correo cualquiera y en dos pasos ya estábamos adentro del panel.',
        rotulo: 'Nos creamos una cuenta',
      },
    ],
    prueba: {
      narracion: `La llave de administrador está escrita en ${ARCHIVO_EJEMPLO}, en la línea 42, y viaja al navegador de cualquiera que abra tu sitio.`,
      rotulo: 'La prueba',
    },
    accion: {
      narracion:
        'Copiá el texto que dejamos abajo y pegáselo a la herramienta con la que armaste tu app. Después cambiá esa llave por una nueva.',
      placa: 'Qué hacer ahora',
    },
    ...parciales,
  }
}
