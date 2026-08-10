import type { Metadata } from 'next'
import Link from 'next/link'
import { PageHeader } from '@/components/shell'
import { buttonStyles, ErrorState } from '@/components/ui'
import { ESTADOS } from '@/content/copy'
import { T } from '@/lib/db/tablas'
import { DEMO_PROJECTS } from '@/components/projects/fixtures'
import { requireSession } from '../../../current-org'
import { MODO_DEMO } from '../../../demo'
import { ProjectSettingsForm, type EditableProject } from './settings-form'

export const metadata: Metadata = { title: 'Ajustes del proyecto' }
export const dynamic = 'force-dynamic'

interface Props {
  params: Promise<{ id: string }>
}

async function loadProject(id: string): Promise<EditableProject | null> {
  if (MODO_DEMO) {
    const demo = DEMO_PROJECTS.find((p) => p.id === id)
    if (!demo) return null
    return {
      id: demo.id,
      name: demo.name,
      clientName: demo.clientName,
      deployedUrl: demo.deployedUrl,
      retentionDays: demo.retentionDays,
      sourceType: demo.sourceType,
      repoUrl: demo.sourceType === 'github' ? 'https://github.com/ejemplo/crm-interno' : null,
    }
  }

  const { supabase } = await requireSession()
  if (!supabase) return null

  const { data } = await supabase
    .from(T.projects)
    .select('id, name, client_name, deployed_url, retention_days, source_type, repo_url, deleted_at')
    .eq('id', id)
    .maybeSingle()

  if (!data || data.deleted_at) return null

  return {
    id: data.id,
    name: data.name,
    clientName: data.client_name,
    deployedUrl: data.deployed_url,
    retentionDays: data.retention_days,
    sourceType: data.source_type,
    repoUrl: data.repo_url,
  }
}

export default async function AjustesPage({ params }: Props) {
  const { id } = await params
  const project = await loadProject(id)

  if (!project) {
    return (
      <ErrorState
        kind="forbidden"
        title={ESTADOS.sinPermisos.titulo}
        description={ESTADOS.sinPermisos.texto}
        action={
          <Link href="/proyectos" className={buttonStyles({ variant: 'secondary' })}>
            {ESTADOS.sinPermisos.accion}
          </Link>
        }
      />
    )
  }

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Proyectos', href: '/proyectos' }, { label: project.name }]}
        title="Ajustes"
        description="Cambiá los datos del proyecto o borralo del todo."
      />
      <ProjectSettingsForm project={project} />
    </>
  )
}
