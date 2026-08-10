'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ExternalLink, FileArchive, GitBranch, MoreVertical, Settings, Trash2 } from 'lucide-react'
import {
  Avatar,
  Badge,
  Card,
  CardBody,
  DropdownItem,
  DropdownMenu,
  DropdownSeparator,
} from '@/components/ui'
import { relativeTime } from '@/lib/utils'
import type { ProjectSummary } from './fixtures'
import { DeleteProjectDialog } from './delete-project-dialog'
import { frameworkLabel as labelForFramework } from './stack-label'

export function ProjectCard({ project }: { project: ProjectSummary }) {
  const router = useRouter()
  const frameworkLabel = project.stackDetected ? labelForFramework(project.stackDetected.framework) : undefined

  return (
    <Card interactive className="p-0">
      <CardBody className="flex items-start gap-4 pt-5">
        <Avatar name={project.name} shape="square" size="md" className="mt-0.5 shrink-0" />

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <Link
              href={`/proyectos/${project.id}`}
              className="min-w-0 rounded-xs focus-visible:focus-ring"
            >
              <h3 className="truncate text-lg font-semibold text-ink hover:underline">
                {project.name}
              </h3>
            </Link>

            <DropdownMenu
              label={`Acciones para ${project.name}`}
              trigger={(triggerProps) => (
                <button
                  type="button"
                  {...triggerProps}
                  aria-label={`Acciones para ${project.name}`}
                  className="-mt-1 -mr-1 flex size-9 shrink-0 items-center justify-center rounded-sm text-ink-subtle transition-colors duration-150 ease-firm hover:bg-surface-hover hover:text-ink focus-visible:focus-ring"
                >
                  <MoreVertical className="size-4" strokeWidth={1.9} />
                </button>
              )}
            >
              <DropdownItem
                icon={<Settings strokeWidth={1.8} />}
                onClick={() => router.push(`/proyectos/${project.id}/ajustes`)}
              >
                Ajustes
              </DropdownItem>
              <DropdownSeparator />
              <DeleteProjectDialog
                projectId={project.id}
                projectName={project.name}
                onDeleted={() => router.refresh()}
                trigger={(open) => (
                  <DropdownItem icon={<Trash2 strokeWidth={1.8} />} destructive onClick={open}>
                    Borrar proyecto
                  </DropdownItem>
                )}
              />
            </DropdownMenu>
          </div>

          {project.clientName && (
            <p className="truncate text-sm text-ink-muted">{project.clientName}</p>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <Badge size="sm" icon={project.sourceType === 'zip' ? <FileArchive strokeWidth={1.8} /> : <GitBranch strokeWidth={1.8} />}>
              {project.sourceType === 'zip' ? 'Zip' : 'GitHub'}
            </Badge>
            {frameworkLabel && <Badge size="sm">{frameworkLabel}</Badge>}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-subtle">
            <span>{relativeTime(project.createdAt)}</span>
            {project.deployedUrl && (
              <a
                href={project.deployedUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 rounded-xs text-ink-muted underline-offset-4 hover:text-ink hover:underline focus-visible:focus-ring"
              >
                <ExternalLink className="size-3.5" strokeWidth={1.8} />
                <span className="max-w-40 truncate">{project.deployedUrl.replace(/^https?:\/\//, '')}</span>
              </a>
            )}
          </div>
        </div>
      </CardBody>
    </Card>
  )
}
