import type { AgentTaskId, Confidence, Pillar, Severity } from '@/lib/types/domain'

/**
 * Catálogo de hallazgos.
 *
 * Cada entrada trae dos cosas separadas a propósito:
 *  - lo técnico (`detects`, `howToProve`): para quien implementa el chequeo. Nunca se muestra.
 *  - lo que ve el usuario (`titlePlain`, `explanationPlain`, `impactPlain`, `fixPrompt`).
 *
 * Los textos visibles usan marcadores `{{...}}` que se completan con la evidencia real.
 * Regla dura: si un texto de acá tiene jerga, el hallazgo está mal escrito.
 */
export interface CatalogEntry {
  id: string
  pillar: Pillar
  severity: Severity
  defaultConfidence: Confidence
  requires: Array<'code' | 'database' | 'deployed_app' | 'browser_run'>
  detects: string
  howToProve: string
  titlePlain: string
  /**
   * Título cuando el mismo problema aparece en varios lugares. `{{n}}` se
   * reemplaza por la cantidad.
   *
   * Existe porque el título de un caso suelto miente cuando hay muchos: leer
   * "Las reglas de admin_audit_log se pueden saltear" hace pensar que el
   * problema es esa tabla, cuando en realidad son treinta y seis. La cantidad
   * va adelante: es el dato que cambia la decisión de qué hacer primero.
   *
   * Solo lo llevan los chequeos que de verdad se repiten. Sin esto, el
   * agrupador cae a una forma genérica.
   */
  titlePlainAgrupado?: string
  explanationPlain: string
  impactPlain: string
  fixPrompt: string
  demoTaskId?: AgentTaskId
}

/* ───────────────────────── Pilar 1 · Seguridad ───────────────────────── */

