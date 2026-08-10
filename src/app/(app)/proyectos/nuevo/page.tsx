import type { Metadata } from 'next'
import { PageHeader } from '@/components/shell'
import { ONBOARDING } from '@/content/copy'
import { githubStatus } from '@/server/ingest/github'
import { NewProjectWizard } from '@/components/projects/new-project-wizard'

export const metadata: Metadata = { title: 'Nuevo proyecto' }

/** El upload y el análisis previo corren en el mismo pedido: dale margen. */
export const maxDuration = 120

export default function NuevoProyectoPage() {
  const status = githubStatus()

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Proyectos', href: '/proyectos' }, { label: 'Nuevo' }]}
        title={ONBOARDING.bienvenida.titulo}
        description={ONBOARDING.bienvenida.texto}
      />

      <NewProjectWizard
        githubStatus={{ ready: status.ready, message: status.message, installUrl: status.installUrl }}
      />
    </>
  )
}
