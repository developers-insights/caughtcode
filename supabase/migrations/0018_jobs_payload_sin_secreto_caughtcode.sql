-- ============================================================================
-- caughtcode · 0018 · Borrar la conexión del cliente de los payloads que ya existen
-- ----------------------------------------------------------------------------
-- LO QUE FALTABA
-- --------------
-- La 0017 cortó la LECTURA de `jobs_caughtcode.payload` desde el navegador, y
-- `src/server/ingest/conexion.ts` hizo que el `databaseUrl` no se ESCRIBA más
-- ahí. Ninguna de las dos toca las filas que ya estaban: el secreto sigue en
-- claro en la base, y en todos los backups que se tomen de acá en adelante.
--
-- Un revoke es una decisión de hoy que se puede revertir mañana sin querer (un
-- `grant select on table ... to authenticated` de más y vuelve a estar
-- expuesto). El dato borrado no vuelve. Por eso hacen falta las tres cosas.
--
-- POR QUÉ ESTE `UPDATE` VA EN UNA MIGRACIÓN Y NO EN UN SCRIPT SUELTO
-- ------------------------------------------------------------------
-- Un script hay que acordarse de correrlo, y hay que acordarse en CADA base:
-- producción, la de pruebas, la que alguien levante mañana desde
-- `supabase/migrations` para reproducir un bug. Un script que se corre en una
-- sola de esas deja el agujero abierto en las demás, sin que nada lo diga.
-- Acá el borrado viaja pegado al cambio que lo hace seguro (la 0017 y el código
-- que dejó de escribir el secreto) y se aplica en el mismo orden, siempre.
-- Además queda en el historial: dentro de seis meses, la pregunta "¿esto se
-- limpió?" se contesta mirando `supabase_migrations`, no la memoria de alguien.
--
-- POR QUÉ ES SEGURO PARA LOS TRABAJOS QUE TODAVÍA NO CORRIERON
-- ------------------------------------------------------------
-- Verificado leyendo los tres consumidores antes de escribir esto:
--
--   * `index_code`  → `payload.databaseUrl ?? await leerConexionBase({...})`
--     (`src/server/analysis/handlers.ts`).
--   * `run_checks`  → la misma línea (`src/server/checks/handlers.ts`).
--   * `run_browser_agent` → nunca la usó; solo la copiaba de un payload a otro.
--   * `ingest_repo` → ya no la descifra ni la escribe (ver el comentario de
--     `IndexCodePayload` en `src/server/ingest/handlers.ts`).
--
-- O sea que sacarle la clave al payload manda a los dos que la necesitan por el
-- camino de `leerConexionBase()`, que la lee cifrada de
-- `project_connections_caughtcode` (provider `supabase`) y la descifra en
-- memoria. Esa tabla es el ORIGEN del valor que se había copiado al payload —lo
-- escribe el onboarding con `encryptSecret()`—, así que no se pierde nada: se
-- deja de tener dos copias, una de ellas en claro.
--
-- Y si esa fila no estuviera, `leerConexionBase()` devuelve `null` con un aviso
-- en el log y la revisión sigue sin los chequeos de base, que quedan marcados
-- como no revisados. Nunca falla en silencio.
--
-- IDEMPOTENTE
-- -----------
-- El `where` mira si la clave está. Corrida dos veces, la segunda no toca nada.
-- No se filtra por estado del trabajo a propósito: el histórico (`succeeded`,
-- `failed`) es justamente el que más filas con el secreto tiene, y esas ya no
-- las va a leer nadie.
-- ============================================================================

-- `jsonb_exists(...)` y no el operador `?`: el signo de pregunta es placeholder
-- de parámetro en varios clientes, y esta migración tiene que poder aplicarse
-- por cualquiera de ellos sin que alguien la reescriba a las apuradas.
update public.jobs_caughtcode
set payload = payload - 'databaseUrl'
where jsonb_exists(payload, 'databaseUrl');

-- El comentario de la 0017 hablaba en presente de un secreto que ya no está.
comment on column public.jobs_caughtcode.payload is
  'Entrada del trabajo. PUEDE CONTENER SECRETOS DEL CLIENTE: no la exponga a authenticated. El databaseUrl salió de acá (código en src/server/ingest/conexion.ts, lectura revocada en 0017, filas viejas limpiadas en 0018). Si agregás una lectura desde el navegador, NO incluyas esta columna.';
