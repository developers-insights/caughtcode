/**
 * Pruebas de las piezas puras del agente: lectura del árbol de la página,
 * tapado de datos sensibles, costo, set de tareas y cambio de identificador.
 */

import { describe, expect, it } from 'vitest'

import {
  findByPhrases,
  normalize,
  parseAriaSnapshot,
  summarizeForModel,
} from '@/server/agent/aria'
import { CostCapExceededError, CostMeter } from '@/server/agent/cost'
import { extractJson, AgentActionSchema } from '@/server/agent/driver'
import { REDACTION_NOTES, redactText, redactUrl } from '@/server/agent/redact'
import { selectTasks, ALL_TASKS, TASK_ORDER } from '@/server/agent/tasks'
import { describeContent, mutateId } from '@/server/agent/tasks/cross-tenant'
import { identifyTracker } from '@/server/agent/tasks/shared'
import type { StackInfo } from '@/lib/types/domain'

const SNAPSHOT = `- generic [active] [ref=e1]:
  - heading "Ingresar" [level=1] [ref=e2]
  - generic [ref=e3]:
    - text: Email
    - textbox "Email" [ref=e5]
    - textbox "Contraseña" [ref=e7]
    - button "Entrar" [ref=e8]
  - link "Crear cuenta" [ref=e9] [cursor=pointer]:
    - /url: /registro
  - link "Eliminá tu cuenta" [ref=e11]:
    - /url: /cuenta/baja`

describe('árbol de la página', () => {
  it('saca rol, nombre, referencia y destino de cada elemento', () => {
    const tree = parseAriaSnapshot(SNAPSHOT)
    expect(tree.nodes.length).toBeGreaterThan(5)

    const boton = tree.byRef.get('e8')
    expect(boton?.role).toBe('button')
    expect(boton?.name).toBe('Entrar')

    const enlace = tree.byRef.get('e9')
    expect(enlace?.role).toBe('link')
    expect(enlace?.url).toBe('/registro')

    const encabezado = tree.byRef.get('e2')
    expect(encabezado?.attrs).toContain('level=1')
  })

  it('ignora líneas que no entiende en vez de romper', () => {
    const tree = parseAriaSnapshot('basura\n- button "Ok" [ref=e1]\n   ???  \n')
    expect(tree.byRef.get('e1')?.name).toBe('Ok')
  })

  it('encuentra frases sin importar tildes ni mayúsculas', () => {
    const tree = parseAriaSnapshot(SNAPSHOT)
    const hits = findByPhrases(tree, ['eliminar cuenta', 'elimina tu cuenta'])
    expect(hits.map((node) => node.ref)).toContain('e11')
  })

  it('el resumen para el modelo conserva las referencias', () => {
    const resumen = summarizeForModel(parseAriaSnapshot(SNAPSHOT))
    expect(resumen).toContain('[ref=e8]')
    expect(resumen).toContain('button "Entrar"')
    expect(resumen.split('\n').length).toBeLessThan(20)
  })

  it('normaliza tildes', () => {
    expect(normalize('Eliminá TU Cuenta')).toBe('elimina tu cuenta')
  })
})

describe('tapado de datos sensibles', () => {
  it('oculta pases y llaves en los parámetros de la dirección', () => {
    const limpia = redactUrl('https://app.example/panel?access_token=abc123&vista=lista')
    expect(limpia).toContain('vista=lista')
    expect(limpia).not.toContain('abc123')
  })

  it('oculta el pase que viaja en el fragmento, como el de los enlaces mágicos', () => {
    const limpia = redactUrl('https://app.example/#access_token=secreto&refresh_token=otro&type=recovery')
    expect(limpia).not.toContain('secreto')
    expect(limpia).not.toContain('otro')
    expect(limpia).toContain('type=recovery')
  })

  it('deja intactas las direcciones sin secretos', () => {
    expect(redactUrl('https://app.example/factura/2')).toBe('https://app.example/factura/2')
  })

  it('oculta números de tarjeta y llaves en texto libre', () => {
    expect(redactText('pagué con 4111 1111 1111 1111')).not.toContain('4111')
    expect(redactText('la llave es sk_live_abcdefghijklmnop')).not.toContain('sk_live_abcdefghijklmnop')
  })

  it('documenta qué no puede tapar', () => {
    expect(REDACTION_NOTES.notCovered.length).toBeGreaterThan(2)
  })
})

