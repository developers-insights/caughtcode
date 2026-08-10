import type { Metadata } from 'next'
import Link from 'next/link'
import { ESTADOS, COMENTARIOS } from '@/content/copy'
import { ErrorState, buttonStyles } from '@/components/ui'
import { CommentsScreen, type CommentsViewModel } from '@/components/comments'
import { escanearComentarios, prepararLimpieza } from './actions'
import { resolverProyecto } from './repo'
import { escanearProyecto } from './view-model'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: COMENTARIOS.titulo,
  description: COMENTARIOS.bajada,
}

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function ComentariosPage({ params }: PageProps) {
  const { id } = await params
  const acceso = await resolverProyecto(id)

  if (acceso.estado !== 'ok') {
    return (
      <ErrorState
        kind="forbidden"
        title={ESTADOS.sinPermisos.titulo}
        description={ESTADOS.sinPermisos.texto}
        action={
          <Link href="/proyectos" className={buttonStyles()}>
            {ESTADOS.sinPermisos.accion}
          </Link>
        }
      />
    )
  }

  // La primera revisión corre acá para que la pantalla llegue con algo útil ya
  // puesto, en vez de con un botón y una espera.
  let modelo: CommentsViewModel | null = null
  let error: string | null = null

  if (acceso.repoPath) {
    try {
      modelo = await escanearProyecto(acceso.repoPath)
    } catch (e) {
      error = e instanceof Error ? e.message : 'Error desconocido'
    }
  }

  // El armazón (barra lateral, barra superior, navegación de celular) lo pone
  // el layout del grupo `(app)`. Acá va solo el contenido.
  return (
    <CommentsScreen
      proyectoId={id}
      proyectoNombre={acceso.nombre}
      modelo={modelo}
      error={error}
      onEscanear={acceso.repoPath ? escanearComentarios.bind(null, id) : undefined}
      onGenerarPlan={acceso.repoPath ? prepararLimpieza.bind(null, id) : undefined}
    />
  )
}
