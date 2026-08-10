/**
 * Copy de producto. Voz de marca: directa, cálida, sin condescender.
 * El lector no es tonto: es no técnico. Nunca explicar de más, nunca usar jerga.
 */

export const MARCA = {
  nombre: 'caughtcode',
  tagline: 'Te muestro qué está roto en tu app. Con el video de prueba.',
  descripcion:
    'Auditamos apps hechas con inteligencia artificial. Encontramos lo que está roto o es peligroso, te lo demostramos en video y te damos el texto exacto para pedirle el arreglo a tu asistente.',
}

export const LANDING = {
  hero: {
    titulo: 'Tu app funciona. Eso no quiere decir que esté bien.',
    bajada:
      'Un agente entra a tu app como entraría cualquiera —o como entraría alguien con malas intenciones— e intenta romperla. Todo queda grabado. Después te explicamos lo que encontró con ese video, sin una sola palabra técnica.',
    ctaPrincipal: 'Auditar mi app',
    ctaSecundario: 'Ver un ejemplo',
    nota: 'Conectás tu repositorio o subís un zip. No hace falta que sepas programar.',
  },

  problema: {
    titulo: 'Construiste tu app con IA. Nadie la revisó.',
    parrafo:
      'Claude Code, Cursor, Lovable, Bolt. Escribís lo que querés y aparece. Funciona. Pero no tenés forma de saber si es segura, si le falta algo importante, o si te la van a rechazar cuando la quieras publicar.',
    datos: [
      {
        cifra: '+170',
        texto: 'proyectos de Lovable quedaron con los datos a la vista por un solo error de configuración.',
      },
      {
        cifra: '2.000+',
        texto: 'problemas de seguridad encontrados al escanear 5.600 apps hechas con IA. Entre ellos, 400 claves secretas expuestas.',
      },
      {
        cifra: '3 min',
        texto: 'tardaron en vulnerar Moltbook. Su fundador lo dijo así: "no escribí ni una línea de código".',
      },
    ],
    cierre:
      'Las herramientas que existen te devuelven cosas como "CWE-89 en línea 45". Si no sos programador, con eso no podés hacer nada.',
  },

  comoFunciona: {
    titulo: 'Cómo funciona',
    pasos: [
      {
        titulo: 'Nos das acceso a tu proyecto',
        texto: 'Conectás tu repositorio de GitHub —solo lectura— o subís un zip. Si no sabés qué es GitHub, el zip alcanza.',
      },
      {
        titulo: 'Leemos el código y entramos a tu app',
        texto: 'Primero mapeamos cómo está armado tu proyecto. Después un agente entra a la app desplegada e intenta hacer cosas: registrarse, recuperar la contraseña, borrar la cuenta, ver datos de otra persona.',
      },
      {
        titulo: 'Te mostramos lo que pasó',
        texto: 'Cada problema viene con la grabación de cuando ocurrió y una explicación de un minuto. No es un reporte para interpretar: es la prueba.',
      },
      {
        titulo: 'Copiás el arreglo',
        texto: 'Cada hallazgo trae el texto exacto para pegarle a tu asistente. No te pedimos que entiendas el problema: te pedimos que lo arregles.',
      },
    ],
  },

  pilares: [
    {
      id: 'security',
      titulo: 'Seguridad',
      texto: 'Quién puede ver qué. Claves a la vista. Puertas que quedaron sin llave.',
      ejemplo: 'Me registré como usuario común y pude leer la facturación de todos tus clientes.',
    },
    {
      id: 'completeness',
      titulo: 'Funciona completo',
      texto: 'Lo que falta y todavía no notaste: recuperar la contraseña, cerrar sesión, borrar la cuenta.',
      ejemplo: 'Intenté recuperar mi contraseña. El enlace no existe.',
    },
    {
      id: 'store_hygiene',
      titulo: 'Listo para publicar',
      texto: 'Lo que te haría rechazar en la App Store o Google Play, y el tema de las cookies.',
      ejemplo: 'No hay forma de borrar la cuenta. Apple rechaza por eso desde 2022.',
    },
  ],

  diferencia: {
    titulo: 'Por qué esto y no otra cosa',
    puntos: [
      {
        titulo: 'Nada que no podamos probar',
        texto:
          'Cada cosa que te decimos apunta a una línea concreta de tu código o a la grabación del momento en que pasó. Si no estamos seguros, te lo decimos con todas las letras en vez de afirmarlo.',
      },
      {
        titulo: 'Tres cosas, no cincuenta',
        texto:
          'Te mostramos las tres que importan hoy. El resto queda guardado, no perdido. Una lista de cincuenta problemas no se arregla: se ignora.',
      },
      {
        titulo: 'Sabés cuánto sale antes de gastarlo',
        texto:
          'El precio se muestra en pesos y dólares, y en unidades que se entienden: una auditoría, tres videos. Nada de créditos que se evaporan.',
      },
    ],
  },

  privacidad: {
    titulo: 'Sobre tu código',
    puntos: [
      'Lo leemos para auditarlo y nada más.',
      'No entrenamos modelos con él.',
      'Se borra cuando vos lo pedís, y también solo, pasado el plazo que elijas.',
      'Para revisar tu base de datos no escribimos nada: simulamos la consulta y la deshacemos.',
      'Si querés que creemos usuarios de prueba en tu app, te lo pedimos antes y los borrás de un clic.',
    ],
  },

  cierre: {
    titulo: 'Diez minutos ahora, o el mail de un usuario después.',
    texto: 'Empezá por tu app más importante. Si no encontramos nada serio, mejor: te lo decimos igual.',
    cta: 'Auditar mi app',
  },
}

