/**
 * Texto de la pantalla de hallazgos.
 *
 * El contenido de cada hallazgo sale del catálogo (`src/content/catalogo.ts`).
 * Acá vive solo lo que rodea: botones, encabezados de sección, estados del
 * video. Está todo junto en un archivo para que el test de jerga lo pueda
 * recorrer entero y para que se revise como texto, no repartido en el JSX.
 *
 * Voz: directa, en segunda persona, sin condescender. El lector no es tonto,
 * es no técnico.
 */

export const LISTA = {
  titulo: 'Hallazgos',
  /** Bajada cuando hay algo urgente. */
  bajadaConUrgentes: 'Empezá por estas. El resto puede esperar.',
  /** Bajada cuando lo urgente ya está resuelto pero queda cosa menor. */
  bajadaSinUrgentes: 'Nada urgente. Quedaron cosas menores para cuando tengas un rato.',
  volverAAnalizar: 'Volver a revisar',

  destacados: {
    encabezado: 'Hacé esto ya',
    ayuda: 'Lo elegimos por lo que puede pasar si se queda así, no por cuántas veces aparece.',
  },

  resto: {
    encabezado: 'Lo demás que encontramos',
    ayuda: 'Guardado, no perdido. Abrí el área que te interese.',
    /** (n) → "4 cosas" / "1 cosa" */
    conteo: (n: number) => (n === 1 ? '1 cosa' : `${n} cosas`),
  },

  cerrados: {
    encabezado: 'Ya cerrados',
    ayuda: 'Lo que marcaste como resuelto o descartaste.',
  },

  /** Aviso cuando la revisión terminó a medias. */
  parcial: {
    titulo: 'Alcanzamos a revisar una parte',
    texto: 'Lo que ves acá es real y está verificado. Falta terminar el resto.',
  },
}

/**
 * Estados previos a tener resultados.
 *
 * Existen por una regla dura: **nunca decir "no encontramos nada" sin haber
 * revisado**. Nuestro usuario no puede detectar que le mentimos, así que la
 * diferencia entre "revisamos y está limpio" y "todavía no revisamos" tiene que
 * ser explícita en la pantalla, no deducible.
 */
export const ANTES_DE_REVISAR = {
  sinRevisar: {
    titulo: 'Todavía no revisamos esta app',
    texto: 'Cuando arranques, vamos a traer tu código, probar la app y contarte lo que encontremos.',
    accion: 'Revisar ahora',
  },
  enCola: {
    titulo: 'Está en la fila',
    texto: 'Tu revisión ya está pedida y arranca apenas se libere lugar. Podés cerrar esta pantalla: cuando termine, los resultados quedan acá.',
  },
  fallada: {
    titulo: 'No pudimos terminar la revisión',
    texto: 'Abajo está lo que pasó. Si lo podés resolver, volvé a intentar; si no, escribinos y lo miramos nosotros.',
    accion: 'Volver a intentar',
  },
}

export const COBERTURA = {
  titulo: 'Todo lo que revisamos',
  volver: 'Volver a los hallazgos',
  resumen: (revisados: number, total: number) =>
    revisados === total
      ? `Completamos las ${total} revisiones que tenemos disponibles.`
      : `Completamos ${revisados} de ${total} revisiones disponibles. Las demás quedaron afuera por lo que contamos abajo.`,
  limpio: 'Corrió y no encontró nada para marcar.',
  conHallazgos: (n: number) => (n === 1 ? 'Encontró 1 hallazgo.' : `Encontró ${n} hallazgos.`),
  noTerminado: 'No lo pudimos terminar de nuestro lado. No es un problema de tu app.',
  sinNovedadesEnArea: 'Nada para marcar en esta área.',
  faltaConectarTitulo: 'Para revisar el resto, falta esto',
  afecta: (n: number) =>
    n === 1 ? 'Deja 1 revisión sin hacer.' : `Deja ${n} revisiones sin hacer.`,
}

export const PROGRESO = {
  titulo: 'Estamos revisando tu app',
  /** Cuando el motor todavía no reportó en qué anda. */
  etapaDesconocida: 'Preparando todo',
  esperando: 'Todavía no encontramos nada. Si aparece algo, lo vas a ver acá sin recargar.',
  yaAparecieron: (n: number) =>
    n === 1
      ? 'Encontramos 1 cosa hasta ahora. Seguimos buscando.'
      : `Encontramos ${n} cosas hasta ahora. Seguimos buscando.`,
  cortado: 'Se cortó la conexión con la revisión. Recargá la página para ver cómo va.',
}

export const TARJETA = {
  /** Encabezado del párrafo de consecuencias. */
  quePuedePasar: 'Qué puede pasar',
  verDemostracion: 'Ver la demostración',
  verDetalle: 'Ver el detalle',
  abrir: 'Abrir',
  /** Rótulo accesible del numeral de orden. */
  posicion: (n: number) => `Prioridad ${n} de 3`,
}

export const DETALLE = {
  eyebrowPorArea: 'Qué encontramos',
  loQuePasa: 'Qué está pasando',
  quePuedePasar: 'Qué puede pasar',
  laPrueba: 'La prueba',
  pruebaAyuda: 'Esto es lo que miramos para decirte lo de arriba. Podés verificarlo vos.',
  volver: 'Volver a los hallazgos',

  sinEvidencia: {
    titulo: 'Este hallazgo llegó sin la prueba',
    texto:
      'No te lo podemos mostrar sin la evidencia que lo respalda: es un error nuestro, no de tu app. Ya lo estamos viendo.',
  },
}

