import { redirect } from 'next/navigation'
import { requireSession } from './(app)/current-org'

/**
 * `/` no es una pantalla propia todavía: no hay landing pública. El frente de
 * Landing la reemplaza por la portada real cuando exista.
 *
 * Hasta entonces, la raíz decide sola a dónde ir: `requireSession()` ya manda
 * a `/entrar` si no hay sesión, así que solo hace falta cubrir el caso
 * contrario y mandar a alguien logueado directo a sus proyectos.
 */
export default async function Home() {
  await requireSession()
  redirect('/proyectos')
}
