/**
 * La promesa más cara del producto: **nunca escribimos en la base de nadie.**
 *
 * Un cliente de `pg` de mentira registra TODAS las sentencias que salen. El test
 * falla si aparece un `insert`, `update`, `delete` o `commit` — y también en los
 * caminos feos, que son los que importan:
 *
 *   - el chequeo tira una excepción a mitad de la sonda
 *   - el `rollback` mismo falla
 *   - un chequeo intenta escribir a propósito
 *
 * En los tres casos la transacción tiene que quedar deshecha y la conexión
 * cerrada. Si este archivo se pone en rojo, no se publica nada.
 */

import { describe, it, expect } from 'vitest'
import {
  assertSoloLectura,
  conLecturaSimple,
  conSondaDeLectura,
  EscrituraBloqueadaError,
  leerComoUsuario,
  RolInvalidoError,
} from '@/server/checks/lib/pg-readonly'
import type { SqlClient } from '@/server/checks/lib/pg-readonly'
import { CHEQUEOS } from '@/server/checks/registry'
import type { Check } from '@/server/checks/lib/context'
import {
  contextoDe,
  ESQUEMA_CON_PROBLEMAS,
} from '../fixtures/checks/contexto'
import { borrarProyecto, crearProyecto } from '../fixtures/checks/proyectos'

/* ── Cliente de mentira ───────────────────────────────────────────────── */

interface ClienteEspia extends SqlClient {
  sentencias: string[]
  cerrado: boolean
}

interface OpcionesEspia {
  /** Filas que devuelve cada consulta, por orden de `select`. */
  filas?: Record<string, unknown>[][]
  /** Si la sentencia matchea, tira error. Simula una base que se rompe. */
  fallaEn?: RegExp
}

function clienteEspia(opciones: OpcionesEspia = {}): ClienteEspia {
  const filas = [...(opciones.filas ?? [])]
  const espia: ClienteEspia = {
    sentencias: [],
    cerrado: false,
    async query(text) {
      espia.sentencias.push(text.trim().toLowerCase())
      if (opciones.fallaEn?.test(text)) {
        throw new Error(`la base rechazó: ${text}`)
      }
      // `select set_config(...)` es parte del marco de la transacción, no una
      // consulta de datos: no puede comerse las filas que espera la sonda.
      if (/^\s*select/i.test(text) && !/set_config/i.test(text)) {
        return { rows: filas.shift() ?? [] }
      }
      return { rows: [] }
    },
    async end() {
      espia.cerrado = true
    },
  }
  return espia
}

/** Verbos que nunca pueden aparecer. Es la aserción central del archivo. */
const PROHIBIDO = /\b(insert|update|delete|truncate|drop|alter|create|grant|revoke|commit)\b/

function exigirSoloLectura(sentencias: string[]): void {
  for (const sentencia of sentencias) {
    expect(
      PROHIBIDO.test(sentencia),
      `salió una sentencia que no es de solo lectura: "${sentencia}"`,
    ).toBe(false)
  }
  expect(sentencias.filter((s) => s === 'commit')).toHaveLength(0)
}

/* ── El marco de la transacción ───────────────────────────────────────── */

describe('la sonda de solo lectura', () => {
  it('abre, se pone en solo lectura, simula al usuario y siempre deshace', async () => {
    const cliente = clienteEspia({ filas: [[{ total: '3' }]] })

    await leerComoUsuario(cliente, { sub: 'usuario-a', role: 'authenticated' }, async (q) => {
      await q('select count(*) from "public"."notas" where "user_id" = $1', ['usuario-b'])
    })

    expect(cliente.sentencias).toEqual([
      'begin',
      'set transaction read only',
      'set local statement_timeout = 8000',
      'set local role authenticated',
      'select set_config($1, $2, true)',
      'select count(*) from "public"."notas" where "user_id" = $1',
      'rollback',
    ])
    exigirSoloLectura(cliente.sentencias)
  })

  it('deshace igual cuando la sonda tira una excepción a mitad', async () => {
    const cliente = clienteEspia()

    await expect(
      leerComoUsuario(cliente, { sub: 'usuario-a' }, async (q) => {
        await q('select 1')
        throw new Error('el chequeo se rompió justo acá')
      }),
    ).rejects.toThrow('el chequeo se rompió justo acá')

    expect(cliente.sentencias.at(-1)).toBe('rollback')
    exigirSoloLectura(cliente.sentencias)
  })

  it('deshace igual cuando la consulta la rechaza la base', async () => {
    const cliente = clienteEspia({ fallaEn: /from "public"\."secreta"/ })

    await expect(
      leerComoUsuario(cliente, { sub: 'usuario-a' }, async (q) => {
        await q('select * from "public"."secreta"')
      }),
    ).rejects.toThrow('la base rechazó')

    expect(cliente.sentencias).toContain('rollback')
    exigirSoloLectura(cliente.sentencias)
  })

  it('si el rollback mismo falla, no se traga el error original ni deja la conexión abierta', async () => {
    const cliente = clienteEspia({ fallaEn: /^rollback$/ })

    await expect(
      conSondaDeLectura(
        'postgres://falsa/db',
        async () => cliente,
        { sub: 'usuario-a' },
        async (q) => {
          await q('select 1')
          throw new Error('error original')
        },
      ),
    ).rejects.toThrow('error original')

    expect(cliente.sentencias).toContain('rollback')
    expect(cliente.cerrado, 'la conexión quedó abierta').toBe(true)
    exigirSoloLectura(cliente.sentencias)
  })

  it('cierra la conexión aunque todo salga bien', async () => {
    const cliente = clienteEspia({ filas: [[{ uno: 1 }]] })
    await conSondaDeLectura('postgres://falsa/db', async () => cliente, { sub: 'a' }, async (q) => {
      await q('select 1 as uno')
    })
    expect(cliente.cerrado).toBe(true)
    exigirSoloLectura(cliente.sentencias)
  })

  it('la lectura simple también deshace y cierra', async () => {
    const cliente = clienteEspia({ filas: [[{ dueno: 'a' }]] })
    await conLecturaSimple('postgres://falsa/db', async () => cliente, async (q) => {
      await q('select distinct "user_id" as dueno from "public"."notas" limit 2')
    })
    expect(cliente.sentencias).toContain('rollback')
    expect(cliente.cerrado).toBe(true)
    exigirSoloLectura(cliente.sentencias)
  })
})

