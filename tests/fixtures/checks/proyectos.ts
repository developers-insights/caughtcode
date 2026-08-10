/**
 * Proyectos de mentira, escritos en disco por test.
 *
 * Cada uno es un objeto `{ ruta: contenido }`. `crearProyecto()` lo materializa
 * en una carpeta temporal y devuelve la ruta; el test la borra al terminar.
 *
 * Hay dos familias a propósito:
 *   - los que **disparan** un chequeo
 *   - los que **no** lo disparan aunque se le parezcan (un `.env.example`, una
 *     confirmación presente, una llave pública legítima)
 *
 * La segunda familia es la que importa: probar que algo se detecta es fácil,
 * probar que no se inventa nada es lo que sostiene la credibilidad del producto.
 */

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

export type ArbolDeArchivos = Record<string, string>

export async function crearProyecto(arbol: ArbolDeArchivos): Promise<string> {
  const raiz = await mkdtemp(path.join(tmpdir(), 'caughtcode-checks-'))
  for (const [relativa, contenido] of Object.entries(arbol)) {
    const destino = path.join(raiz, relativa)
    await mkdir(path.dirname(destino), { recursive: true })
    await writeFile(destino, contenido, 'utf8')
  }
  return raiz
}

export async function borrarProyecto(raiz: string): Promise<void> {
  await rm(raiz, { recursive: true, force: true })
}

/* ── Claves de mentira ────────────────────────────────────────────────────
   Ninguna es real. Los JWT se arman con `jwtFalso()` para que el chequeo pueda
   leer el `role` de adentro, que es lo que decide si es la llave maestra o la
   pública. Un JWT inventado a mano no serviría: no decodifica. */