const SEGURIDAD: CatalogEntry[] = [
  {
    id: 'sec.rls_disabled',
    pillar: 'security',
    severity: 'critical',
    defaultConfidence: 'confirmed',
    requires: ['database'],
    detects: 'Tabla en el esquema public con relrowsecurity = false.',
    howToProve: 'pg_class.relrowsecurity para la tabla, más una lectura simulada con claims de un usuario cualquiera dentro de una transacción con ROLLBACK.',
    titlePlain: 'Cualquiera puede leer la tabla {{tabla}}',
    explanationPlain:
      'La tabla {{tabla}} de tu base no tiene ninguna regla que limite quién la puede leer. Tu app publica una llave de acceso en el navegador —cualquiera la ve mirando el código fuente de tu sitio— y con esa llave se pueden pedir todas las filas de {{tabla}} sin siquiera tener cuenta.',
    impactPlain:
      'Alguien sin conocimientos especiales puede descargarse el contenido completo de {{tabla}} en menos de un minuto. Si ahí hay datos de tus clientes, se los lleva todos.',
    fixPrompt:
      'En mi proyecto de Supabase, la tabla `{{tabla}}` no tiene Row Level Security. Activá RLS y forzala:\n\n```sql\nalter table public.{{tabla}} enable row level security;\nalter table public.{{tabla}} force row level security;\n```\n\nDespués escribí las policies mínimas para que cada usuario solo pueda ver y modificar sus propias filas. Mostrame las policies antes de aplicarlas y explicame qué hace cada una. Si la tabla tiene una columna que identifica al dueño (por ejemplo `user_id` u `org_id`), usala; si no la tiene, decímelo en vez de inventar una.',
  },
  {
    id: 'sec.rls_permissive',
    pillar: 'security',
    severity: 'critical',
    defaultConfidence: 'confirmed',
    requires: ['database'],
    detects: 'La tabla tiene RLS activa pero una policy deja leer filas de otros usuarios u otras organizaciones.',
    howToProve:
      'Dentro de una transacción: set_config("request.jwt.claims", claims del usuario A) y select de filas cuyo dueño es B. Si devuelve filas, está probado. Siempre termina en ROLLBACK: no se escribe nada.',
    titlePlain: 'Un usuario puede ver los datos de otro',
    titlePlainAgrupado: '{{n}} tablas tuyas dejan que un usuario vea los datos de otro',
    explanationPlain:
      'Tu tabla {{tabla}} tiene reglas de acceso, pero están mal escritas: probamos entrar con la identidad de un usuario cualquiera y pudimos leer filas que pertenecen a otra persona. La regla {{policy}} deja pasar más de lo que debería.',
    impactPlain:
      'Cualquiera de tus usuarios puede ver la información de todos los demás. Es el tipo de falla que termina en una captura de pantalla circulando por Twitter.',
    fixPrompt:
      'En mi base de Supabase, la tabla `{{tabla}}` tiene la policy `{{policy}}` que deja que un usuario lea filas de otro usuario. Reescribila para que cada quien vea únicamente sus propias filas, comparando contra `auth.uid()` (o contra la organización del usuario si la tabla es compartida por equipo). Mostrame el SQL antes y después, explicame en una línea por qué la versión vieja dejaba pasar datos ajenos, y agregá un test SQL que lo demuestre usando `set_config(\'request.jwt.claims\', ...)` dentro de una transacción con `rollback`.',
    demoTaskId: 'cross_tenant_read',
  },
  {
    id: 'sec.rls_not_forced',
    pillar: 'security',
    severity: 'high',
    defaultConfidence: 'confirmed',
    requires: ['database'],
    detects: 'relrowsecurity = true pero relforcerowsecurity = false.',
    howToProve: 'Lectura directa de pg_class.',
    titlePlain: 'Las reglas de {{tabla}} se pueden saltear',
    titlePlainAgrupado: 'Las reglas de {{n}} tablas tuyas se pueden saltear',
    explanationPlain:
      'La tabla {{tabla}} tiene reglas de acceso activadas, pero no están forzadas. Eso significa que quien sea dueño de la tabla —o cualquier función que corra con permisos elevados— las ignora por completo.',
    impactPlain:
      'Una sola función mal escrita en tu proyecto alcanza para que las reglas dejen de aplicarse y se filtren datos.',
    fixPrompt:
      'En mi base de Supabase, la tabla `{{tabla}}` tiene RLS habilitada pero no forzada. Corré `alter table public.{{tabla}} force row level security;` y después revisá si alguna función `security definer` del proyecto depende de saltearse las reglas. Si encontrás alguna, mostrámela y explicame si es intencional.',
  },
  {
    id: 'sec.service_role_in_client',
    pillar: 'security',
    severity: 'critical',
    defaultConfidence: 'confirmed',
    requires: ['code'],
    detects: 'La clave service_role aparece en un archivo que se envía al navegador, o en una variable con prefijo NEXT_PUBLIC_.',
    howToProve: 'Archivo con "use client" propio o heredado, o variable NEXT_PUBLIC_*, que contiene la clave o la referencia a ella. Se cita archivo:línea.',
    titlePlain: 'La llave maestra de tu base está en el navegador',
    explanationPlain:
      'En {{archivo}}, línea {{linea}}, tu app usa la llave de administrador de la base de datos en código que se descarga al navegador de cualquier visitante. Esa llave ignora todas las reglas de acceso: es la que puede leer, cambiar y borrar todo.',
    impactPlain:
      'Cualquiera que abra tu sitio y mire el código puede copiarse esa llave y hacer lo que quiera con tu base: leerla entera, vaciarla, o modificarla.',
    fixPrompt:
      'En `{{archivo}}` (línea {{linea}}) estoy usando la clave `service_role` de Supabase en código que llega al navegador. Movela a código de servidor: creá un route handler o una server action que haga la operación del lado del servidor, y desde el navegador llamá a eso. La clave tiene que leerse solo desde `process.env.SUPABASE_SERVICE_ROLE_KEY` en archivos de servidor, nunca con prefijo `NEXT_PUBLIC_`. Después de moverla, decime que tengo que **rotar la clave** en el panel de Supabase, porque la vieja ya quedó expuesta.',
  },
  {
    id: 'sec.secret_in_repo',
    pillar: 'security',
    severity: 'critical',
    defaultConfidence: 'confirmed',
    requires: ['code'],
    detects: 'Claves, tokens o contraseñas escritas directamente en el código o en archivos versionados.',
    howToProve: 'Coincidencia con patrones de proveedores conocidos más verificación de entropía. Se cita archivo:línea con el valor enmascarado.',
    titlePlain: 'Hay una clave secreta escrita en tu código',
    explanationPlain:
      'En {{archivo}}, línea {{linea}}, hay una clave de {{proveedor}} escrita directamente en el código ({{clave_enmascarada}}). Todo lo que está en el código está en el historial del repositorio, y si el repositorio es público, está a la vista de cualquiera.',
    impactPlain:
      'Con esa clave alguien puede usar tu cuenta de {{proveedor}} y gastar tu dinero, o acceder a lo que esa clave protege. Los robots que escanean repositorios públicos la encuentran en minutos.',
    fixPrompt:
      'Tengo una clave de {{proveedor}} escrita directamente en `{{archivo}}` línea {{linea}}. Hacé esto en orden:\n1. Sacala del código y leela desde una variable de entorno.\n2. Agregá esa variable a `.env.local` y a `.env.example` (en el ejemplo, sin el valor).\n3. Verificá que `.env*` esté en `.gitignore`.\n4. Decime exactamente cómo rotar esa clave en el panel de {{proveedor}}, porque la que está en el historial de git ya no sirve como secreta aunque la borre ahora.',
  },
  {
    id: 'sec.env_committed',
    pillar: 'security',
    severity: 'critical',
    defaultConfidence: 'confirmed',
    requires: ['code'],
    detects: 'Un archivo .env con valores reales está versionado.',
    howToProve: 'Presencia del archivo en el árbol entregado más ausencia del patrón en .gitignore.',
    titlePlain: 'Tu archivo de claves está subido al repositorio',
    explanationPlain:
      'El archivo {{archivo}} está versionado. Ese archivo es donde viven todas las claves de tu app: la de la base de datos, la de los pagos, la de los servicios que usás.',
    impactPlain:
      'Quien tenga acceso al repositorio tiene todas tus claves de una sola vez. Si el repositorio es público, cualquiera.',
    fixPrompt:
      'Tengo `{{archivo}}` versionado en git con claves reales adentro. Hacé esto:\n1. Agregá `.env`, `.env.local` y `.env*.local` a `.gitignore`.\n2. Sacalo del seguimiento con `git rm --cached {{archivo}}`.\n3. Creá un `.env.example` solo con los nombres de las variables y valores vacíos.\n4. Decime cuáles de las claves que están ahí adentro tengo que rotar, y en qué panel se rota cada una. Están todas comprometidas aunque las borre del repo, porque quedan en el historial.',
  },
  {
    id: 'sec.public_env_secret',
    pillar: 'security',
    severity: 'high',
    defaultConfidence: 'confirmed',
    requires: ['code'],
    detects: 'Variable con prefijo NEXT_PUBLIC_ que contiene un secreto (nombre con key/secret/token/password y valor de alta entropía).',
    howToProve: 'Nombre de la variable más forma del valor. Se cita archivo:línea.',
    titlePlain: 'Una clave privada quedó marcada como pública',
    explanationPlain:
      'La variable {{variable}} arranca con el prefijo que le dice a tu app "esto puede verlo cualquiera", pero contiene algo que parece un secreto. Todo lo que lleva ese prefijo se empaqueta dentro del sitio y viaja al navegador de cada visitante.',
    impactPlain:
      'Ese valor está a la vista en el código fuente de tu sitio, en producción, ahora mismo.',
    fixPrompt:
      'La variable `{{variable}}` está declarada con prefijo `NEXT_PUBLIC_` pero contiene un secreto. Sacale el prefijo, movela a código de servidor y ajustá todos los usos. Si el navegador necesita el resultado de algo que usa esa clave, creá un route handler que lo devuelva ya procesado. Después decime cómo rotarla.',
  },
  {
    id: 'sec.public_bucket',
    pillar: 'security',
    severity: 'high',
    defaultConfidence: 'confirmed',
    requires: ['database'],
    detects: 'Bucket de storage marcado como público.',
    howToProve: 'storage.buckets.public = true, más una petición HTTP anónima a un objeto para confirmar que responde 200.',
    titlePlain: 'Los archivos de {{bucket}} son públicos',
    titlePlainAgrupado: 'Los archivos de {{n}} carpetas tuyas son públicos',
    explanationPlain:
      'La carpeta de archivos {{bucket}} está marcada como pública. Cualquiera que conozca —o adivine— la dirección de un archivo puede abrirlo, sin tener cuenta ni permiso.',
    impactPlain:
      'Si ahí hay documentos, fotos de perfil, comprobantes o cualquier cosa subida por tus usuarios, está accesible desde internet.',
    fixPrompt:
      'En mi Supabase, el bucket `{{bucket}}` está público. Si los archivos son privados, pasalo a privado y cambiá el código para servir los archivos con URLs firmadas (`createSignedUrl`) con vencimiento corto. Mostrame qué archivos del proyecto tengo que tocar. Si el bucket es público a propósito (por ejemplo, imágenes del sitio), decímelo y no lo cambies.',
  },
  {
    id: 'sec.api_route_no_auth',
    pillar: 'security',
    severity: 'high',
    defaultConfidence: 'likely',
    requires: ['code'],
    detects: 'Route handler o server action que toca datos y no verifica sesión ni permisos.',
    howToProve: 'AST: el archivo no llama a getUser/getClaims/auth() antes de operar, y sí llama al cliente de base de datos. Se confirma con una petición sin credenciales contra la app desplegada.',
    titlePlain: 'La dirección {{ruta}} no pregunta quién sos',
    explanationPlain:
      'Tu app expone {{ruta}} ({{archivo}}, línea {{linea}}) y esa dirección trabaja con datos sin verificar antes quién está pidiendo. Cualquiera puede escribirle directamente desde afuera de tu app.',
    impactPlain:
      'Una persona puede pedirle datos o hacerle cambios sin haber iniciado sesión nunca.',
    fixPrompt:
      'La ruta `{{ruta}}` en `{{archivo}}` opera sobre datos sin verificar la sesión. Agregá al principio del handler la verificación del usuario con el cliente de servidor de Supabase, devolvé 401 si no hay sesión, y verificá además que el usuario tenga permiso sobre el recurso que está pidiendo (no alcanza con estar logueado). Mostrame el antes y el después.',
  },
  {
    id: 'sec.security_definer_search_path',
    pillar: 'security',
    severity: 'high',
    defaultConfidence: 'confirmed',
    requires: ['database'],
    detects: 'Función security definer sin set search_path.',
    howToProve: 'pg_proc.prosecdef = true y proconfig sin search_path.',
    titlePlain: 'La función {{funcion}} corre con permisos de administrador sin protección',
    titlePlainAgrupado: '{{n}} funciones tuyas corren con permisos de administrador sin protección',
    explanationPlain:
      'La función {{funcion}} de tu base corre con permisos elevados, pero no tiene fijado el orden en el que busca las tablas. Un usuario puede crear una tabla con el mismo nombre en otro lugar y hacer que la función use la suya.',
    impactPlain:
      'Es una vía conocida para escalar privilegios: alguien con una cuenta común termina ejecutando cosas como administrador de la base.',
    fixPrompt:
      'La función `{{funcion}}` es `security definer` y no fija `search_path`. Agregale `set search_path = \'\'` y calificá todas las referencias a tablas con el esquema completo (`public.tabla`). Mostrame la función corregida completa.',
  },
  {
    id: 'sec.comment_secret',
    pillar: 'security',
    severity: 'high',
    defaultConfidence: 'confirmed',
    requires: ['code'],
    detects: 'Comentario con una clave, contraseña o nota interna dentro de código que llega al navegador.',
    howToProve: 'Escaneo de comentarios con el scanner del compilador, cálculo de alcance (cliente vs servidor) y detección de patrones de secreto. Se cita archivo:línea con el valor enmascarado.',
    titlePlain: 'Hay notas tuyas visibles para cualquier visitante',
    explanationPlain:
      'En {{archivo}}, línea {{linea}}, hay un comentario que llega al navegador de quien visita tu sitio y contiene {{que_contiene}}. Los comentarios en HTML se leen directamente desde "ver código fuente"; los de JavaScript aparecen cuando el sitio se publica sin comprimir o cuando quedan publicados los archivos de depuración.',
    impactPlain:
      'Cualquier visitante curioso puede leer esa nota. Si menciona una clave, una dirección interna o algo que no querías contar, ya está expuesto.',
    fixPrompt:
      'En `{{archivo}}` línea {{linea}} tengo un comentario con información sensible dentro de código que llega al navegador. Borrá ese comentario. Si menciona una clave, decime que tengo que rotarla. Revisá además si hay otros comentarios parecidos en archivos que llevan `\'use client\'` o en archivos `.html` y `.css`.',
  },
  {
    id: 'sec.sourcemaps_public',
    pillar: 'security',
    severity: 'medium',
    defaultConfidence: 'confirmed',
    requires: ['deployed_app'],
    detects: 'Archivos .map accesibles públicamente en producción.',
    howToProve: 'Petición HTTP al .map referenciado desde el bundle: si responde 200, está probado.',
    titlePlain: 'Tu código original está publicado',
    explanationPlain:
      'Tu sitio publica los archivos que permiten reconstruir el código tal como lo escribiste, con nombres de variables, comentarios incluidos y estructura completa. Se descargan igual que cualquier imagen del sitio.',
    impactPlain:
      'Cualquiera puede leer tu código como si tuviera el repositorio, incluyendo los comentarios que dejaste adentro.',
    fixPrompt:
      'Mi app está publicando source maps en producción ({{url}} responde con el archivo). Desactivá la generación de source maps públicos en producción en `next.config.ts` (`productionBrowserSourceMaps: false`) y, si necesito depurar en producción, decime cómo subirlos a un servicio de errores en vez de dejarlos en el sitio.',
  },
  {
    id: 'sec.dangerous_html',
    pillar: 'security',
    severity: 'high',
    defaultConfidence: 'likely',
    requires: ['code'],
    detects: 'dangerouslySetInnerHTML o innerHTML alimentado con datos que vienen del usuario o de la base.',
    howToProve: 'AST: se rastrea el origen del valor. Si viene de props, fetch o base de datos sin sanitizar, se reporta con archivo:línea.',
    titlePlain: 'Un usuario podría inyectar código en tu pantalla',
    explanationPlain:
      'En {{archivo}}, línea {{linea}}, tu app inserta texto de un usuario directamente como si fuera parte de la página. Si alguien escribe código en vez de texto, ese código se ejecuta en el navegador de quien mire esa pantalla.',
    impactPlain:
      'Un usuario malintencionado puede robar la sesión de otros usuarios que abran esa pantalla, o mostrarles cosas que vos no pusiste.',
    fixPrompt:
      'En `{{archivo}}` línea {{linea}} estoy insertando contenido de usuario como HTML crudo. Si el texto no necesita formato, renderizalo como texto plano. Si sí necesita formato (por ejemplo, contenido escrito con un editor enriquecido), decime qué librería de sanitización agregar y aplicala del lado del servidor antes de guardar. Mostrame el antes y el después.',
  },
  {
    id: 'sec.sql_string_concat',
    pillar: 'security',
    severity: 'high',
    defaultConfidence: 'likely',
    requires: ['code'],
    detects: 'Consulta SQL armada concatenando texto que viene del usuario.',
    howToProve: 'AST: template literal o concatenación con variable dentro de una llamada de consulta cruda.',
    titlePlain: 'Una consulta a tu base se arma pegando texto del usuario',
    explanationPlain:
      'En {{archivo}}, línea {{linea}}, la consulta a la base se construye pegando texto que escribió una persona. Si esa persona escribe algo con la forma adecuada, la base ejecuta la orden que ella quiera en vez de la que vos escribiste.',
    impactPlain:
      'Alguien puede leer tablas enteras, o borrarlas, escribiendo texto en un formulario común.',
    fixPrompt:
      'En `{{archivo}}` línea {{linea}} armo una consulta SQL concatenando una variable. Cambiala por una consulta con parámetros (placeholders `$1`, `$2`) o por el query builder de Supabase. Revisá el resto del archivo por si hay más casos y mostrame todos los cambios.',
  },
  {
    id: 'sec.cors_wildcard',
    pillar: 'security',
    severity: 'medium',
    defaultConfidence: 'confirmed',
    requires: ['code', 'deployed_app'],
    detects: 'Access-Control-Allow-Origin: * en rutas que devuelven datos con sesión.',
    howToProve: 'Cabecera en la respuesta real de la app desplegada.',
    titlePlain: 'Cualquier otro sitio puede pedirle datos a tu app',
    explanationPlain:
      'La dirección {{ruta}} responde diciendo que cualquier página de internet puede hablarle. Eso permite que un sitio ajeno haga pedidos en nombre de una persona que tiene sesión abierta en tu app.',
    impactPlain:
      'Un sitio malicioso puede leer datos de tus usuarios mientras ellos navegan, sin que se den cuenta.',
    fixPrompt:
      'La ruta `{{ruta}}` responde con `Access-Control-Allow-Origin: *` y devuelve datos que dependen de la sesión. Cambiala para que solo acepte los dominios de mi app. Mostrame la lista de dominios que estás permitiendo y de dónde la sacaste.',
  },
  {
    id: 'sec.pii_in_logs',
    pillar: 'security',
    severity: 'medium',
    defaultConfidence: 'likely',
    requires: ['code'],
    detects: 'console.log u otro registro que imprime datos personales completos.',
    howToProve: 'AST: la llamada recibe objetos con campos como email, phone, dni, card, address, o el objeto de usuario completo.',
    titlePlain: 'Tus registros guardan datos personales de tus usuarios',
    titlePlainAgrupado: 'Tus registros guardan datos personales en {{n}} lugares',
    explanationPlain:
      'En {{archivo}}, línea {{linea}}, tu app escribe en el registro del servidor datos personales completos de una persona. Esos registros los ve cualquiera que tenga acceso al panel de tu hosting.',
    impactPlain:
      'Datos de tus usuarios quedan copiados en un lugar donde no los estás cuidando ni borrando.',
    fixPrompt:
      'En `{{archivo}}` línea {{linea}} estoy registrando datos personales. Dejá solo el identificador que necesito para depurar y sacá el resto, o enmascaralo. Revisá el archivo completo buscando otros casos.',
  },
  {
    id: 'sec.no_rate_limit',
    pillar: 'security',
    severity: 'medium',
    defaultConfidence: 'to_review',
    requires: ['code'],
    detects: 'Rutas de login, registro, recuperación de contraseña o envío de mensajes sin ningún tope de intentos.',
    howToProve: 'Ausencia de cualquier mecanismo de límite en el archivo o en el proxy. Confianza media a propósito: puede estar resuelto en la plataforma.',
    titlePlain: 'Se puede probar contraseñas sin límite en {{ruta}}',
    titlePlainAgrupado: 'Se pueden probar contraseñas sin límite en {{n}} lugares',
    explanationPlain:
      'La dirección {{ruta}} no parece tener ningún tope de intentos. Un programa puede probar miles de contraseñas por minuto, o disparar miles de mails de recuperación.',
    impactPlain:
      'Cuentas adivinadas por fuerza bruta, o tu servicio de correo bloqueado por abuso.',
    fixPrompt:
      'La ruta `{{ruta}}` no tiene tope de intentos. Agregá un límite por dirección IP y por cuenta. Decime primero qué opciones tengo en el hosting que estoy usando antes de agregar una dependencia nueva. Si Supabase ya aplica un límite para este caso, decímelo y no agregues nada.',
  },
]

