'use client'

import { useState, useTransition } from 'react'
import { Save } from 'lucide-react'
import { Button, Input, notify } from '@/components/ui'
import { updateProfileAction } from './actions'

export function ProfileForm({ name: initialName }: { name: string }) {
  const [name, setName] = useState(initialName)
  const [pending, startTransition] = useTransition()

  function guardar() {
    startTransition(async () => {
      const result = await updateProfileAction(name)
      if (!result.ok) {
        notify.problema(result.error ?? 'No pudimos guardar el cambio.')
        return
      }
      notify.ok('Guardamos tu nombre.')
    })
  }

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
      <Input
        label="Cómo te llamás"
        value={name}
        onChange={(e) => setName(e.target.value)}
        wrapperClassName="flex-1"
      />
      <Button icon={<Save strokeWidth={1.9} />} loading={pending} loadingLabel="Guardando…" onClick={guardar}>
        Guardar
      </Button>
    </div>
  )
}
