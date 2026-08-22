'use client'

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import {
  Captions,
  CaptionsOff,
  Expand,
  Pause,
  Play,
  Shrink,
  Volume2,
  VolumeX,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Bezel, Callout, Spinner } from '@/components/ui'
import { VIDEO } from './copy'
import { construirVtt, cueActivo, cuesDelGuion, reloj, type Cue, type FindingVideo } from './view'

export interface VideoPlayerProps {
  video: FindingVideo | null | undefined
  /** Texto alternativo del video: de qué hallazgo es. */
  titulo: string
  /** Ref compartida para que la evidencia pueda saltar a un momento. */
  videoRef?: RefObject<HTMLVideoElement | null>
  /** Momento actual, para que la transcripción marque la línea que suena. */
  onTiempo?: (seconds: number) => void
  className?: string
}

/**
 * El reproductor.
 *
 * Es lo primero y lo más grande de la pantalla: la demostración *es* el
 * producto, no un adjunto del informe. Por eso va en doble bisel — se tiene
 * que leer como una pieza, no como una imagen pegada al fondo.
 *
 * Los subtítulos vienen prendidos. Mucha gente mira sin sonido, y el que mira
 * sin sonido tiene que entender igual qué pasó.
 */
export function VideoPlayer({ video, titulo, videoRef, onTiempo, className }: VideoPlayerProps) {
  const propio = useRef<HTMLVideoElement | null>(null)
  const ref = videoRef ?? propio
  const contenedor = useRef<HTMLDivElement | null>(null)

  const [reproduciendo, setReproduciendo] = useState(false)
  const [tiempo, setTiempo] = useState(0)
  const [duracion, setDuracion] = useState(video?.durationSeconds ?? 0)
  const [silenciado, setSilenciado] = useState(false)
  const [subtitulos, setSubtitulos] = useState(true)
  const [completa, setCompleta] = useState(false)
  const [roto, setRoto] = useState(false)

  const cues = useMemo(() => cuesDelGuion(video?.script), [video?.script])
  const cue: Cue | null = subtitulos ? cueActivo(cues, tiempo) : null

  /* ── Pista de subtítulos ─────────────────────────────────────────────── */

  /**
   * Los subtítulos existen dos veces, a propósito y sin duplicarse en pantalla:
   *
   *  1. Como pista `<track>` de verdad, armada acá mismo con el guion que ya
   *     viene en la fila del video. Es la que hace que el navegador, el lector
   *     de pantalla y el reproductor nativo de iOS sepan que este video tiene
   *     subtítulos. Sin ella, para todo lo que no sea nuestra capa de React,
   *     este video no tenía ninguno.
   *  2. Dibujados por nosotros abajo, para que se lean igual en tema claro y
   *     oscuro. Por eso la pista va en modo `hidden` y no `showing`: activa y
   *     anunciable, pero sin que el navegador la pinte encima de la nuestra.
   *
   * El `.vtt` que arma el servidor (`src/server/video/subtitles.ts`) es más
   * fino —corta por frase, no por escena— pero hoy se escribe en el directorio
   * de trabajo del render y no se sube a ningún lado: no hay URL que apuntar.
   *
   * Va como `data:` y no como `blob:` para que la etiqueta salga idéntica en el
   * servidor y en el cliente: un blob solo existe después de hidratar, así que
   * el `<track>` nacería sin `src` y habría que parcharlo en un render extra.
   */
  const pista = useMemo(
    () => `data:text/vtt;charset=utf-8,${encodeURIComponent(construirVtt(cues))}`,
    [cues],
  )

  // `video?.url` está en la lista porque es lo que decide si el `<video>` llegó
  // a montarse: sin él, un clip que termina de renderizarse con el mismo guion
  // que ya teníamos dejaba la pista en `disabled` para siempre.
  useEffect(() => {
    const track = ref.current?.textTracks?.[0]
    if (!track) return
    track.mode = subtitulos && cues.length > 0 ? 'hidden' : 'disabled'
  }, [ref, subtitulos, cues.length, pista, video?.url])

  /* ── Eventos del elemento ────────────────────────────────────────────── */

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const alTiempo = () => {
      setTiempo(el.currentTime)
      onTiempo?.(el.currentTime)
    }
    const alCargar = () => setDuracion(el.duration || 0)
    const alReproducir = () => setReproduciendo(true)
    const alPausar = () => setReproduciendo(false)
    const alVolumen = () => setSilenciado(el.muted)
    const alFallar = () => setRoto(true)

    el.addEventListener('timeupdate', alTiempo)
    el.addEventListener('loadedmetadata', alCargar)
    el.addEventListener('durationchange', alCargar)
    el.addEventListener('play', alReproducir)
    el.addEventListener('pause', alPausar)
    el.addEventListener('ended', alPausar)
    el.addEventListener('volumechange', alVolumen)
    el.addEventListener('error', alFallar)

    return () => {
      el.removeEventListener('timeupdate', alTiempo)
      el.removeEventListener('loadedmetadata', alCargar)
      el.removeEventListener('durationchange', alCargar)
      el.removeEventListener('play', alReproducir)
      el.removeEventListener('pause', alPausar)
      el.removeEventListener('ended', alPausar)
      el.removeEventListener('volumechange', alVolumen)
      el.removeEventListener('error', alFallar)
    }
  }, [ref, onTiempo, video?.url])

  useEffect(() => {
    const alCambiarPantalla = () => setCompleta(document.fullscreenElement === contenedor.current)
    document.addEventListener('fullscreenchange', alCambiarPantalla)
    return () => document.removeEventListener('fullscreenchange', alCambiarPantalla)
  }, [])

  /* ── Acciones ────────────────────────────────────────────────────────── */

  /*
   * Sin `useCallback`. `ref` acá no es un `useRef` directo sino `videoRef ??
   * propio`, así que el compilador de React no lo reconoce como ref: infiere
   * `ref.current` como dependencia, no coincide con la declarada, y ante esa
   * discrepancia deja de optimizar **todo** el componente. Estas funciones solo
   * viajan como `onClick`/`onKeyDown`, nunca como dependencia de un efecto: no
   * necesitan identidad estable, y soltarlas le devuelve al compilador el
   * trabajo de memorizarlas, que lo hace mejor que nosotros a mano.
   */
  const alternar = () => {
    const el = ref.current
    if (!el) return
    if (el.paused) void el.play()
    else el.pause()
  }

  const saltar = (delta: number) => {
    const el = ref.current
    if (!el) return
    el.currentTime = Math.min(Math.max(0, el.currentTime + delta), el.duration || 0)
  }

  /**
   * Pantalla completa, con la vuelta que hace falta para iPhone.
   *
   * iOS Safari **no implementa la API de pantalla completa sobre un elemento
   * cualquiera**: `requestFullscreen` no existe sobre un `<div>`. Lo único que
   * soporta es `webkitEnterFullscreen()` sobre el propio `<video>`, que abre el
   * reproductor nativo del sistema. Sin este camino alternativo, el botón de
   * pantalla completa en iPhone no hacía absolutamente nada.
   *
   * Que en iOS se abra el reproductor nativo y no el nuestro es la única opción
   * disponible, y ahí el `<track>` de subtítulos que ahora emitimos pasa a
   * importar más todavía: es lo único que ese reproductor sabe mostrar de lo
   * nuestro.
   */
  const pantallaCompleta = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen()
      return
    }

    const caja = contenedor.current
    if (caja?.requestFullscreen) {
      void caja.requestFullscreen()
      return
    }

    const nativo = ref.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null
    nativo?.webkitEnterFullscreen?.()
  }

  const alTeclado = (e: React.KeyboardEvent<HTMLDivElement>) => {
    /*
     * Antes esto cortaba ante cualquier control propio, y el resultado era que
     * los atajos morían apenas tocabas un botón: el foco se queda en el botón
     * que clickeaste, así que a partir de ahí ni `f`, ni `m`, ni las flechas
     * hacían nada. Justo después de darle play —lo primero que hace cualquiera—
     * el teclado quedaba mudo.
     *
     * Lo que hay que respetar no es "el foco está en un control", sino las dos
     * teclas con las que el navegador activa ese control. Espacio y Enter sobre
     * un botón le pertenecen al botón; el resto puede pasar sin ambigüedad.
     *
     * Nota de alcance: el contenedor sigue con `tabIndex={-1}`, así que recibe
     * foco al hacer click pero no por tabulación. Quien navegue solo con
     * teclado llega a los botones (que funcionan con Enter y Espacio) pero no
     * a los atajos. Hacerlo tabulable agregaría una parada más en el recorrido
     * y no se puede evaluar bien sin un video renderizado a la vista —hoy no
     * hay ninguno—, así que se deja anotado en vez de decidirlo a ciegas.
     */
    const enControl = (e.target as HTMLElement).closest('button, input, a')
    if (enControl && (e.key === ' ' || e.key === 'Enter')) return

    const acciones: Record<string, () => void> = {
      ' ': alternar,
      k: alternar,
      ArrowLeft: () => saltar(-10),
      ArrowRight: () => saltar(10),
      m: () => {
        if (ref.current) ref.current.muted = !ref.current.muted
      },
      c: () => setSubtitulos((v) => !v),
      f: pantallaCompleta,
    }

    const accion = acciones[e.key] ?? acciones[e.key.toLowerCase()]
    if (accion) {
      e.preventDefault()
      accion()
    }
  }

  /* ── Estados en los que todavía no hay video ─────────────────────────── */

  if (!video) return <SinVideo aviso={VIDEO.sinVideo} className={className} />
  if (video.status === 'failed' || roto) {
    return <SinVideo aviso={VIDEO.fallado} tono="incompleto" className={className} />
  }
  if (video.status === 'queued' || video.status === 'rendering' || !video.url) {
    const aviso = video.status === 'rendering' ? VIDEO.renderizando : VIDEO.enCola
    return (
      <Bezel className={className}>
        <div
          // `<output>` solo admite contenido de frase y acá adentro van un
          // spinner y dos párrafos: sería HTML inválido. Y nombra el resultado
          // de un cálculo de formulario, que no es lo que pasa acá.
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
          role="status"
          className="flex aspect-video w-full flex-col items-center justify-center gap-4 px-6 text-center"
        >
          <Spinner size="lg" />
          <div className="max-w-md space-y-1.5">
            <p className="font-display text-xl text-ink">{aviso.titulo}</p>
            <p className="text-base text-ink-muted">{aviso.texto}</p>
          </div>
        </div>
      </Bezel>
    )
  }

  /* ── Reproductor ─────────────────────────────────────────────────────── */

  const avance = duracion > 0 ? (tiempo / duracion) * 100 : 0

  return (
    <Bezel className={className}>
      {/* Punto de delegación de los atajos de teclado, no un control. Todo lo
          que se opera de verdad —los botones y la barra de avance— son
          elementos interactivos propios, enfocables y con nombre. Este `div` no
          es destino de tabulación (`tabIndex={-1}`) y no hay rol que lo
          describa: ponerle uno interactivo anunciaría un control inexistente. */}
      {/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions */}
      <div
        ref={contenedor}
        onKeyDown={alTeclado}
        tabIndex={-1}
        className="w-full"
      >
        <div className="relative isolate">
          <video
            ref={ref}
            src={video.url}
            preload="metadata"
            playsInline
            controls={false}
            aria-label={titulo}
            onClick={alternar}
            className="block aspect-video w-full cursor-pointer bg-canvas-sunken object-contain"
          >
            {/* Subtítulos como pista real. Ver la nota larga más arriba: el
                navegador la necesita para saber que existen; nosotros igual los
                dibujamos abajo, y por eso la pista va en modo `hidden`. */}
            <track kind="captions" srcLang="es" label={VIDEO.subtitulos} src={pista} />
            {VIDEO.noSoportado}
          </video>

          {/* Subtítulo. Va sobre el video, no debajo: se lee sin mover los ojos.
              `ink` de fondo con `ink-inverse` encima es el único par que
              contrasta bien en los dos temas. */}
          {cue && (
            <p
              aria-live="off"
              className={cn(
                'pointer-events-none absolute inset-x-0 bottom-4 mx-auto w-fit max-w-[min(90%,42rem)]',
                'rounded-sm bg-ink/85 px-3 py-1.5 text-center text-base leading-snug text-ink-inverse',
                'sm:text-lg',
              )}
            >
              {cue.caption}
            </p>
          )}

          {/* Botón grande de arranque: mientras está pausado y sin empezar. */}
          {!reproduciendo && tiempo === 0 && (
            <button
              type="button"
              onClick={alternar}
              aria-label={VIDEO.reproducir}
              className={cn(
                'absolute inset-0 z-10 flex items-center justify-center',
                'focus-visible:focus-ring-inset',
              )}
            >
              <span
                className={cn(
                  'flex size-16 items-center justify-center rounded-full bg-surface-raised shadow-float',
                  'transition-transform duration-200 ease-out-soft hover:scale-105 active:scale-95',
                )}
              >
                <Play aria-hidden="true" strokeWidth={1.8} className="ml-1 size-7 text-ink" />
              </span>
            </button>
          )}
        </div>

        {/* Controles en una barra propia, debajo del video.
            Ni encima del contenido ni escondidos detrás de un hover: en el
            celular no hay hover, y tapar la grabación con los botones es tapar
            justo lo que hay que mirar. */}
        <div className="border-t border-line bg-surface px-2 pt-1.5 pb-1">
          <label className="sr-only" htmlFor={`avance-${video.id}`}>
            {VIDEO.barra}
          </label>
          <input
            id={`avance-${video.id}`}
            type="range"
            min={0}
            max={duracion || 0}
            step={0.1}
            value={tiempo}
            onChange={(e) => {
              if (ref.current) ref.current.currentTime = Number(e.target.value)
            }}
            aria-valuetext={`${reloj(tiempo)} de ${reloj(duracion)}`}
            style={{ backgroundSize: `${avance}% 100%` }}
            className={cn(
              'h-6 w-full cursor-pointer appearance-none bg-transparent px-1',
              '[&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:rounded-full',
              '[&::-webkit-slider-runnable-track]:bg-line-strong',
              '[&::-webkit-slider-thumb]:mt-[-5px] [&::-webkit-slider-thumb]:size-3.5',
              '[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full',
              '[&::-webkit-slider-thumb]:bg-ink [&::-webkit-slider-thumb]:shadow-support',
              '[&::-moz-range-track]:h-1 [&::-moz-range-track]:rounded-full',
              '[&::-moz-range-track]:bg-line-strong',
              '[&::-moz-range-thumb]:size-3.5 [&::-moz-range-thumb]:border-0',
              '[&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-ink',
              'focus-visible:focus-ring',
            )}
          />

          <div className="flex items-center gap-0.5">
            <Control
              icono={reproduciendo ? Pause : Play}
              etiqueta={reproduciendo ? VIDEO.pausar : VIDEO.reproducir}
              onClick={alternar}
            />

            <span className="mx-1.5 shrink-0 font-mono text-xs text-ink-muted tabular">
              {reloj(tiempo)} / {reloj(duracion)}
            </span>

            <span className="flex-1" />

            <Control
              icono={silenciado ? VolumeX : Volume2}
              etiqueta={silenciado ? VIDEO.activarSonido : VIDEO.silenciar}
              onClick={() => {
                if (ref.current) ref.current.muted = !ref.current.muted
              }}
            />
            <Control
              icono={subtitulos ? Captions : CaptionsOff}
              etiqueta={subtitulos ? VIDEO.ocultarSubtitulos : VIDEO.activarSubtitulos}
              presionado={subtitulos}
              onClick={() => setSubtitulos((v) => !v)}
              deshabilitado={cues.length === 0}
            />
            <Control
              icono={completa ? Shrink : Expand}
              etiqueta={completa ? VIDEO.salirPantallaCompleta : VIDEO.pantallaCompleta}
              onClick={pantallaCompleta}
            />
          </div>
        </div>
      </div>
    </Bezel>
  )
}

/* ── Piezas internas ───────────────────────────────────────────────────── */

function Control({
  icono: Icono,
  etiqueta,
  onClick,
  presionado,
  deshabilitado = false,
}: {
  icono: LucideIcon
  etiqueta: string
  onClick: () => void
  presionado?: boolean
  deshabilitado?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={deshabilitado}
      aria-label={etiqueta}
      aria-pressed={presionado}
      title={etiqueta}
      className={cn(
        'inline-flex size-11 shrink-0 items-center justify-center rounded-sm',
        'text-ink-muted transition-colors duration-150 ease-firm',
        'hover:bg-surface-hover hover:text-ink focus-visible:focus-ring',
        'disabled:cursor-not-allowed disabled:opacity-40',
      )}
    >
      <Icono aria-hidden="true" strokeWidth={1.8} className="size-5" />
    </button>
  )
}

function SinVideo({
  aviso,
  tono = 'neutral',
  className,
}: {
  aviso: { titulo: string; texto: string }
  tono?: 'neutral' | 'incompleto'
  className?: string
}) {
  return (
    <Callout tone={tono} title={aviso.titulo} className={className}>
      {aviso.texto}
    </Callout>
  )
}
