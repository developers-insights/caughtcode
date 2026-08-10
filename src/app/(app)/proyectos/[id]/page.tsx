import { redirect } from 'next/navigation'

/**
 * `/proyectos/[id]` no es una pantalla propia: el destino natural al abrir
 * un proyecto son sus hallazgos (frente de Hallazgos).
 */
export default async function ProjectIndexPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  redirect(`/proyectos/${id}/hallazgos`)
}