export function jwtFalso(claims: Record<string, unknown>): string {
  const cabecera = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const cuerpo = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${cabecera}.${cuerpo}.firmadementiraparalostests00000`
}

export const LLAVE_MAESTRA = jwtFalso({ role: 'service_role', iss: 'supabase', ref: 'abcdefgh' })
export const LLAVE_PUBLICA = jwtFalso({ role: 'anon', iss: 'supabase', ref: 'abcdefgh' })
export const CLAVE_STRIPE = 'sk_live_51QwErTyUiOpAsDfGhJkLzXcVbNm123456'

/* ── 1. Un `.env` versionado con valores reales ───────────────────────── */

export const PROYECTO_ENV_VERSIONADO: ArbolDeArchivos = {
  '.env': [
    '# claves de produccion',
    'DATABASE_URL=postgresql://admin:UnaClaveLargaDeVerdad9@db.abcdefgh.supabase.co:5432/postgres',
    `STRIPE_SECRET_KEY=${CLAVE_STRIPE}`,
    `SUPABASE_SERVICE_ROLE_KEY=${LLAVE_MAESTRA}`,
    '',
  ].join('\n'),
  '.gitignore': 'node_modules\n.next\n',
  'app/page.tsx': 'export default function Home() {\n  return <h1>Hola</h1>\n}\n',
  'app/layout.tsx':
    'export default function Layout({ children }: { children: React.ReactNode }) {\n  return <html><body>{children}</body></html>\n}\n',
}

/** El mismo proyecto pero bien hecho: solo ejemplo, y el `.env` ignorado. */
export const PROYECTO_ENV_LIMPIO: ArbolDeArchivos = {
  '.env.example': [
    'DATABASE_URL=postgresql://usuario:tu_clave_aca@localhost:5432/postgres',
    'STRIPE_SECRET_KEY=sk_live_reemplazame',
    'SUPABASE_SERVICE_ROLE_KEY=tu_clave_aca',
    '',
  ].join('\n'),
  '.gitignore': 'node_modules\n.next\n.env\n.env*.local\n',
  'app/page.tsx': 'export default function Home() {\n  return <h1>Hola</h1>\n}\n',
  'app/layout.tsx':
    'export default function Layout({ children }: { children: React.ReactNode }) {\n  return <html><body>{children}</body></html>\n}\n',
}

/* ── 2. La llave maestra en un componente de navegador ────────────────── */

export const PROYECTO_SERVICE_ROLE_EN_CLIENTE: ArbolDeArchivos = {
  'app/panel/tabla.tsx': [
    "'use client'",
    "import { createClient } from '@supabase/supabase-js'",
    '',
    'const supabase = createClient(',
    "  'https://abcdefgh.supabase.co',",
    `  '${LLAVE_MAESTRA}',`,
    ')',
    '',
    'export function Tabla() {',
    '  return <div>datos</div>',
    '}',
    '',
  ].join('\n'),
  'app/layout.tsx':
    'export default function Layout({ children }: { children: React.ReactNode }) {\n  return <html><body>{children}</body></html>\n}\n',
}

/** Bien hecho: la llave pública en el cliente, la maestra solo en el servidor. */
export const PROYECTO_CLIENTE_CORRECTO: ArbolDeArchivos = {
  'app/panel/tabla.tsx': [
    "'use client'",
    "import { createClient } from '@supabase/supabase-js'",
    '',
    'const supabase = createClient(',
    '  process.env.NEXT_PUBLIC_SUPABASE_URL!,',
    '  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,',
    ')',
    '',
    'export function Tabla() {',
    '  return <div>datos</div>',
    '}',
    '',
  ].join('\n'),
  '.env.local': [
    'NEXT_PUBLIC_SUPABASE_URL=https://abcdefgh.supabase.co',
    `NEXT_PUBLIC_SUPABASE_ANON_KEY=${LLAVE_PUBLICA}`,
    '',
  ].join('\n'),
  '.gitignore': '.env\n.env*.local\n',
  'app/layout.tsx':
    'export default function Layout({ children }: { children: React.ReactNode }) {\n  return <html><body>{children}</body></html>\n}\n',
}

/* ── 3. Un `catch` vacío ──────────────────────────────────────────────── */

export const PROYECTO_CATCH_VACIO: ArbolDeArchivos = {
  'app/guardar/acciones.ts': [
    "'use server'",
    '',
    'export async function guardar(datos: FormData) {',
    '  try {',
    '    await fetch(process.env.API_URL!, { method: "POST", body: datos })',
    '  } catch {}',
    '}',
    '',
    'export async function borrar(id: string) {',
    '  try {',
    '    await fetch(`/api/items/${id}`, { method: "DELETE" })',
    '  } catch (error) {',
    '    console.log(error)',
    '  }',
    '}',
    '',
  ].join('\n'),
  'app/layout.tsx':
    'export default function Layout({ children }: { children: React.ReactNode }) {\n  return <html><body>{children}</body></html>\n}\n',
}

/** El mismo código, manejando el error como corresponde. */
export const PROYECTO_ERROR_MANEJADO: ArbolDeArchivos = {
  'app/guardar/acciones.ts': [
    "'use server'",
    '',
    'export async function guardar(datos: FormData) {',
    '  try {',
    '    await fetch(process.env.API_URL!, { method: "POST", body: datos })',
    '  } catch (error) {',
    '    reportar(error)',
    '    return { ok: false, mensaje: "No pudimos guardar los cambios. Probá de nuevo." }',
    '  }',
    '  return { ok: true }',
    '}',
    '',
    'function reportar(error: unknown) {',
    '  void error',
    '}',
    '',
  ].join('\n'),
  'app/guardar/error.tsx':
    'export default function Error() {\n  return <p>Algo falló. Probá de nuevo.</p>\n}\n',
  'app/layout.tsx':
    'export default function Layout({ children }: { children: React.ReactNode }) {\n  return <html><body>{children}</body></html>\n}\n',
}

/* ── 4. Un botón que borra sin confirmar ──────────────────────────────── */

export const PROYECTO_BORRAR_SIN_CONFIRMAR: ArbolDeArchivos = {
  'app/proyectos/lista.tsx': [
    "'use client'",
    '',
    'export function Lista({ proyectos }: { proyectos: Array<{ id: string; nombre: string }> }) {',
    '  async function handleDeleteProject(id: string) {',
    '    await fetch(`/api/proyectos/${id}`, { method: "DELETE" })',
    '  }',
    '',
    '  return (',
    '    <ul>',
    '      {proyectos.map((p) => (',
    '        <li key={p.id}>',
    '          {p.nombre}',
    '          <button onClick={() => handleDeleteProject(p.id)}>Eliminar</button>',
    '        </li>',
    '      ))}',
    '    </ul>',
    '  )',
    '}',
    '',
  ].join('\n'),
  'app/layout.tsx':
    'export default function Layout({ children }: { children: React.ReactNode }) {\n  return <html><body>{children}</body></html>\n}\n',
}

/** El mismo botón, con confirmación y con estado vacío. */
export const PROYECTO_BORRAR_CON_CONFIRMACION: ArbolDeArchivos = {
  'app/proyectos/lista.tsx': [
    "'use client'",
    '',
    'export function Lista({ proyectos }: { proyectos: Array<{ id: string; nombre: string }> }) {',
    '  async function handleDeleteProject(id: string) {',
    '    await fetch(`/api/proyectos/${id}`, { method: "DELETE" })',
    '  }',
    '',
    '  if (proyectos.length === 0) {',
    '    return <p>Todavía no creaste ningún proyecto.</p>',
    '  }',
    '',
    '  return (',
    '    <ul>',
    '      {proyectos.map((p) => (',
    '        <li key={p.id}>',
    '          {p.nombre}',
    '          <AlertDialog onConfirm={() => handleDeleteProject(p.id)}>',
    '            <button>Eliminar</button>',
    '          </AlertDialog>',
    '        </li>',
    '      ))}',
    '    </ul>',
    '  )',
    '}',
    '',
    'declare function AlertDialog(props: { onConfirm: () => void; children: React.ReactNode }): React.ReactElement',
    '',
  ].join('\n'),
  'app/layout.tsx':
    'export default function Layout({ children }: { children: React.ReactNode }) {\n  return <html><body>{children}</body></html>\n}\n',
  'app/not-found.tsx':
    'export default function NoEncontrado() {\n  return <p>Esa dirección no existe.</p>\n}\n',
}

/* ── 5. Un proyecto sano de punta a punta ─────────────────────────────── */

/** No debería disparar ningún chequeo. Es la vara del "no inventes nada". */
export const PROYECTO_SANO: ArbolDeArchivos = {
  ...PROYECTO_CLIENTE_CORRECTO,
  ...PROYECTO_ERROR_MANEJADO,
  ...PROYECTO_BORRAR_CON_CONFIRMACION,
  'app/layout.tsx': [
    'export default function Layout({ children }: { children: React.ReactNode }) {',
    '  return (',
    '    <html>',
    '      <body>',
    '        {children}',
    '        <footer>',
    '          <a href="/privacidad">Política de privacidad</a>',
    '          <a href="/terminos">Términos y condiciones</a>',
    '          <a href="mailto:hola@miapp.com">Escribinos</a>',
    '        </footer>',
    '      </body>',
    '    </html>',
    '  )',
    '}',
    '',
  ].join('\n'),
  'app/privacidad/page.tsx':
    'export default function Privacidad() {\n  return <h1>Política de privacidad</h1>\n}\n',
  'app/terminos/page.tsx':
    'export default function Terminos() {\n  return <h1>Términos y condiciones</h1>\n}\n',
  'app/not-found.tsx':
    'export default function NoEncontrado() {\n  return <p>Esa dirección no existe.</p>\n}\n',
}
