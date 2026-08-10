/**
 * Tipos del flujo de limpieza, del lado de la pantalla.
 *
 * El motor vive en `src/server/comments` y arrastra Node y el compilador de
 * TypeScript: no puede entrar al navegador. Por eso la pantalla habla con él
 * solamente a través de estos objetos, que son texto y números.
 */

import type { CommentCleanPlan } from '@/lib/types/domain'
import { COMENTARIOS } from '@/content/copy'

export type CleanMode = 'safe' | 'aggressive'

export const MODOS: Array<{ id: CleanMode; titulo: string; texto: string }> = [
  { id: 'safe', ...COMENTARIOS.modos.safe },
  { id: 'aggressive', ...COMENTARIOS.modos.aggressive },
]

export type CleanFileDiff = CommentCleanPlan['files'][number]

export interface CleanPlanView {
  mode: CleanMode
  files: CleanFileDiff[]
  totalRemoved: number
  totalKept: number
  /** Archivos que quedaron afuera y por qué. Nunca se ocultan. */
  skipped: Array<{ file: string; reason: string }>
  /** El archivo de cambios, listo para descargar y revisar. */
  patch: string
}

/** Nombre del archivo de cambios que se descarga. */
export function nombreDelParche(mode: CleanMode): string {
  return `caughtcode-comentarios-${mode === 'safe' ? 'segura' : 'a-fondo'}.patch`
}

/**
 * Lo que devuelve una acción del servidor.
 *
 * El error viaja como texto ya escrito para el usuario: la pantalla no tiene
 * que adivinar qué mostrar, y no hay forma de que se escape un mensaje del
 * sistema sin traducir.
 */
export type Resultado<T> = { ok: true; data: T } | { ok: false; error: string }