export const VIDEO = {
  titulo: 'La demostración',
  reproducir: 'Reproducir',
  pausar: 'Pausar',
  silenciar: 'Silenciar',
  activarSonido: 'Activar el sonido',
  subtitulos: 'Subtítulos',
  activarSubtitulos: 'Mostrar los subtítulos',
  ocultarSubtitulos: 'Ocultar los subtítulos',
  pantallaCompleta: 'Pantalla completa',
  salirPantallaCompleta: 'Salir de pantalla completa',
  retroceder: 'Retroceder 10 segundos',
  adelantar: 'Adelantar 10 segundos',
  barra: 'Avance del video',

  enCola: {
    titulo: 'El video se está armando',
    texto:
      'Tarda un par de minutos. Mientras tanto podés leer la explicación y la prueba: no te falta nada para arreglarlo.',
  },
  renderizando: {
    titulo: 'Grabando la demostración',
    texto: 'Falta poco. Cuando esté, aparece acá sin que recargues.',
  },
  fallado: {
    titulo: 'No pudimos armar el video',
    texto:
      'El hallazgo sigue siendo válido: abajo está la prueba completa. El video es un refuerzo, no la fuente.',
  },
  sinVideo: {
    titulo: 'Este hallazgo no tiene video',
    texto: 'Se demuestra con la prueba de abajo, que apunta directo a tu código.',
  },
  noSoportado: 'Tu navegador no puede reproducir este video.',
}

export const TRANSCRIPCION = {
  titulo: 'Leer lo que dice el video',
  buscar: 'Buscar en la transcripción',
  buscarAyuda: 'Tocá cualquier línea para saltar a ese momento.',
  placeholder: 'Escribí una palabra',
  sinResultados: 'No hay ninguna línea con esa palabra.',
  vacia: 'Todavía no tenemos la transcripción de este video.',
  irA: (tiempo: string) => `Ir al minuto ${tiempo}`,
}

export const ARREGLO = {
  titulo: 'El arreglo',
  bajada:
    'Pegale esto a tu asistente —Claude Code, Cursor, Lovable, el que uses— tal cual está. No hace falta que entiendas el problema para arreglarlo.',
  copiar: 'Copiar el arreglo',
  copiado: 'Copiado',
  fallo: 'No se pudo copiar',
  verTexto: 'Ver el texto completo',
}

export const ESTADO_HALLAZGO = {
  marcarResuelto: 'Marcar como resuelto',
  marcandoResuelto: 'Guardando',
  reabrir: 'Volver a abrirlo',
  descartar: 'Descartar',
  masAcciones: 'Más acciones',

  resueltoOk: 'Listo, quedó marcado como resuelto.',
  reabiertoOk: 'Lo volvimos a abrir.',
  descartadoOk: 'Descartado. Queda guardado por si cambiás de idea.',
  fallo: 'No pudimos guardar el cambio. Probá de nuevo.',

  confirmarDescarte: {
    titulo: '¿Descartar este hallazgo?',
    consecuencias: [
      'Sale de la lista principal y deja de contar como pendiente.',
      'Queda guardado en “Ya cerrados”: lo podés volver a abrir cuando quieras.',
      'Si volvemos a revisar tu app y el problema sigue, va a aparecer de nuevo.',
    ],
    confirmar: 'Descartar',
  },
}

/** Etiquetas de cada tipo de prueba. Nunca se muestra el nombre interno. */
export const EVIDENCIA = {
  code: {
    titulo: 'En tu código',
    ayuda: 'Abrí este archivo en tu editor y andá a la línea marcada.',
  },
  recording: {
    titulo: 'Grabado mientras lo probábamos',
    ayuda: 'Este es el momento exacto en que pasó.',
    verMomento: 'Ver este momento',
  },
  database: {
    titulo: 'En tu base de datos',
    ayuda: 'Lo consultamos sin escribir nada: la prueba se hace y se deshace en el momento.',
  },
  http: {
    titulo: 'Le pedimos esto a tu app',
    ayuda: 'Cualquiera puede hacer este mismo pedido desde su navegador.',
    respondio: 'Tu app respondió',
  },
  browser: {
    titulo: 'Lo que vimos en tu app',
    ayuda: 'Entramos como entraría cualquier visitante.',
  },
} as const

/** Textos de la pantalla que el test de jerga recorre entero. */
export const TEXTOS_VISIBLES: string[] = [
  ...Object.values(LISTA).flatMap(aplanar),
  ...Object.values(ANTES_DE_REVISAR).flatMap(aplanar),
  ...Object.values(COBERTURA).flatMap(aplanar),
  ...Object.values(PROGRESO).flatMap(aplanar),
  ...Object.values(TARJETA).flatMap(aplanar),
  ...Object.values(DETALLE).flatMap(aplanar),
  ...Object.values(VIDEO).flatMap(aplanar),
  ...Object.values(TRANSCRIPCION).flatMap(aplanar),
  ...Object.values(ARREGLO).flatMap(aplanar),
  ...Object.values(ESTADO_HALLAZGO).flatMap(aplanar),
  ...Object.values(EVIDENCIA).flatMap(aplanar),
]

/** Aplana strings, objetos anidados y el resultado de las funciones de texto. */
function aplanar(valor: unknown): string[] {
  if (typeof valor === 'string') return [valor]
  if (typeof valor === 'function') {
    try {
      const salida = (valor as (...args: unknown[]) => unknown)(2)
      return typeof salida === 'string' ? [salida] : []
    } catch {
      return []
    }
  }
  if (Array.isArray(valor)) return valor.flatMap(aplanar)
  if (valor && typeof valor === 'object') return Object.values(valor).flatMap(aplanar)
  return []
}
