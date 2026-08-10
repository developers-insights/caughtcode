import { cn } from '@/lib/utils'
import { CopyButton } from './copy-button'

export interface CodeBlockProps {
  code: string
  /** Ruta del archivo, tal cual la ve el usuario en su editor. */
  filename?: string
  /** Número de la primera línea del fragmento dentro del archivo real. */
  startLine?: number
  /** Líneas a marcar, en numeración del archivo real (no del fragmento). */
  highlightLines?: number[]
  /** Etiqueta de lenguaje. Solo decorativa. */
  language?: string
  showLineNumbers?: boolean
  copyable?: boolean
  /** Alto máximo antes de scrollear. Por defecto no limita. */
  maxHeightClassName?: string
  className?: string
}

/**
 * Evidencia en código. No hay resaltado de sintaxis a propósito: la línea
 * que importa se marca, y lo demás queda en gris para que no compita.
 * Menos color = más claro dónde mirar.
 */
export function CodeBlock({
  code,
  filename,
  startLine = 1,
  highlightLines,
  language,
  showLineNumbers = true,
  copyable = true,
  maxHeightClassName,
  className,
}: CodeBlockProps) {
  const lines = code.replace(/\n$/, '').split('\n')
  const marked = new Set(highlightLines ?? [])
  const gutterWidth = String(startLine + lines.length - 1).length

  return (
    <figure
      className={cn(
        'overflow-hidden rounded-md border border-line bg-canvas-sunken',
        className,
      )}
    >
      {(filename || copyable) && (
        <figcaption className="flex items-center gap-3 border-b border-line bg-surface px-3 py-2">
          {filename && (
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-muted" title={filename}>
              {filename}
              {highlightLines?.length ? (
                <span className="text-ink-subtle">
                  {' '}
                  · línea {highlightLines.length > 1 ? highlightLines.join(', ') : highlightLines[0]}
                </span>
              ) : null}
            </span>
          )}
          {language && !filename && (
            <span className="flex-1 font-mono text-xs text-ink-subtle">{language}</span>
          )}
          {copyable && <CopyButton value={code} size="sm" variant="ghost" iconOnly />}
        </figcaption>
      )}

      <div className={cn('overflow-x-auto', maxHeightClassName && cn('overflow-y-auto', maxHeightClassName))}>
        <pre className="min-w-max py-2 font-mono text-sm leading-[1.65]">
          <code>
            {lines.map((line, i) => {
              const n = startLine + i
              const isMarked = marked.has(n)
              return (
                <span
                  key={n}
                  data-line={n}
                  data-marked={isMarked || undefined}
                  className={cn(
                    'flex px-3',
                    isMarked &&
                      'bg-expuesto-soft shadow-[inset_3px_0_0_0_var(--cc-expuesto-solid)]',
                  )}
                >
                  {showLineNumbers && (
                    <span
                      aria-hidden="true"
                      className={cn(
                        'mr-4 shrink-0 text-right tabular select-none',
                        isMarked ? 'text-expuesto-text' : 'text-ink-subtle',
                      )}
                      style={{ width: `${gutterWidth}ch` }}
                    >
                      {n}
                    </span>
                  )}
                  <span className={cn(isMarked ? 'text-ink' : 'text-ink-muted')}>
                    {line === '' ? ' ' : line}
                  </span>
                </span>
              )
            })}
          </code>
        </pre>
      </div>
    </figure>
  )
}