export const ONBOARDING = {
  bienvenida: {
    titulo: 'Empecemos por tu app',
    texto: 'Necesitamos dos cosas: el código y, si ya está publicada, la dirección donde vive.',
  },
  fuentes: {
    github: {
      titulo: 'Conectar GitHub',
      texto: 'Elegís qué repositorios podemos leer. Solo lectura: no podemos cambiar nada.',
    },
    publico: {
      titulo: 'Pegar la dirección del repositorio',
      texto: 'Si tu proyecto es público, alcanza con la dirección. No hace falta conectar nada.',
      placeholder: 'https://github.com/tu-usuario/tu-proyecto',
      ayuda: 'Es la dirección que ves arriba en el navegador cuando abrís tu repositorio.',
    },
    zip: {
      titulo: 'Subir un archivo zip',
      texto: 'Arrastrá la carpeta de tu proyecto comprimida. No hace falta tener cuenta de GitHub.',
    },
  },
  erroresDeRepositorio: {
    direccionInvalida:
      'Esa no parece una dirección de GitHub. Copiala de la barra del navegador: tiene la forma github.com/tu-usuario/tu-proyecto',
    privado:
      'Ese repositorio es privado, así que todavía no podemos entrar. Conectá tu cuenta de GitHub y elegí a cuáles darnos acceso, o subí tu proyecto como archivo zip.',
    noExiste:
      'No encontramos ese repositorio. Fijate que la dirección esté completa y que el proyecto siga publicado.',
    demasiadosIntentos:
      'GitHub nos pidió esperar un rato antes de volver a intentar. Probá de nuevo en unos minutos o subí tu proyecto como archivo zip.',
    demasiadoGrande:
      'Tu proyecto pesa más de lo que podemos traer de una. Escribinos y lo resolvemos con vos.',
  },
  urlDesplegada: {
    titulo: '¿Dónde está publicada?',
    texto:
      'Si nos das la dirección, el agente puede entrar y probar cosas de verdad. Sin eso solo podemos leer el código, que es la mitad del trabajo.',
    placeholder: 'https://mi-app.vercel.app',
    opcional: 'Podés agregarla después.',
  },
  baseDeDatos: {
    titulo: '¿Usás Supabase?',
    texto:
      'Si nos das una conexión de solo lectura, podemos verificar de verdad quién puede ver qué. No escribimos nada: las pruebas se hacen y se deshacen en el mismo momento.',
    opcional: 'También es opcional.',
  },
}