/* ─────────────────── Pilar 2 · Funciona completo ─────────────────────── */

const COMPLETITUD: CatalogEntry[] = [
  {
    id: 'cmp.no_account_deletion',
    pillar: 'completeness',
    severity: 'critical',
    defaultConfidence: 'confirmed',
    requires: ['code', 'deployed_app', 'browser_run'],
    detects: 'No existe ningún flujo para que el usuario borre su cuenta.',
    howToProve: 'El agente entra a la app, busca la opción en cuenta/ajustes/perfil y no la encuentra. Queda grabado.',
    titlePlain: 'Tus usuarios no pueden borrar su cuenta',
    explanationPlain:
      'Recorrimos tu app buscando la forma de que una persona elimine su cuenta y sus datos. No existe. Mirá la grabación: entramos a la sección de cuenta y no hay ninguna opción.',
    impactPlain:
      'Apple rechaza las apps que no tienen borrado de cuenta desde 2022, y Google Play desde fines de 2023. Además es lo primero que te van a pedir si alguien reclama por sus datos.',
    fixPrompt:
      'Mi app no tiene forma de que el usuario borre su cuenta. Agregala:\n1. Una opción "Eliminar mi cuenta" en la pantalla de cuenta, visible, no escondida.\n2. Un diálogo de confirmación que explique en una frase qué se borra y que la acción no se puede deshacer.\n3. Del lado del servidor: borrar de verdad los datos del usuario en todas las tablas relacionadas y llamar a `auth.admin.deleteUser`. Mostrame la lista de tablas que vas a tocar antes de escribir el código.\n4. Cerrar la sesión y redirigir a una pantalla que confirme que se borró.\nNo uses borrado lógico disfrazado de borrado: si la promesa es eliminar, se elimina.',
    demoTaskId: 'delete_account',
  },
  {
    id: 'cmp.no_password_reset',
    pillar: 'completeness',
    severity: 'high',
    defaultConfidence: 'confirmed',
    requires: ['code', 'deployed_app', 'browser_run'],
    detects: 'No hay flujo de recuperación de contraseña.',
    howToProve: 'El agente busca el enlace en la pantalla de inicio de sesión y prueba el flujo completo. Queda grabado.',
    titlePlain: 'Quien olvide la contraseña queda afuera para siempre',
    explanationPlain:
      'En tu pantalla de inicio de sesión no hay forma de recuperar la contraseña. Lo probamos: no existe el enlace, y tampoco la pantalla.',
    impactPlain:
      'Cada persona que olvide su contraseña es un usuario perdido, y un mail que te va a llegar a vos para resolverlo a mano.',
    fixPrompt:
      'Mi app no tiene recuperación de contraseña. Agregá el flujo completo con Supabase Auth:\n1. Enlace "¿Olvidaste tu contraseña?" en la pantalla de inicio de sesión.\n2. Pantalla donde se pide el mail y se llama a `resetPasswordForEmail` con la URL de retorno correcta.\n3. Pantalla de nueva contraseña que maneje el enlace del mail.\n4. Mensajes claros en cada paso, incluido el caso "si ese mail existe, te llega un correo" —sin revelar si la cuenta existe.\nMostrame las tres pantallas y el texto de cada mensaje antes de escribir el código.',
    demoTaskId: 'password_reset',
  },
  {
    id: 'cmp.no_logout',
    pillar: 'completeness',
    severity: 'high',
    defaultConfidence: 'confirmed',
    requires: ['code', 'deployed_app', 'browser_run'],
    detects: 'No hay forma visible de cerrar sesión.',
    howToProve: 'El agente inicia sesión y busca la opción de salir. Queda grabado.',
    titlePlain: 'No se puede cerrar sesión',
    explanationPlain:
      'Entramos a tu app con una cuenta y no encontramos ninguna forma de salir. Mirá la grabación.',
    impactPlain:
      'Quien use tu app en una computadora compartida deja la sesión abierta para el que venga después.',
    fixPrompt:
      'Mi app no tiene botón de cerrar sesión. Agregalo en el menú de cuenta del encabezado: llamá a `supabase.auth.signOut()`, limpiá el estado del cliente y redirigí a la pantalla de inicio. Verificá también que después de salir no se pueda volver atrás con el botón del navegador y ver datos de la sesión anterior.',
    demoTaskId: 'logout',
  },
  {
    id: 'cmp.no_email_verification',
    pillar: 'completeness',
    severity: 'medium',
    defaultConfidence: 'likely',
    requires: ['code', 'deployed_app', 'browser_run'],
    detects: 'El registro no verifica que el correo exista.',
    howToProve: 'El agente se registra con un correo inventado y llega a usar la app sin confirmar nada.',
    titlePlain: 'Cualquiera se registra con un mail que no es suyo',
    explanationPlain:
      'Nos registramos con una dirección de correo inventada y entramos a tu app sin tener que confirmar nada.',
    impactPlain:
      'Cuentas falsas, y personas que se registran con el mail de otro y después no pueden recuperar el acceso.',
    fixPrompt:
      'Mi app deja registrarse sin confirmar el correo. Activá la confirmación por mail en Supabase Auth, agregá una pantalla de "revisá tu correo" después del registro, y bloqueá el acceso a las pantallas privadas mientras el correo no esté confirmado. Decime qué configuración tengo que cambiar en el panel de Supabase además del código.',
    demoTaskId: 'signup',
  },
  {
    id: 'cmp.destructive_no_confirm',
    pillar: 'completeness',
    severity: 'high',
    defaultConfidence: 'confirmed',
    requires: ['code'],
    detects: 'Botón que borra o cancela algo y ejecuta sin pedir confirmación.',
    howToProve: 'AST: onClick que llama a delete/remove/cancel sin diálogo previo. Se cita archivo:línea.',
    titlePlain: 'El botón "{{boton}}" borra sin preguntar',
    titlePlainAgrupado: '{{n}} botones de tu app borran sin preguntar',
    explanationPlain:
      'En {{archivo}}, línea {{linea}}, el botón "{{boton}}" ejecuta un borrado apenas se hace clic. No hay confirmación ni forma de deshacer.',
    impactPlain:
      'Un clic accidental y el dato desaparece. Es de las cosas que más bronca generan en el usuario.',
    fixPrompt:
      'El botón "{{boton}}" en `{{archivo}}` línea {{linea}} borra sin confirmar. Agregá un diálogo de confirmación que diga en una frase qué se va a borrar y que no se puede deshacer, con el botón de confirmar en rojo y el de cancelar como opción por defecto. Si el elemento es importante, pedí que se escriba el nombre para confirmar.',
  },
  {
    id: 'cmp.no_loading_state',
    pillar: 'completeness',
    severity: 'medium',
    defaultConfidence: 'confirmed',
    requires: ['code'],
    detects: 'Pantalla que espera datos y no muestra nada mientras tanto.',
    howToProve: 'Ruta con carga de datos sin loading.tsx, sin Suspense y sin estado de carga propio. Se cita archivo.',
    titlePlain: 'La pantalla {{ruta}} se queda en blanco mientras carga',
    titlePlainAgrupado: '{{n}} pantallas tuyas se quedan en blanco mientras cargan',
    explanationPlain:
      'La pantalla {{ruta}} pide datos al servidor y, mientras los espera, no muestra absolutamente nada. Para quien la usa, la app parece colgada.',
    impactPlain:
      'La gente piensa que se rompió y vuelve atrás, o recarga la página varias veces.',
    fixPrompt:
      'La pantalla `{{ruta}}` no muestra nada mientras carga. Agregá un `loading.tsx` con esqueletos que tengan la forma del contenido real (no un spinner centrado). Si el contenido es parcial, envolvé solo la parte lenta en `<Suspense>` para que el resto aparezca enseguida.',
  },
  {
    id: 'cmp.no_empty_state',
    pillar: 'completeness',
    severity: 'medium',
    defaultConfidence: 'confirmed',
    requires: ['code'],
    detects: 'Lista que no contempla el caso de cero elementos.',
    howToProve: 'AST: .map sobre un arreglo sin rama para longitud cero. Se cita archivo:línea.',
    titlePlain: 'La pantalla {{ruta}} está vacía la primera vez que entrás',
    titlePlainAgrupado: '{{n}} pantallas tuyas se ven vacías la primera vez que entrás',
    explanationPlain:
      'En {{archivo}}, línea {{linea}}, se dibuja una lista sin contemplar que todavía no haya nada. Un usuario nuevo entra y ve una pantalla vacía sin explicación.',
    impactPlain:
      'El primer minuto de uso es el que decide si alguien se queda. Una pantalla vacía sin instrucciones es donde más gente abandona.',
    fixPrompt:
      'En `{{archivo}}` línea {{linea}} tengo una lista sin estado vacío. Agregá un bloque para cuando no hay elementos: un título que explique qué va a aparecer ahí, una línea de contexto y el botón de la acción principal para crear el primero.',
  },
  {
    id: 'cmp.no_error_state',
    pillar: 'completeness',
    severity: 'medium',
    defaultConfidence: 'confirmed',
    requires: ['code'],
    detects: 'Errores atrapados y descartados en silencio, o rutas sin error.tsx.',
    howToProve: 'AST: catch vacío o que solo hace console.log; ruta sin error.tsx. Se cita archivo:línea.',
    titlePlain: 'Cuando algo falla, tu app no lo dice',
    titlePlainAgrupado: 'Cuando algo falla, tu app no lo dice en {{n}} lugares',
    explanationPlain:
      'En {{archivo}}, línea {{linea}}, si la operación falla el error se descarta sin avisar. Para quien está del otro lado, el botón simplemente no hace nada.',
    impactPlain:
      'La gente hace clic varias veces, cree que guardó algo que no se guardó, y vos te enterás cuando te escriben.',
    fixPrompt:
      'En `{{archivo}}` línea {{linea}} estoy descartando un error en silencio. Mostralo: un mensaje entendible para el usuario (no el error técnico), la opción de reintentar, y el registro del error real del lado del servidor. Agregá también un `error.tsx` en esa ruta para los fallos inesperados.',
  },
  {
    id: 'cmp.form_no_validation',
    pillar: 'completeness',
    severity: 'medium',
    defaultConfidence: 'likely',
    requires: ['code'],
    detects: 'Formulario que envía al servidor sin validar del lado del servidor.',
    howToProve: 'AST: la acción recibe FormData y la usa sin validación de esquema. Se cita archivo:línea.',
    titlePlain: 'El formulario de {{ruta}} acepta cualquier cosa',
    explanationPlain:
      'El formulario de {{ruta}} manda lo que sea al servidor sin revisarlo. La validación que se hace en el navegador no cuenta: se saltea en dos clics.',
    impactPlain:
      'Datos rotos o inventados guardados en tu base, y errores que aparecen después en otras pantallas.',
    fixPrompt:
      'El formulario de `{{ruta}}` (`{{archivo}}`) no valida en el servidor. Agregá validación con `zod` en la server action o el route handler, devolvé los errores por campo, y mostralos al lado de cada campo. La validación del navegador se queda, pero como comodidad, no como control.',
  },
  {
    id: 'cmp.form_no_labels',
    pillar: 'completeness',
    severity: 'low',
    defaultConfidence: 'confirmed',
    requires: ['code'],
    detects: 'Campo de formulario sin etiqueta asociada.',
    howToProve: 'AST: input sin label asociado ni aria-label. Se cita archivo:línea.',
    titlePlain: 'Hay campos sin nombre en {{ruta}}',
    titlePlainAgrupado: 'Hay campos sin nombre en {{n}} pantallas tuyas',
    explanationPlain:
      'En {{archivo}}, línea {{linea}}, hay campos que solo tienen texto de ejemplo adentro. Cuando la persona empieza a escribir, ese texto desaparece y ya no sabe qué iba ahí. Para quien usa lector de pantalla, el campo directamente no tiene nombre.',
    impactPlain:
      'Formularios más difíciles de completar y errores de carga evitables.',
    fixPrompt:
      'En `{{archivo}}` línea {{linea}} hay campos sin etiqueta. Agregá un `<label>` asociado por `htmlFor`/`id` a cada campo. El texto de ejemplo se queda como ayuda, no como reemplazo de la etiqueta.',
  },
  {
    id: 'cmp.a11y_axe',
    pillar: 'completeness',
    severity: 'medium',
    defaultConfidence: 'confirmed',
    requires: ['deployed_app', 'browser_run'],
    detects: 'Problemas de accesibilidad medibles automáticamente.',
    howToProve: 'axe-core sobre las pantallas principales. Se reporta la CANTIDAD de problemas, nunca un porcentaje de cumplimiento.',
    titlePlain: 'Encontramos {{cantidad}} problemas de accesibilidad',
    explanationPlain:
      'Revisamos {{pantallas}} pantallas de tu app con una herramienta automática y encontramos {{cantidad}} problemas concretos: {{resumen}}. Son los que se pueden detectar sin intervención humana.',
    impactPlain:
      'Personas que usan lector de pantalla o navegan con el teclado no pueden completar partes de tu app. Ojo: una revisión automática detecta menos de la mitad de los problemas reales, así que esto es un piso, no un puntaje.',
    fixPrompt:
      'Una revisión automática encontró estos problemas de accesibilidad en mi app: {{detalle}}. Arreglalos uno por uno empezando por los de contraste y los de campos sin nombre. Después de cada arreglo, decime qué cambió y por qué. No me des un puntaje de cumplimiento: no significa nada.',
  },
  {
    id: 'cmp.placeholder_left',
    pillar: 'completeness',
    severity: 'medium',
    defaultConfidence: 'confirmed',
    requires: ['code'],
    detects: 'Texto de relleno olvidado en pantallas de producción.',
    howToProve: 'Coincidencia con "lorem ipsum", "TODO", "Tu texto acá", "Coming soon", "Example.com", "[nombre]". Se cita archivo:línea.',
    titlePlain: 'Quedó texto de relleno sin reemplazar',
    titlePlainAgrupado: 'Quedó texto de relleno sin reemplazar en {{n}} lugares',
    explanationPlain:
      'En {{archivo}}, línea {{linea}}, quedó un texto de ejemplo que nunca se reemplazó: "{{texto}}". Se ve en {{ruta}}.',
    impactPlain:
      'Es lo primero que nota alguien que entra por primera vez, y le baja la confianza a todo lo demás.',
    fixPrompt:
      'En `{{archivo}}` línea {{linea}} quedó texto de relleno: "{{texto}}". Buscá todos los casos parecidos en el proyecto y hacé una lista de qué texto falta escribir en cada lugar. No los inventes vos: mostrame la lista para que los escriba yo.',
  },
  {
    id: 'cmp.broken_links',
    pillar: 'completeness',
    severity: 'medium',
    defaultConfidence: 'confirmed',
    requires: ['code', 'deployed_app'],
    detects: 'Enlaces internos que apuntan a rutas inexistentes.',
    howToProve: 'Cruce entre los href del código y las rutas reales del proyecto, más verificación HTTP en la app desplegada.',
    titlePlain: 'Hay {{cantidad}} enlaces que no llevan a ningún lado',
    explanationPlain:
      'Encontramos {{cantidad}} enlaces internos que apuntan a pantallas que no existen. Por ejemplo, el que dice "{{ejemplo}}" en {{archivo}}.',
    impactPlain:
      'Quien haga clic ahí ve un error. En una app nueva, alcanza para que la persona se vaya.',
    fixPrompt:
      'Tengo enlaces internos rotos: {{detalle}}. Para cada uno decime si falta crear la pantalla o si el enlace está mal escrito, y arreglalo. Al final agregá una página de error 404 propia con un mensaje claro y un botón para volver al inicio.',
  },
  {
    id: 'cmp.no_404_page',
    pillar: 'completeness',
    severity: 'low',
    defaultConfidence: 'confirmed',
    requires: ['code'],
    detects: 'No existe not-found.tsx.',
    howToProve: 'Ausencia del archivo en el árbol de rutas.',
    titlePlain: 'No hay pantalla para direcciones que no existen',
    explanationPlain:
      'Si alguien escribe mal una dirección de tu app, ve la pantalla de error genérica del sistema en vez de una tuya.',
    impactPlain: 'Se rompe la sensación de que la app está terminada.',
    fixPrompt:
      'Mi app no tiene página 404 propia. Creá `app/not-found.tsx` con un mensaje breve y humano, y un botón para volver al inicio. Que use el mismo diseño que el resto de la app.',
  },
  {
    id: 'cmp.horizontal_overflow',
    pillar: 'completeness',
    severity: 'medium',
    defaultConfidence: 'confirmed',
    requires: ['deployed_app', 'browser_run'],
    detects: 'La página se desplaza horizontalmente en pantalla de celular.',
    howToProve: 'A 375 px de ancho, scrollWidth > clientWidth en el body. Queda grabado.',
    titlePlain: 'En el celular la pantalla {{ruta}} se sale para el costado',
    explanationPlain:
      'Abrimos {{ruta}} en un celular y la página se puede arrastrar para la derecha: hay contenido que no entra. Mirá la grabación.',
    impactPlain:
      'La mayoría de tus visitas van a ser desde el celular. Ahí la app se ve rota.',
    fixPrompt:
      'La pantalla `{{ruta}}` tiene desplazamiento horizontal en celular (a 375 px de ancho). Encontrá el elemento que se sale —suele ser una tabla, una imagen sin `max-width`, o un contenedor con ancho fijo— y arreglalo. Después verificá a 375, 768 y 1280 px que no queda ninguno.',
  },
  {
    id: 'cmp.flow_blocked',
    pillar: 'completeness',
    severity: 'critical',
    defaultConfidence: 'confirmed',
    requires: ['deployed_app', 'browser_run'],
    detects: 'El agente no pudo completar el flujo principal de la app.',
    howToProve: 'Grabación del intento, con el paso exacto donde se trabó.',
    titlePlain: 'No pudimos completar {{flujo}}',
    explanationPlain:
      'Intentamos hacer {{flujo}} en tu app como lo haría un usuario nuevo y nos trabamos en {{paso}}. Mirá la grabación: ahí se ve exactamente qué pasó.',
    impactPlain:
      'Si nosotros no pudimos, un usuario tampoco. Este es el camino por el que llega tu dinero.',
    fixPrompt:
      'Mi app se traba cuando intento {{flujo}}. El paso exacto donde falla es: {{paso}}. Esto fue lo que pasó: {{detalle}}. Encontrá la causa antes de proponer un arreglo, mostrámela, y recién ahí arreglalo.',
    demoTaskId: 'primary_flow',
  },
]

