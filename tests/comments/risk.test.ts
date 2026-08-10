import { describe, expect, it } from 'vitest'

import { classifyRisk, maskSecrets } from '@/server/comments/risk'
import { scanFile } from '@/server/comments/scanner'
import { fixture, fixturePath } from '../fixtures/comments/load'

const STRIPE = 'sk_live_51H8xQ2LkJhGf3nQpZrTuVwXy'

describe('risk — secretos', () => {
  it('detecta claves de proveedores conocidos', () => {
    expect(classifyRisk(`clave: ${STRIPE}`).risk).toBe('secret')
    expect(classifyRisk('AKIAIOSFODNN7EXAMPLE').risk).toBe('secret')
    expect(classifyRisk('AIzaSyD-1234567890abcdefghijklmnopqrstu').risk).toBe('secret')
    expect(classifyRisk('sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789').risk).toBe('secret')
    expect(classifyRisk('ghp_abcdefghijklmnopqrstuvwxyz0123456789').risk).toBe('secret')
  })

  it('detecta cadenas de conexión con usuario y contraseña', () => {
    expect(classifyRisk('postgres://admin:Sup3rS3cret@db.example.com:5432/prod').risk).toBe('secret')
  })

  it('detecta un JWT', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.QW5vdGhlckZha2VTaWc'
    expect(classifyRisk(jwt).risk).toBe('secret')
  })

  it('detecta una asignación genérica de contraseña', () => {
    expect(classifyRisk('password = "Tr0ub4dor&3xtra"').risk).toBe('secret')
  })

  it('no marca como secreto una frase común', () => {
    expect(classifyRisk('acordarse de pedir la clave al equipo').risk).not.toBe('secret')
  })
})

describe('risk — enmascarado', () => {
  it('nunca deja el valor completo en el texto', () => {
    const out = maskSecrets(`clave vieja: ${STRIPE} (rotar)`)
    expect(out).not.toContain(STRIPE)
    expect(out).toContain('••••')
  })

  it('conserva el prefijo del proveedor y los últimos cuatro caracteres', () => {
    const out = maskSecrets(STRIPE)
    expect(out.startsWith('sk_live_')).toBe(true)
    expect(out.endsWith(STRIPE.slice(-4))).toBe(true)
  })

  it('enmascara por completo un valor corto', () => {
    const out = maskSecrets('password = "abc123"')
    expect(out).not.toContain('abc123')
  })

  it('el scanner nunca copia el secreto entero al resultado', () => {
    const res = scanFile({ file: fixturePath('secrets-note.ts'), text: fixture('secrets-note.ts') })
    const todo = JSON.stringify(res.hits)
    expect(todo).not.toContain(STRIPE)
    expect(todo).not.toContain('Sup3rS3cret')
    expect(todo).not.toContain('QW5vdGhlckZha2VTaWduYXR1cmU')
    expect(res.hits.filter((h) => h.risk === 'secret')).toHaveLength(3)
  })
})

describe('risk — notas internas', () => {
  it('detecta frases internas, IPs privadas y menciones a personas', () => {
    expect(classifyRisk('no tocar: el cliente no sabe que esto esta hardcodeado').risk).toBe(
      'internal_note',
    )
    expect(classifyRisk('staging: http://192.168.1.44:3000/admin').risk).toBe('internal_note')
    expect(classifyRisk('preguntar a Sofia antes de cambiar el orden').risk).toBe('internal_note')
  })
})

describe('risk — pendientes', () => {
  it('detecta los marcadores habituales', () => {
    for (const m of ['TODO', 'FIXME', 'XXX', 'HACK', 'WIP']) {
      expect(classifyRisk(`${m}: algo`).risk).toBe('todo')
    }
  })

  it('no confunde una palabra que contiene el marcador', () => {
    expect(classifyRisk('todos los usuarios ven la lista').risk).toBe('none')
  })

  it('no confunde "todo" en minúscula, palabra española común', () => {
    expect(classifyRisk('Todo esto llega armado desde el servidor').risk).toBe('none')
    expect(classifyRisk('revisar todo antes de publicar').risk).toBe('none')
  })
})

describe('risk — código comentado', () => {
  it('detecta un bloque de varias líneas que es código', () => {
    const inner = [
      'export function viejo(n) {',
      '  const a = calcular(n, 2)',
      '  return a * 2',
      '}',
    ].join('\n')
    expect(classifyRisk(inner).risk).toBe('disabled_code')
  })

  it('no marca como código una explicación en prosa de varias líneas', () => {
    const prosa = [
      'Esta funcion quedo vieja cuando cambiamos el calculo.',
      'La dejamos por las dudas, pero no se usa mas en ningun lado.',
    ].join('\n')
    expect(classifyRisk(prosa).risk).toBe('none')
  })

  it('no marca como código una sola línea', () => {
    expect(classifyRisk('const a = 1').risk).toBe('none')
  })
})

describe('risk — precedencia', () => {
  it('un secreto gana sobre un pendiente', () => {
    expect(classifyRisk(`TODO: rotar ${STRIPE}`).risk).toBe('secret')
  })

  it('una nota interna gana sobre un pendiente', () => {
    expect(classifyRisk('TODO: no tocar, el cliente no sabe').risk).toBe('internal_note')
  })
})

describe('risk — clasificación sobre los fixtures', () => {
  it('separa notas internas de pendientes en notes.ts', () => {
    const res = scanFile({ file: fixturePath('notes.ts'), text: fixture('notes.ts') })
    const riesgos = res.hits.map((h) => h.risk)
    expect(riesgos).toContain('internal_note')
    expect(riesgos).toContain('todo')
    expect(riesgos).toContain('none')
  })

  it('detecta el bloque comentado en disabled-code.ts', () => {
    const res = scanFile({ file: fixturePath('disabled-code.ts'), text: fixture('disabled-code.ts') })
    expect(res.hits.some((h) => h.risk === 'disabled_code')).toBe(true)
  })
})
