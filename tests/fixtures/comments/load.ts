/**
 * Cargador de fixtures para el motor de comentarios.
 *
 * Los archivos se guardan con el sufijo `.fixture` (por ejemplo
 * `client-page.tsx.fixture`) a propósito: así quedan fuera del `include` de
 * `tsconfig.json` y de ESLint. Son datos de prueba que imitan el repo de un
 * usuario — contienen `@ts-ignore` sobre código sano, variables sin usar y
 * anotaciones raras — y no tienen por qué compilar dentro de este proyecto.
 * El nombre real (`client-page.tsx`) se recupera al materializarlos.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Nombre lógico del fixture → ruta que ocupa dentro del repo simulado. */
export const FIXTURE_PATHS: Record<string, string> = {
  'client-page.tsx': 'src/app/buscar/page.tsx',
  'server-action.ts': 'src/app/proyectos/actions.ts',
  'legacy-helper.js': 'src/lib/legacy-helper.js',
  'banner.js': 'scripts/banner.js',
  'styles.css': 'src/styles/styles.css',
  'index.html': 'public/index.html',
  'secrets-note.ts': 'src/app/api/notas/route.ts',
  'disabled-code.ts': 'src/lib/disabled-code.ts',
  'notes.ts': 'src/lib/notes.ts',
  'tool.config.ts': 'tool.config.ts',
}

/** Contenido crudo de un fixture, por su nombre lógico (`client-page.tsx`). */
export function fixture(name: string): string {
  return readFileSync(join(HERE, `${name}.fixture`), 'utf8')
}

/** Ruta que ese fixture ocupa dentro del repo simulado. */
export function fixturePath(name: string): string {
  const p = FIXTURE_PATHS[name]
  if (!p) throw new Error(`Fixture sin ruta declarada: ${name}`)
  return p
}

/** `{ rutaRelativa: contenido }` para todos los fixtures. */
export function allFixtureFiles(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of Object.keys(FIXTURE_PATHS)) out[FIXTURE_PATHS[name]!] = fixture(name)
  return out
}

/**
 * Escribe un mapa `{ ruta: contenido }` en un directorio temporal y devuelve su
 * raíz. Sirve para probar el recorrido real de archivos con extensiones reales.
 */
export function materializeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'caughtcode-comments-'))
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content, 'utf8')
  }
  return root
}

/** Repo temporal con todos los fixtures en su ruta declarada. */
export function materializeFixtureRepo(extra: Record<string, string> = {}): string {
  return materializeRepo({ ...allFixtureFiles(), ...extra })
}
