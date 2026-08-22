'use client'

import { useId, useRef, useState, type DragEvent } from 'react'
import { FileArchive, UploadCloud } from 'lucide-react'
import { cn } from '@/lib/utils'

/** Mismo tope que `INGEST_LIMITS.maxArchiveBytes` en `src/server/ingest/filters.ts`.
 *  Server-only: no se puede importar acá, así que el número vive duplicado
 *  a propósito, solo para el aviso inmediato — el servidor es quien decide de verdad. */
const MAX_ARCHIVE_MB = 200

export interface SourceDropZoneProps {
  onFile: (file: File) => void
  disabled?: boolean
  error?: string | null
}

/**
 * Arrastrar y soltar de verdad, con alternativa por teclado (el input de
 * archivo escondido). Valida solo lo obvio en el cliente — el resto lo
 * decide el servidor y devuelve un mensaje en español, no un código.
 */
export function SourceDropZone({ onFile, disabled, error }: SourceDropZoneProps) {
  const [dragging, setDragging] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const id = useId()

  function handleFile(file: File | undefined) {
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.zip')) {
      setLocalError('Ese archivo no es un .zip. Comprimí la carpeta de tu proyecto y subí eso.')
      return
    }
    if (file.size > MAX_ARCHIVE_MB * 1024 * 1024) {
      setLocalError(
        `El archivo pesa más de ${MAX_ARCHIVE_MB} MB. Subí solo la carpeta de tu app, sin dependencias ni compilados.`,
      )
      return
    }
    setLocalError(null)
    onFile(file)
  }

  function onDrop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault()
    setDragging(false)
    if (disabled) return
    handleFile(event.dataTransfer.files[0])
  }

  const mensaje = error ?? localError

  return (
    <div className="space-y-2">
      {/*
        Un `<button>` de verdad y no un `<div role="button">`: el teclado, el
        foco y el estado deshabilitado los maneja el navegador, así que se van
        el `tabIndex` y el `onKeyDown` a mano. El `<input type="file">` queda
        afuera como hermano — adentro era HTML inválido (un control
        interactivo no puede vivir dentro de un botón) y algunos lectores de
        pantalla lo anunciaban dos veces.
      */}
      <button
        type="button"
        disabled={disabled}
        aria-describedby={mensaje ? `${id}-error` : undefined}
        onClick={() => !disabled && inputRef.current?.click()}
        onDragOver={(event) => {
          event.preventDefault()
          if (!disabled) setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          'flex w-full cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed px-6 py-10 text-center',
          'transition-colors duration-150 ease-firm focus-visible:focus-ring',
          disabled && 'pointer-events-none cursor-not-allowed opacity-60',
          dragging ? 'border-ink bg-canvas-sunken' : 'border-line-strong hover:border-ink-subtle',
          mensaje && 'border-expuesto-border',
        )}
      >
        <span
          aria-hidden="true"
          className="flex size-12 items-center justify-center rounded-full bg-canvas-sunken text-ink-subtle"
        >
          {dragging ? <FileArchive className="size-5" strokeWidth={1.7} /> : <UploadCloud className="size-5" strokeWidth={1.7} />}
        </span>
        <div>
          <p className="text-base font-medium text-ink">Arrastrá tu .zip acá</p>
          <p className="mt-1 text-sm text-ink-muted">o hacé clic para elegirlo</p>
        </div>
      </button>

      <input
        ref={inputRef}
        type="file"
        accept=".zip,application/zip"
        className="sr-only"
        disabled={disabled}
        onChange={(event) => handleFile(event.target.files?.[0])}
      />

      {mensaje && (
        <p id={`${id}-error`} role="alert" className="text-sm text-expuesto-text">
          {mensaje}
        </p>
      )}
    </div>
  )
}