export const ESTADOS = {
  cargando: {
    titulo: 'Estamos revisando tu app',
    texto: 'Vas a ver los hallazgos acá abajo a medida que aparezcan. No hace falta que esperes mirando.',
  },
  vacioProyectos: {
    titulo: 'Todavía no auditaste nada',
    texto: 'Empezá por la app que más te preocupa. Tarda unos minutos.',
    accion: 'Auditar mi primera app',
  },
  vacioHallazgos: {
    titulo: 'No encontramos nada serio',
    texto:
      'Revisamos las tres áreas y no apareció nada que amerite que dejes lo que estás haciendo. Guardamos el detalle de todo lo que miramos por si querés verlo.',
    accion: 'Ver todo lo que revisamos',
  },
  error: {
    titulo: 'Algo salió mal de nuestro lado',
    texto: 'No es culpa tuya ni de tu código. Podés reintentar; si vuelve a pasar, escribinos.',
    accion: 'Reintentar',
  },
  sinPermisos: {
    titulo: 'No tenés acceso a este proyecto',
    texto: 'Puede ser que te hayan sacado del equipo, o que el enlace sea de otra cuenta.',
    accion: 'Volver a mis proyectos',
  },
  repoDemasiadoGrande: {
    titulo: 'Tu proyecto es más grande de lo que podemos revisar de una',
    texto:
      'Lo dividimos y revisamos las partes más importantes primero. Vas a ver los resultados igual, pero conviene que sepas que no llegamos a todo.',
    accion: 'Revisar por partes',
  },
  jobFallado: {
    titulo: 'La revisión se cortó por la mitad',
    texto: 'Guardamos lo que alcanzamos a encontrar. Podés retomar desde donde quedó, sin volver a pagar.',
    accion: 'Retomar',
  },
}

export const COMENTARIOS = {
  titulo: 'Comentarios en tu código',
  bajada:
    'Los comentarios que escribiste —o que escribió tu asistente— pueden terminar visibles para cualquiera que entre a tu app. Acá te mostramos cuáles, y podés sacarlos todos de una.',
  explicacion: {
    titulo: '¿Los comentarios se ven?',
    texto:
      'Depende de dónde estén. Los de las páginas HTML se leen apretando "ver código fuente" en cualquier navegador. Los de las pantallas que se arman en el navegador suelen borrarse al publicar, pero sobreviven si el sitio se publica sin comprimir o si quedan publicados los archivos de depuración. Los de tu servidor no salen nunca.',
  },
  alcance: {
    ships_to_browser: 'Lo ve cualquiera que entre',
    server_only: 'Se queda en tu servidor',
    build_only: 'Nunca sale de tu computadora',
  },
  riesgo: {
    secret: 'Contiene algo que parece una clave',
    internal_note: 'Nota interna',
    todo: 'Pendiente sin resolver',
    disabled_code: 'Código viejo comentado',
    none: 'Comentario común',
  },
  modos: {
    safe: {
      titulo: 'Limpieza segura',
      texto:
        'Saca los comentarios comunes y deja los que tu proyecto necesita para funcionar: los que le hablan al compilador, los de licencia y los que apagan avisos del revisor de código.',
    },
    aggressive: {
      titulo: 'Limpieza a fondo',
      texto:
        'Saca todo lo que se pueda sacar sin romper nada. Conserva únicamente licencias y las instrucciones que el proyecto necesita sí o sí.',
    },
  },
  garantia:
    'Antes de proponerte un cambio verificamos que el archivo siga funcionando exactamente igual: comparamos el código antes y después, pieza por pieza. Si algo no da idéntico, ese archivo queda afuera.',
  aplicar: {
    titulo: 'Cómo lo aplicás',
    texto:
      'Te damos un archivo de cambios para revisar antes de aplicarlo, o el proyecto ya limpio en un zip. Nunca tocamos tu repositorio por nuestra cuenta.',
  },
}

export const COSTO = {
  antesDeGastar: 'Antes de arrancar te decimos cuánto sale.',
  sinCreditos: 'Sin créditos. Precio en dólares, y en unidades que se entienden.',
  etiquetaAuditoria: (videos: number) =>
    `1 auditoría completa · ${videos} ${videos === 1 ? 'video' : 'videos'} narrados`,
}