/* ── La lista negra ───────────────────────────────────────────────────── */

describe('la barrera contra escrituras', () => {
  const escrituras = [
    'insert into public.notas values (1)',
    'update public.notas set texto = 1',
    'delete from public.notas',
    'commit',
    'truncate public.notas',
    'drop table public.notas',
    'alter table public.notas enable row level security',
    'create table x (id int)',
    'grant select on public.notas to anon',
    // Escondidas detrás de un comentario.
    'select 1; -- \n insert into public.notas values (1)',
    '/* select */ delete from public.notas',
    // Encadenadas con punto y coma.
    'select 1; commit',
  ]

  for (const sentencia of escrituras) {
    it(`bloquea: ${sentencia.slice(0, 44)}`, () => {
      expect(() => assertSoloLectura(sentencia)).toThrow(EscrituraBloqueadaError)
    })
  }

  const lecturas = [
    'select 1',
    'select count(*) from "public"."notas" where "user_id" = $1',
    'select distinct "user_id" as dueno from "public"."mensajes" limit 2',
    'select set_config($1, $2, true)',
    // Nombres que contienen un verbo prohibido pero no lo son.
    'select "created_at", "deleted_at", "updated_at" from "public"."facturas"',
    'select * from "public"."updates"',
  ]

  for (const sentencia of lecturas) {
    it(`deja pasar: ${sentencia.slice(0, 44)}`, () => {
      expect(() => assertSoloLectura(sentencia)).not.toThrow()
    })
  }

  it('una sonda que intenta escribir se corta antes de tocar la red, y deshace', async () => {
    const cliente = clienteEspia()

    await expect(
      leerComoUsuario(cliente, { sub: 'usuario-a' }, async (q) => {
        await q('insert into public.notas (texto) values (\'hola\')')
      }),
    ).rejects.toThrow(EscrituraBloqueadaError)

    // La sentencia bloqueada nunca llegó al cliente.
    expect(cliente.sentencias.some((s) => s.includes('insert'))).toBe(false)
    expect(cliente.sentencias.at(-1)).toBe('rollback')
    exigirSoloLectura(cliente.sentencias)
  })

  it('rechaza un nombre de rol que no tiene forma de nombre de rol', async () => {
    const cliente = clienteEspia()
    await expect(
      leerComoUsuario(cliente, { sub: 'a' }, async () => undefined, {
        rol: 'authenticated; drop table users',
      }),
    ).rejects.toThrow(RolInvalidoError)
    // Ni siquiera abrió la transacción.
    expect(cliente.sentencias).toHaveLength(0)
  })

  it('el id del usuario simulado viaja como parámetro, no pegado en el texto', async () => {
    const cliente = clienteEspia()
    const peligroso = "', 'x') --"

    await leerComoUsuario(cliente, { sub: peligroso }, async () => undefined)

    const setConfig = cliente.sentencias.find((s) => s.includes('set_config'))
    expect(setConfig).toBe('select set_config($1, $2, true)')
    expect(setConfig).not.toContain(peligroso)
  })

  it('el módulo no tiene ninguna forma de emitir un commit', async () => {
    // La garantía estructural: `commit` solo aparece en comentarios y en la
    // lista negra. Ninguna ruta de código lo manda.
    const fuente = await import('node:fs/promises').then((fs) =>
      fs.readFile('src/server/checks/lib/pg-readonly.ts', 'utf8'),
    )
    const sinComentarios = fuente
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
    const enCodigo = sinComentarios.match(/commit/gi) ?? []
    // La única aparición legítima es dentro de la expresión de la lista negra.
    expect(enCodigo).toHaveLength(1)
    expect(sinComentarios).toMatch(/VERBOS_PROHIBIDOS[\s\S]{0,200}commit/)
  })
})

