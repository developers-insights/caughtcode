import type { Metadata } from 'next'
import { PageHeader } from '@/components/shell'
import { Callout } from '@/components/ui'
import { ONBOARDING } from '@/content/copy'
import { encodeInstallState, githubStatus } from '@/server/ingest/github'
import { NewProjectWizard } from '@/components/projects/new-project-wizard'

import { requireSession } from '../../current-org'

export const metadata: Metadata = { title: 'Nuevo proyecto' }

/** El upload y el análisis previo corren en el mismo pedido: dale margen. */
export const maxDuration = 120

/** Tono visual de cada resultado de la vuelta de GitHub. */
const TONO = { ok: 'verificado', aviso: 'incompleto', error: 'expuesto' } as const

type ResultadoGithub = keyof typeof ONBOARDING.vueltaDeGithub

function esResultadoGithub(valor: string | undefined): valor is ResultadoGithub {
  return typeof valor === 'string' && valor in ONBOARDING.vueltaDeGithub
}

export default async function NuevoProyectoPage({
  searchParams,
}: {
  searchParams: Promise<{ github?: string }>
}) {
  // Volver de GitHub sin que la pantalla diga nada deja al usuario sin saber si
  // la conexión salió bien. El resultado llega en la query desde
  // `/api/github/setup`.
  const { github } = await searchParams
  const vuelta = esResultadoGithub(github) ? ONBOARDING.vueltaDeGithub[github] : null

  return <Pantalla vuelta={vuelta} />
}

async function Pantalla({
  vuelta,
}: {
  vuelta: (typeof ONBOARDING.vueltaDeGithub)[ResultadoGithub] | null
}) {
  // El enlace de instalación lleva un testigo firmado con la organización que lo
  // abrió. GitHub lo devuelve intacto en la vuelta (`/api/github/setup`) y ahí se
  // usa para descartar el caso de alguien completando la instalación que empezó
  // otra persona. No autoriza nada por sí solo: quien manda es la sesión.
  const { org } = await requireSession()
  const status = githubStatus({ state: encodeInstallState(org.id) })

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Proyectos', href: '/proyectos' }, { label: 'Nuevo' }]}
        title={ONBOARDING.bienvenida.titulo}
        description={ONBOARDING.bienvenida.texto}
      />

      {vuelta && (
        <Callout tone={TONO[vuelta.tono]} className="mb-6">
          {vuelta.texto}
        </Callout>
      )}

      <NewProjectWizard
        githubStatus={{ ready: status.ready, message: status.message, installUrl: status.installUrl }}
      />
    </>
  )
}
