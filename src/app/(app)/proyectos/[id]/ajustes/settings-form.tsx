'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Save, Trash2 } from 'lucide-react'
import {
  Button,
  Card,
  CardBody,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Input,
  Select,
  notify,
} from '@/components/ui'
import { DeleteProjectDialog } from '@/components/projects/delete-project-dialog'
import { updateProjectAction } from './actions'

/** Mismo texto que `retentionSummary()` en `src/server/ingest/retention.ts`
 *  (server-only: no se puede importar desde un componente cliente). */
function retentionSummary(days: number): string {
  return `Tu código se borra apenas termina el análisis. Si algo queda guardado para reanudar un trabajo, se elimina a los ${days} días.`
}

export interface EditableProject {
  id: string
  name: string
  clientName: string | null
  deployedUrl: string | null
  retentionDays: number
  sourceType: 'github' | 'github_public' | 'zip'
  repoUrl: string | null
}

export function ProjectSettingsForm({ project }: { project: EditableProject }) {
  const router = useRouter()
  const [name, setName] = useState(project.name)
  const [clientName, setClientName] = useState(project.clientName ?? '')
  const [deployedUrl, setDeployedUrl] = useState(project.deployedUrl ?? '')
  const [retentionDays, setRetentionDays] = useState(String(project.retentionDays))
  const [pending, startTransition] = useTransition()

  function guardar() {
    startTransition(async () => {
      const result = await updateProjectAction({
        projectId: project.id,
        name,
        clientName,
        deployedUrl,
        retentionDays: Number(retentionDays),
      })
      if (!result.ok) {
        notify.problema(result.error ?? 'No pudimos guardar los cambios.')
        return
      }
      notify.ok('Guardamos los cambios.')
    })
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle as="h2" className="text-lg">
            Datos del proyecto
          </CardTitle>
          <CardDescription>
            {project.sourceType === 'github' && project.repoUrl
              ? `Conectado a ${project.repoUrl.replace('https://github.com/', '')}`
              : 'Subido como archivo .zip'}
          </CardDescription>
        </CardHeader>
        <CardBody className="space-y-5">
          <Input label="Nombre del proyecto" value={name} onChange={(e) => setName(e.target.value)} required />
          <Input
            label="Nombre del cliente"
            value={clientName}
            onChange={(e) => setClientName(e.target.value)}
            optional
            hint="Si auditás apps de terceros, para saber de quién es esta."
          />
          <Input
            label="Dirección publicada"
            type="url"
            value={deployedUrl}
            onChange={(e) => setDeployedUrl(e.target.value)}
            placeholder="https://mi-app.vercel.app"
            optional
          />
          <Select
            label="Cuánto guardamos tu código"
            value={retentionDays}
            onChange={(e) => setRetentionDays(e.target.value)}
            hint={retentionSummary(Number(retentionDays))}
          >
            <option value="7">7 días</option>
            <option value="30">30 días</option>
            <option value="90">90 días</option>
          </Select>
        </CardBody>
        <CardFooter className="justify-end">
          <Button
            icon={<Save strokeWidth={1.9} />}
            loading={pending}
            loadingLabel="Guardando…"
            onClick={guardar}
          >
            Guardar cambios
          </Button>
        </CardFooter>
      </Card>

      <Card tone="expuesto" emphasis="marked">
        <CardHeader>
          <CardTitle as="h2" className="text-lg">
            Zona de peligro
          </CardTitle>
          <CardDescription>
            Borrar el proyecto borra de verdad el código, los hallazgos, los videos y las
            grabaciones. No se puede deshacer.
          </CardDescription>
        </CardHeader>
        <CardFooter className="justify-end">
          <DeleteProjectDialog
            projectId={project.id}
            projectName={project.name}
            onDeleted={() => router.push('/proyectos')}
            trigger={(open) => (
              <Button variant="danger" icon={<Trash2 strokeWidth={1.9} />} onClick={open}>
                Borrar este proyecto
              </Button>
            )}
          />
        </CardFooter>
      </Card>
    </div>
  )
}