describe('costo', () => {
  it('estima el costo cuando el proveedor no informa el consumo', () => {
    const meter = new CostMeter()
    const costo = meter.recordLlm(undefined, 'agente:login', 4000, 400)
    expect(costo).toBeGreaterThan(0)
    expect(meter.totalUsd).toBeCloseTo(costo, 10)
  })

  it('usa el costo real si el proveedor lo informa', () => {
    const meter = new CostMeter()
    meter.recordLlm({ costUsd: 0.0123 }, 'agente:login', 10, 10)
    expect(meter.totalUsd).toBeCloseTo(0.0123, 6)
  })

  it('aborta al llegar al tope duro', () => {
    const meter = new CostMeter({ hardCapUsd: 0.01 })
    meter.recordLlm({ costUsd: 0.02 }, 'agente:primary_flow')
    expect(meter.isOverCap()).toBe(true)
    expect(() => meter.assertUnderCap()).toThrow(CostCapExceededError)
  })

  it('separa el costo por tarea', () => {
    const meter = new CostMeter()
    meter.recordLlm({ costUsd: 0.01 }, 'agente:login')
    meter.recordLlm({ costUsd: 0.02 }, 'agente:signup')
    expect(meter.costFor('agente:login')).toBeCloseTo(0.01, 6)
    expect(meter.costFor('agente:signup')).toBeCloseTo(0.02, 6)
  })

  it('cobra el tiempo de navegador', () => {
    const meter = new CostMeter({ browserUsdPerMinute: 0.06 })
    meter.recordBrowser(60_000, 'agente:login')
    expect(meter.totalUsd).toBeCloseTo(0.06, 6)
  })

  it('lo cuenta en dólares, no en créditos', () => {
    const meter = new CostMeter()
    meter.recordLlm({ costUsd: 0.42 }, 'agente:login')
    expect(meter.describePlain()).toContain('US$')
    expect(meter.describePlain().toLowerCase()).not.toContain('credito')
  })
})

describe('respuesta del modelo', () => {
  it('extrae el JSON aunque venga envuelto en explicaciones', () => {
    const parsed = extractJson('Claro:\n```json\n{"action":"click","selector":"ref=e3","why":"entro"}\n```\n')
    expect(AgentActionSchema.parse(parsed).selector).toBe('ref=e3')
  })

  it('rechaza una acción que no está en el contrato', () => {
    expect(() => AgentActionSchema.parse({ action: 'ejecutar_sql', why: 'x' })).toThrow()
  })

  it('rechaza una respuesta sin JSON', () => {
    expect(() => extractJson('no sé qué hacer')).toThrow()
  })
})

describe('set de tareas', () => {
  it('trae las diez tareas cuando la app tiene cuentas', () => {
    expect(selectTasks(null).length).toBe(TASK_ORDER.length)
  })

  it('saca las pruebas de cuenta en un sitio sin base de datos', () => {
    const stack: StackInfo = {
      framework: 'astro',
      language: 'typescript',
      packageManager: 'pnpm',
      backends: ['none'],
      hasTypescript: true,
      hasTailwind: true,
      routerKind: 'unknown',
      evidence: [],
    }
    const ids = selectTasks(stack).map((task) => task.id)
    expect(ids).toContain('cookie_banner')
    expect(ids).toContain('privacy_terms')
    expect(ids).not.toContain('delete_account')
    expect(ids).not.toContain('cross_tenant_read')
  })

  it('marca como destructivas solo las que escriben en la app del usuario', () => {
    // Registrarse crea una cuenta real y editar el perfil pisa datos: piden permiso.
    expect(ALL_TASKS.signup.destructive).toBe(true)
    expect(ALL_TASKS.edit_profile.destructive).toBe(true)
    // Buscar la opción de borrar la cuenta NO escribe nada. Si pidiera permiso, el
    // hallazgo estrella del producto no correría nunca por defecto. Apretar el botón
    // sigue bloqueado por la barrera de acciones destructivas.
    expect(ALL_TASKS.delete_account.destructive).toBe(false)
    expect(ALL_TASKS.cookie_banner.destructive).toBe(false)
    expect(ALL_TASKS.password_reset.destructive).toBe(false)
  })

  it('respeta el filtro explícito de tareas', () => {
    const ids = selectTasks(null, ['cookie_banner', 'password_reset']).map((task) => task.id)
    expect(ids).toEqual(['cookie_banner', 'password_reset'])
  })
})

describe('cambio de identificador en la dirección', () => {
  it('cambia el número de una factura', () => {
    expect(mutateId('https://app.example/factura/1')).toBe('https://app.example/factura/2')
    expect(mutateId('https://app.example/factura/7')).toBe('https://app.example/factura/6')
  })

  it('cambia el último dígito de un identificador largo', () => {
    const mutada = mutateId('https://app.example/proyecto/1e6f2a3b-4c5d-6e7f-8a9b-0c1d2e3f4a5b')
    expect(mutada).toBe('https://app.example/proyecto/1e6f2a3b-4c5d-6e7f-8a9b-0c1d2e3f4a50')
  })

  it('devuelve null si no hay nada que cambiar', () => {
    expect(mutateId('https://app.example/ajustes')).toBeNull()
  })

  it('describe lo que se ve en pantalla sin jerga', () => {
    const tree = parseAriaSnapshot(`- heading "Factura 2" [level=1] [ref=e1]
- text: Titular: Bruno Prueba`)
    const texto = describeContent(tree)
    expect(texto).toContain('Factura 2')
    expect(texto).toContain('Bruno Prueba')
  })
})

describe('rastreadores', () => {
  it('reconoce los conocidos', () => {
    expect(
      identifyTracker({
        atMs: 10,
        url: 'https://www.google-analytics.com/g/collect?v=2',
        method: 'POST',
        resourceType: 'fetch',
        hostname: 'www.google-analytics.com',
        isNavigation: false,
        blocked: false,
      }),
    ).toBe('Google Analytics')
  })

  it('no marca como rastreador un pedido propio de la app', () => {
    expect(
      identifyTracker({
        atMs: 10,
        url: 'https://mi-app.example/api/facturas',
        method: 'GET',
        resourceType: 'fetch',
        hostname: 'mi-app.example',
        isNavigation: false,
        blocked: false,
      }),
    ).toBeNull()
  })
})