/* ── El chequeo estrella, de punta a punta ────────────────────────────── */

describe('sec.rls_permissive contra una base de mentira', () => {
  it('prueba en vivo, encuentra filas ajenas y no escribe nada', async () => {
    const repo = await crearProyecto({ 'README.md': '# app\n' })
    const clientes: ClienteEspia[] = []

    try {
      const ctx = contextoDe(repo, {
        // Solo `facturas`: las otras ya las agarran los chequeos por lectura
        // del esquema, y así se aísla el camino de la prueba en vivo.
        dbSchema: {
          ...ESQUEMA_CON_PROBLEMAS,
          tables: ESQUEMA_CON_PROBLEMAS.tables.filter((t) => t.name === 'facturas'),
        },
        databaseUrl: 'postgres://falsa/db',
        connect: async () => {
          // Primera conexión: los dos dueños. Segunda: el conteo de filas ajenas.
          const cliente =
            clientes.length === 0
              ? clienteEspia({ filas: [[{ dueno: 'usuario-a' }, { dueno: 'usuario-b' }]] })
              : clienteEspia({ filas: [[{ total: '7' }]] })
          clientes.push(cliente)
          return cliente
        },
      })

      const check = (CHEQUEOS as Check[]).find((c) => c.id === 'sec.rls_permissive')!
      const drafts = await check.run(ctx)

      expect(drafts).toHaveLength(1)
      expect(drafts[0]!.confidence).toBe('confirmed')
      expect(drafts[0]!.evidence.length).toBeGreaterThan(0)
      expect(drafts[0]!.evidence[0]).toMatchObject({ kind: 'database', object: 'public.facturas' })
      // Le dice al usuario, con todas las letras, que no le tocamos la base.
      expect(drafts[0]!.evidence[0]).toHaveProperty('detail')
      const detalle = (drafts[0]!.evidence[0] as { detail: string }).detail
      expect(detalle).toContain('7')
      expect(detalle).toContain('no se escribió nada')

      // Lo que de verdad importa: las dos conexiones, sentencia por sentencia.
      expect(clientes).toHaveLength(2)
      for (const cliente of clientes) {
        exigirSoloLectura(cliente.sentencias)
        expect(cliente.sentencias).toContain('rollback')
        expect(cliente.cerrado).toBe(true)
      }

      // Y la sonda se hizo pasar por un usuario de verdad.
      expect(clientes[1]!.sentencias).toContain('set local role authenticated')
    } finally {
      await borrarProyecto(repo)
    }
  })

  it('con un solo dueño no afirma nada: no hay dos usuarios que separar', async () => {
    const repo = await crearProyecto({ 'README.md': '# app\n' })
    const clientes: ClienteEspia[] = []

    try {
      const ctx = contextoDe(repo, {
        dbSchema: {
          ...ESQUEMA_CON_PROBLEMAS,
          tables: ESQUEMA_CON_PROBLEMAS.tables.filter((t) => t.name === 'facturas'),
        },
        databaseUrl: 'postgres://falsa/db',
        connect: async () => {
          const cliente = clienteEspia({ filas: [[{ dueno: 'usuario-unico' }]] })
          clientes.push(cliente)
          return cliente
        },
      })

      const check = (CHEQUEOS as Check[]).find((c) => c.id === 'sec.rls_permissive')!
      expect(await check.run(ctx)).toHaveLength(0)

      // Ni siquiera intentó la segunda conexión.
      expect(clientes).toHaveLength(1)
      exigirSoloLectura(clientes[0]!.sentencias)
    } finally {
      await borrarProyecto(repo)
    }
  })

  it('si la base se cae a mitad, no emite hallazgo y deshace', async () => {
    const repo = await crearProyecto({ 'README.md': '# app\n' })
    const clientes: ClienteEspia[] = []

    try {
      const registro: string[] = []
      const ctx = contextoDe(repo, {
        dbSchema: {
          ...ESQUEMA_CON_PROBLEMAS,
          tables: ESQUEMA_CON_PROBLEMAS.tables.filter((t) => t.name === 'facturas'),
        },
        databaseUrl: 'postgres://falsa/db',
        registro,
        connect: async () => {
          const cliente = clienteEspia({ fallaEn: /select distinct/ })
          clientes.push(cliente)
          return cliente
        },
      })

      const check = (CHEQUEOS as Check[]).find((c) => c.id === 'sec.rls_permissive')!
      expect(await check.run(ctx)).toHaveLength(0)

      expect(registro.some((m) => m.includes('no se pudo probar'))).toBe(true)
      for (const cliente of clientes) {
        expect(cliente.sentencias).toContain('rollback')
        expect(cliente.cerrado).toBe(true)
        exigirSoloLectura(cliente.sentencias)
      }
    } finally {
      await borrarProyecto(repo)
    }
  })
})
