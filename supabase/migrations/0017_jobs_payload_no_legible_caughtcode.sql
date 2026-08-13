-- ============================================================================
-- caughtcode · 0017 · La conexión a la base del cliente deja de ser legible
-- ----------------------------------------------------------------------------
-- EL AGUJERO, CON EVIDENCIA
-- -------------------------
-- `jobs_caughtcode.payload` guarda el `databaseUrl` del proyecto **en claro**
-- (lo encola `index_code` y viaja hasta `run_checks`). La policy
-- `jobs_select_caughtcode` (migración 0005) da SELECT a todo miembro de la
-- organización:
--
--     create policy jobs_select_caughtcode on public.jobs_caughtcode
--       for select to authenticated
--       using ( public.is_org_member_caughtcode(org_id) );
--
-- Y RLS filtra FILAS, no COLUMNAS. Comprobado contra la base: `authenticated`
-- tiene SELECT sobre toda la tabla, columna `payload` incluida. O sea que el
-- miembro con el rol más bajo de la organización hace, con la clave anon que
-- viaja en el bundle del navegador:
--
--     GET /rest/v1/jobs_caughtcode?select=payload
--
-- y se lleva la cadena de conexión a la base de datos del cliente. Es la MISMA
-- credencial que `project_connections_caughtcode` guarda cifrada con
-- `ENCRYPTION_KEY`: la copia en claro del payload anula ese cifrado por
-- completo.
--
-- QUÉ HACE ESTE ARCHIVO Y QUÉ NO
-- ------------------------------
-- Esto es la MITIGACIÓN INMEDIATA: cortar la lectura. El arreglo de fondo
-- —sacar el secreto del payload y que el handler lo lea descifrado de
-- `project_connections_caughtcode`— va aparte, en
-- `src/server/{ingest,analysis,checks}/handlers.ts`. Los dos hacen falta: sin
-- este revoke, cualquier payload futuro que vuelva a traer un secreto queda
-- expuesto de nuevo; sin el otro, el secreto sigue en claro en la base y en
-- cualquier backup.
--
-- POR QUÉ NO ALCANZA `revoke select (payload) ...`
-- ------------------------------------------------
-- Postgres no puede revocar una columna de un privilegio otorgado a nivel
-- TABLA: `revoke select (payload) on ... from authenticated` sobre un grant de
-- tabla entera contesta `WARNING: no privileges could be revoked for column
-- "payload"` y no cambia nada. Hay que revocar el SELECT de tabla y volver a
-- otorgarlo columna por columna, nombrando las 15 que sí se pueden leer.
--
-- Verificado antes de escribir esto: la única lectura de `jobs_caughtcode` con
-- sesión de usuario en todo el árbol es
-- `src/app/(app)/proyectos/[id]/hallazgos/data.ts`, que pide
-- `id, kind, status, last_error, created_at, updated_at` y filtra por
-- `project_id` ordenando por `created_at`. Todas están en la lista de abajo
-- (filtrar y ordenar por una columna también exige SELECT sobre ella).
-- `src/components/**` no toca la tabla. El worker no se ve afectado:
-- `service_role` tiene `grant all` desde 0010 y BYPASSRLS.
--
-- Aditiva salvo el reemplazo declarado del grant de SELECT.
-- ============================================================================

-- `anon` no necesita ver nada de esta tabla: la policy de lectura es solo para
-- `authenticated`. Se lo nombra igual porque el default privilege de Supabase se
-- lo dio a nombre propio y `revoke ... from public` no lo alcanza.
revoke select on table public.jobs_caughtcode from anon;

-- El de tabla entera se va; vuelve columna por columna, sin `payload`.
revoke select on table public.jobs_caughtcode from authenticated;

grant select (
  id,
  org_id,
  project_id,
  analysis_run_id,
  kind,
  status,
  -- `payload` NO. Es el que trae el databaseUrl del cliente en claro.
  attempts,
  max_attempts,
  last_error,
  stage,
  progress,
  lease_until,
  run_after,
  created_at,
  updated_at
) on table public.jobs_caughtcode to authenticated;

comment on column public.jobs_caughtcode.payload is
  'Entrada del trabajo. PUEDE CONTENER SECRETOS DEL CLIENTE (hoy: databaseUrl en claro). Solo service_role puede leerla: ver migración 0017. Si agregás una lectura desde el navegador, NO la incluyas.';
