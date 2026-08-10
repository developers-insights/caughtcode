/**
 * Proyecto Next.js (App Router) de mentira, con las trampas reales que aparecen
 * en las apps de nuestros usuarios: grupos de rutas, rutas dinámicas, un layout
 * con 'use client', una API, una carpeta privada y un archivo con la sintaxis rota.
 *
 * Se escribe a disco de verdad al correr los tests (`materializeFixture`) en vez
 * de vivir como archivos del repo, para que `tsc` y `eslint` no intenten
 * compilar el archivo roto a propósito.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

export const MINI_NEXT_FILES: Record<string, string> = {
  'package.json': JSON.stringify(
    {
      name: 'tienda-de-mate',
      private: true,
      dependencies: {
        next: '^16.0.0',
        react: '^19.0.0',
        'react-dom': '^19.0.0',
        '@supabase/supabase-js': '^2.0.0',
      },
      devDependencies: { typescript: '^5.0.0', tailwindcss: '^4.0.0' },
    },
    null,
    2,
  ),

  'next.config.ts': `import type { NextConfig } from 'next'\n\nconst config: NextConfig = { reactStrictMode: true }\nexport default config\n`,

  'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }, null, 2),

  'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",

  'src/app/layout.tsx': `import type { ReactNode } from 'react'

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es-AR">
      <body>{children}</body>
    </html>
  )
}
`,

  'src/app/page.tsx': `import { Boton } from '@/components/Boton'
import { formatearPrecio } from '@/lib/formato'

export default function Inicio() {
  return (
    <main>
      <h1>Mates artesanales</h1>
      <p>{formatearPrecio(4500)}</p>
      <Boton texto="Ver catálogo" />
    </main>
  )
}
`,

  'src/app/(marketing)/precios/page.tsx': `import { formatearPrecio } from '@/lib/formato'

export default function Precios() {
  return <section>{formatearPrecio(9900)}</section>
}
`,

  // Layout con 'use client': todo lo que cuelgue debajo hereda que corre en el navegador.
  'src/app/(app)/dashboard/layout.tsx': `'use client'

import type { ReactNode } from 'react'
import { obtenerUsuario } from '@/lib/supabase'

export default function PanelLayout({ children }: { children: ReactNode }) {
  void obtenerUsuario
  return <div className="panel">{children}</div>
}
`,

  'src/app/(app)/dashboard/page.tsx': `import { Boton } from '@/components/Boton'

export default function Panel() {
  return <Boton texto="Cerrar sesión" />
}
`,

  'src/app/(app)/dashboard/[id]/page.tsx': `export default function DetallePedido() {
  return <article>Pedido</article>
}
`,

  'src/app/api/webhook/route.ts': `import { obtenerUsuario } from '@/lib/supabase'

export async function POST(request: Request) {
  await obtenerUsuario()
  return new Response(JSON.stringify({ ok: true }), { status: 200 })
}
`,

  // Carpeta que empieza con guion bajo: Next.js NO la publica como ruta.
  'src/app/_borradores/page.tsx': `export default function Borrador() {
  return <p>no publicado</p>
}
`,

  'src/components/Boton.tsx': `export function Boton({ texto }: { texto: string }) {
  return <button type="button">{texto}</button>
}
`,

  // Tiene una expresión regular con "//" adentro: si el lector confundiera eso con
  // un comentario, se perdería el import de abajo y el export.
  'src/lib/formato.ts': `const PROTOCOLO = /^https:\\/\\//

export function formatearPrecio(centavos: number): string {
  void PROTOCOLO
  return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(centavos / 100)
}
`,

  'src/lib/supabase.ts': `import { createClient } from '@supabase/supabase-js'

export const cliente = createClient('https://ejemplo.supabase.co', 'clave-publica')

export async function obtenerUsuario() {
  const { data } = await cliente.auth.getUser()
  return data.user
}
`,

  // A propósito: le falta cerrar la llave. El motor tiene que anotarlo y seguir.
  'src/lib/roto.ts': `export function seRompe() {
  const valor = {
    a: 1,
`,

  'supabase/migrations/0001_inicial.sql': `create table public.pedidos (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null,
  total numeric not null
);

alter table public.pedidos enable row level security;
alter table public.pedidos force row level security;

create policy "pedidos_propios" on public.pedidos
  for select to authenticated
  using (cliente_id = auth.uid());

create function public.es_miembro(org uuid) returns boolean
  language sql security definer set search_path = ''
as $$ select true $$;
`,
}

/** Escribe el proyecto en una carpeta temporal nueva y devuelve su ruta. */
export async function materializeFixture(
  files: Record<string, string> = MINI_NEXT_FILES,
  prefix = 'caughtcode-fixture-',
): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), prefix))
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = path.join(root, relative)
    await mkdir(path.dirname(absolute), { recursive: true })
    await writeFile(absolute, contents, 'utf8')
  }
  return {
    root,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true })
    },
  }
}
