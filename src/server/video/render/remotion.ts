/**
 * Renderer `remotion` — reservado, SIN IMPLEMENTAR.
 *
 * Lo usa: nadie hoy. Se instancia solo si alguien pone `VIDEO_RENDERER=remotion`,
 * y en ese caso falla con un mensaje que explica qué falta.
 *
 * ── Por qué está acá y por qué está vacío ──
 *
 * D11 se cerró a favor del renderer `web` (el razonamiento completo está en
 * `../renderer.ts`). Este archivo existe para que la decisión sea reversible sin
 * refactor: la interfaz `VideoRenderer` ya separa "qué clip hay que hacer" de
 * "con qué se hace", así que cambiar de motor es cambiar una variable de
 * entorno y escribir este archivo.
 *
 * ANTES DE IMPLEMENTARLO HAY QUE RESOLVER LA LICENCIA. Estado a 2026-08:
 *
 *  - Remotion no es MIT. Es gratis hasta 3 empleados; el tier "Automators" que
 *    nos correspondería cuesta US$0,01 por render con un **piso de US$100/mes**.
 *  - La licencia permite explícitamente "un servicio que genera código Remotion
 *    con IA y lo renderiza", pero **exige aprobación escrita** para que terceros
 *    rendericen sus propios proyectos. Nuestro caso parece caer del lado bueno
 *    (el usuario no escribe ni renderiza composiciones: nosotros generamos el
 *    clip de su hallazgo), pero eso hay que tenerlo por escrito de Remotion,
 *    no deducido de la lectura de un abogado que no tenemos.
 *  - No hay benchmark público de render de código animado en Lambda. La
 *    referencia de ~US$0,0105/min es para composiciones simples: presupuestar
 *    2-4x hasta medirlo con `scripts/medir-cogs.ts`.
 *
 * Qué haría falta además del permiso: `@remotion/renderer`, `@remotion/cli` y
 * un paquete de composiciones en `video/remotion/**`. Ninguna de esas
 * dependencias está instalada, y agregarlas no es decisión de este frente.
 */

import { RenderError, type RenderEntrada, type RenderSalida, type VideoRenderer } from '../renderer'

export const MOTIVO_NO_DISPONIBLE =
  'El motor de video "remotion" está reservado pero no implementado. ' +
  'Antes de usarlo hay que confirmar por escrito con Remotion que su licencia cubre ' +
  'renderizar clips para terceros, y contratar el tier que corresponda (piso de US$100/mes). ' +
  'Mientras tanto, dejá VIDEO_RENDERER=web.'

export function crearRendererRemotion(): VideoRenderer {
  return {
    id: 'remotion',
    async render(_entrada: RenderEntrada): Promise<RenderSalida> {
      throw new RenderError(MOTIVO_NO_DISPONIBLE, 'remotion')
    },
  }
}
