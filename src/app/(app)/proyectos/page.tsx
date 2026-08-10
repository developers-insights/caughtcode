import type { Metadata } from 'next'
import Link from 'next/link'
import { Plus } from 'lucide-react'
import { PageHeader } from '@/components/shell'
import { buttonStyles, EmptyState } from '@/components/ui'
import { ESTADOS } from '@/content/copy'
import { T } from '@/lib/db/tablas'
import { ProjectCard } from '@/components/projects/project-card'
import { DEMO_PROJECTS, type ProjectSummary } from '@/components/projects/fixtures'
import { requireSession } from '../current-org'
import { MODO_DEMO, MODO_DEMO_VACIO } from '../demo'

export const metadata: Metadata = { title: 'Proyectos' }
export const dynamic = 'force-dynamic'

async function loadProjects(): Promise<ProjectSummary[]> {
  if (MODO_DEMO) {
    return MODO_DEMO_VACIO ? [] : DEMO_PROJECTS
  }

  const { supabase, org } = await requireSession()
  if (!supabase) return []

  const { data } = await supabase
    .from(T.projects)
    .select('id, name, client_name, source_type, deployed_url, stack_detected, created_at, retention_days')
    .eq('org_id', org.id)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })

  return (data ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    clientName: row.client_name,
    sourceType: row.source_type,
    deployedUrl: row.deployed_url,
    stackDetected: row.stack_detected,
    createdAt: row.created_at,
    retentionDays: row.retention_days,
  }))
}

export default async function ProyectosPage() {
  const projects = await loadProjects()

  return (
    <>
      <PageHeader
        title="Proyectos"
        description={projects.length > 0 ? 'Las apps que ya auditaste o estás por auditar.' : undefined}
        action={
          <Link href="/proyectos/nuevo" className={buttonStyles()}>
            <Plus className="size-4" strokeWidth={2} />
            Nuevo proyecto
          </Link>
        }
      />

      {projects.length === 0 ? (
        <EmptyState
          title={ESTADOS.vacioProyectos.titulo}
          description={ESTADOS.vacioProyectos.texto}
          action={
            <Link href="/proyectos/nuevo" className={buttonStyles()}>
              {ESTADOS.vacioProyectos.accion}
            </Link>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
      )}
    </>
  )
}