/* ─────────────── Pilar 3 · Listo para publicar ───────────────────────── */

const HIGIENE: CatalogEntry[] = [
  {
    id: 'sto.no_account_deletion',
    pillar: 'store_hygiene',
    severity: 'critical',
    defaultConfidence: 'confirmed',
    requires: ['code', 'deployed_app', 'browser_run'],
    detects: 'Mismo hallazgo que cmp.no_account_deletion, visto desde la tienda.',
    howToProve: 'Grabación del agente buscando la opción.',
    titlePlain: 'Te van a rechazar la app por no poder borrar la cuenta',
    explanationPlain:
      'Tu app no tiene forma de que el usuario elimine su cuenta. Es un requisito de la App Store desde junio de 2022 y de Google Play desde diciembre de 2023: si la app permite crear una cuenta, tiene que permitir borrarla desde adentro.',
    impactPlain:
      'Es motivo de rechazo directo en la revisión. No es una interpretación: está escrito en las reglas de ambas tiendas.',
    fixPrompt:
      'Necesito agregar borrado de cuenta a mi app porque sin eso me la rechazan en la App Store y en Google Play. Implementá el flujo completo: opción visible en la pantalla de cuenta, confirmación clara, borrado real de los datos del usuario en todas las tablas y en `auth.users`, cierre de sesión y pantalla de confirmación. Mostrame primero la lista de tablas que vas a tocar.',
    demoTaskId: 'delete_account',
  },
  {
    id: 'sto.trackers_before_consent',
    pillar: 'store_hygiene',
    severity: 'high',
    defaultConfidence: 'confirmed',
    requires: ['deployed_app', 'browser_run'],
    detects: 'Se disparan cookies o pedidos a servicios de seguimiento antes de que el usuario acepte nada.',
    howToProve: 'Se carga la app en un navegador limpio y se registran las peticiones de red y las cookies antes de tocar el banner. Queda grabado.',
    titlePlain: 'Tu app rastrea antes de pedir permiso',
    explanationPlain:
      'Abrimos tu app en un navegador limpio y, antes de aceptar nada, ya se dispararon {{cantidad}} pedidos a servicios de seguimiento ({{servicios}}) y se guardaron cookies. Mirá la grabación.',
    impactPlain:
      'Es la infracción de consentimiento que más sanciones acumula en Europa, y la más fácil de detectar desde afuera. Esto es lo que un revisor o un regulador podría marcar; no es asesoramiento legal.',
    fixPrompt:
      'Mi app dispara estos servicios de seguimiento antes de que el usuario acepte: {{servicios}}. Cambialo para que ninguno cargue hasta que la persona acepte explícitamente. El banner tiene que tener "Aceptar" y "Rechazar" con el mismo peso visual, y rechazar tiene que funcionar de verdad. Mostrame qué scripts vas a mover y cómo los vas a cargar después del consentimiento.',
    demoTaskId: 'cookie_banner',
  },
  {
    id: 'sto.no_cookie_banner',
    pillar: 'store_hygiene',
    severity: 'medium',
    defaultConfidence: 'confirmed',
    requires: ['deployed_app', 'browser_run'],
    detects: 'Hay trackers y no hay ningún aviso de consentimiento.',
    howToProve: 'Trackers detectados en la red más ausencia de cualquier banner en el DOM.',
    titlePlain: 'Hay seguimiento pero no hay aviso',
    explanationPlain:
      'Tu app usa {{servicios}} para registrar lo que hacen los visitantes, y no muestra ningún aviso al respecto.',
    impactPlain:
      'Es lo primero que mira alguien que revisa el tema. Esto es lo que un revisor o un regulador podría marcar; no es asesoramiento legal.',
    fixPrompt:
      'Mi app usa {{servicios}} y no tiene aviso de consentimiento. Agregá uno que: no cargue los scripts hasta que la persona decida, ofrezca aceptar y rechazar con el mismo peso, recuerde la decisión, y permita cambiarla después desde un enlace en el pie. Escribilo en español claro, sin párrafos legales largos.',
  },
  {
    id: 'sto.no_privacy_page',
    pillar: 'store_hygiene',
    severity: 'high',
    defaultConfidence: 'confirmed',
    requires: ['code', 'deployed_app'],
    detects: 'No existe una página de política de privacidad accesible.',
    howToProve: 'No hay ruta /privacy, /privacidad ni equivalente, y no hay enlace en el pie.',
    titlePlain: 'No tenés página de privacidad',
    explanationPlain:
      'Tu app pide datos a las personas y no tiene ninguna página que explique qué hace con ellos. Buscamos las direcciones habituales y el pie de página.',
    impactPlain:
      'Las dos tiendas piden el enlace a la política de privacidad para publicar. Sin eso no se puede ni empezar el trámite.',
    fixPrompt:
      'Mi app no tiene política de privacidad. Creá la página `/privacidad` y enlazala desde el pie. Antes de escribirla, hacé una lista de: qué datos recolecta mi app realmente (mirá el código y las tablas), qué servicios de terceros usa, y cuánto tiempo se guardan las cosas. Mostrame esa lista primero; el texto lo reviso yo antes de publicarlo. No copies una plantilla genérica que diga cosas que mi app no hace.',
    demoTaskId: 'privacy_terms',
  },
  {
    id: 'sto.no_terms_page',
    pillar: 'store_hygiene',
    severity: 'medium',
    defaultConfidence: 'confirmed',
    requires: ['code', 'deployed_app'],
    detects: 'No existe una página de términos y condiciones.',
    howToProve: 'No hay ruta /terms, /terminos ni equivalente, y no hay enlace en el pie.',
    titlePlain: 'No tenés términos y condiciones',
    explanationPlain:
      'No encontramos ninguna página con las condiciones de uso de tu app, ni enlace en el pie.',
    impactPlain:
      'Se pide para publicar en las tiendas, y para cobrar con la mayoría de las pasarelas de pago.',
    fixPrompt:
      'Mi app no tiene términos y condiciones. Creá `/terminos` y enlazala desde el pie, con el mismo diseño que el resto. Preguntame primero los datos que no podés saber leyendo el código: razón social, país, cómo se cancela una suscripción, y a dónde se escribe para reclamar.',
  },
  {
    id: 'sto.third_party_data_sharing',
    pillar: 'store_hygiene',
    severity: 'medium',
    defaultConfidence: 'likely',
    requires: ['code', 'deployed_app', 'browser_run'],
    detects: 'Servicios externos que reciben datos de los usuarios y no están declarados en ningún lado.',
    howToProve: 'Dominios de terceros en las peticiones de red, cruzados con lo que dice la página de privacidad si existe.',
    titlePlain: 'Tu app le manda datos a {{cantidad}} servicios que no están declarados',
    explanationPlain:
      'Detectamos que tu app envía información a {{servicios}}. Tu página de privacidad no los menciona.',
    impactPlain:
      'En la ficha de la tienda hay que declarar qué datos se recolectan y con quién se comparten. Declarar de menos es motivo de rechazo. Esto es lo que un revisor podría marcar; no es asesoramiento legal.',
    fixPrompt:
      'Mi app manda datos a estos servicios: {{servicios}}. Para cada uno, decime qué dato le está mandando exactamente y desde qué archivo. Después actualizá mi página de privacidad para que los mencione, y armame la lista que tengo que completar en la ficha de la App Store y de Google Play.',
  },
  {
    id: 'sto.no_deletion_contact',
    pillar: 'store_hygiene',
    severity: 'low',
    defaultConfidence: 'likely',
    requires: ['code'],
    detects: 'No hay ninguna forma de contacto para pedidos sobre datos personales.',
    howToProve: 'Ausencia de correo de contacto o formulario en las páginas legales.',
    titlePlain: 'No hay a dónde escribir para pedir la baja de datos',
    explanationPlain:
      'No encontramos ningún correo ni formulario de contacto para que una persona pida que borres sus datos.',
    impactPlain:
      'Google Play pide una vía de solicitud de borrado de datos para publicar. Esto es lo que un revisor podría marcar; no es asesoramiento legal.',
    fixPrompt:
      'Mi app no tiene forma de contacto para pedidos sobre datos personales. Agregá un correo de contacto visible en la página de privacidad y en el pie. Preguntame qué dirección querés usar.',
  },
]

export const CATALOGO: CatalogEntry[] = [...SEGURIDAD, ...COMPLETITUD, ...HIGIENE]

export const CATALOGO_POR_ID = new Map(CATALOGO.map((entry) => [entry.id, entry]))

export function entrada(id: string): CatalogEntry {
  const found = CATALOGO_POR_ID.get(id)
  if (!found) throw new Error(`No existe el hallazgo "${id}" en el catálogo`)
  return found
}

/** Completa los marcadores {{...}} con los valores reales de la evidencia. */
export function completar(texto: string, valores: Record<string, string | number>): string {
  return texto.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    const value = valores[key]
    return value === undefined ? match : String(value)
  })
}
