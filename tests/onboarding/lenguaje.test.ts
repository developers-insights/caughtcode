/**
 * Cero jerga y cero "créditos" en el frente de auth + onboarding + proyectos.
 *
 * No hay un único diccionario de textos acá (a diferencia del catálogo de
 * hallazgos): el copy vive repartido en formularios y mensajes de error a lo
 * largo de varios archivos. Este test barre el código fuente de los archivos
 * que posee este frente, saca los literales de texto que parecen prosa (con
 * un espacio adentro, no una ruta ni un nombre de variable) y les pasa
 * `detectarJerga()`. Aparte, la palabra "crédito" no puede aparecer ni una
 * vez, en ningún lado — ni en un comentario.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { detectarJerga } from '@/content/lenguaje'

const ROOT = path.resolve(__dirname, '../..')

/** Carpetas y archivos que posee este frente (ver CLAUDE.md del frente). */
const RUTAS_PROPIAS = [
  'proxy.ts',
  'src/app/(auth)',
  'src/app/(app)/layout.tsx',
  'src/app/(app)/shell.tsx',
  'src/app/(app)/current-org.ts',
  'src/app/(app)/demo.ts',
  'src/app/(app)/proyectos/page.tsx',
  'src/app/(app)/proyectos/nuevo',
  'src/app/(app)/proyectos/[id]/page.tsx',
  'src/app/(app)/proyectos/[id]/ajustes',
  'src/app/(app)/cuenta',
  'src/components/projects',
]

function walk(target: string): string[] {
  const absolute = path.join(ROOT, target)
  const info = statSync(absolute)
  if (info.isFile()) return [absolute]

  const found: string[] = []
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const full = path.join(absolute, entry.name)
    if (entry.isDirectory()) found.push(...walk(path.relative(ROOT, full)))
    else if (/\.(ts|tsx)$/.test(entry.name)) found.push(full)
  }
  return found
}

const ARCHIVOS = RUTAS_PROPIAS.flatMap(walk)

/** Literales de texto que parecen prosa: tienen un espacio adentro. */
const RE_STRING_LITERAL = /'([^'\\]|\\.)*'|"([^"\\]|\\.)*"|`([^`\\$]|\\.)*`/g

function textosDe(contenido: string): string[] {
  const encontrados = contenido.match(RE_STRING_LITERAL) ?? []
  return encontrados
    .map((raw) => raw.slice(1, -1))
    .filter((texto) => texto.includes(' ') && texto.length > 3)
}

describe('auth + onboarding + proyectos: cero jerga, cero "créditos"', () => {
  it('recorrió al menos un archivo (si esto falla, la lista de rutas está mal)', () => {
    expect(ARCHIVOS.length).toBeGreaterThan(10)
  })

  /**
   * Única excepción, y por qué: usamos `COSTO.sinCreditos` de
   * `src/content/copy.ts` (copy normativo, escrito por el orquestador), cuyo
   * VALOR dice literalmente "Sin créditos. Precio en dólares…" — la frase
   * existe para DESMENTIR que cobremos en créditos, que es justo la regla
   * que este test protege. El identificador `sinCreditos` (sin tilde, es un
   * nombre de propiedad) es lo único que aparece en nuestro código fuente;
   * el texto real vive en copy.ts, que no es nuestro y no se recorre acá.
   * Cualquier otra aparición de la palabra rompe el test igual.
   */
  it('la palabra "crédito" no aparece en ningún archivo del frente (salvo el identificador sinCreditos)', () => {
    const hallazgos: string[] = []
    for (const archivo of ARCHIVOS) {
      const contenido = readFileSync(archivo, 'utf8').replace(/\bsinCreditos\b/g, '')
      if (/cr[ée]dito/i.test(contenido)) {
        hallazgos.push(path.relative(ROOT, archivo))
      }
    }
    expect(hallazgos, `archivos con "crédito":\n${hallazgos.join('\n')}`).toEqual([])
  })

  it('los textos que parecen prosa no tienen jerga técnica', () => {
    const problemas: string[] = []
    for (const archivo of ARCHIVOS) {
      const contenido = readFileSync(archivo, 'utf8')
      for (const texto of textosDe(contenido)) {
        const jerga = detectarJerga(texto)
        if (jerga.length > 0) {
          problemas.push(`${path.relative(ROOT, archivo)} → "${texto}" (${jerga.join(', ')})`)
        }
      }
    }
    expect(problemas, `textos con jerga:\n${problemas.join('\n')}`).toEqual([])
  })
})
