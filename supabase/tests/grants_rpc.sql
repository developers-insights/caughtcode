-- ============================================================================
-- caughtcode · Ninguna función nuestra contesta sin sesión
-- ----------------------------------------------------------------------------
-- La clave `anon` viaja en el bundle del navegador: es pública por diseño.
-- Cualquier función con EXECUTE para `anon` es un endpoint abierto a internet en
-- POST /rest/v1/rpc/<nombre>. La migración 0014 cerró once que lo estaban; esto
-- existe para que no vuelva a pasar sin que nos enteremos.
--
-- Es de SOLO LECTURA y termina en rollback. Se puede correr contra cualquier
-- base, incluida la de producción:
--
--     psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/grants_rpc.sql
--
-- Si falla, imprime exactamente qué función quedó abierta.
--
-- Por qué hace falta un test y no alcanza con revisarlo al escribir la migración:
-- Supabase trae `alter default privileges in schema public grant all on functions
-- to anon, authenticated, service_role`. Cada función NUEVA del schema `public`
-- nace con EXECUTE para los tres. No es algo que se agregue por error: es el
-- estado por defecto, y hay que revocarlo a mano, por nombre, cada vez. Un
-- `revoke ... from public` NO sirve: `public` es el pseudo-rol, y `anon` tiene el
-- privilegio a nombre propio.
--
-- ⚠️ Solo mira objetos `_caughtcode`. Esta base es compartida con otro producto:
-- las funciones sin ese sufijo son de otro equipo y no son asunto nuestro.
-- ============================================================================

begin;

-- ── 1. Ninguna función _caughtcode puede ser invocable por `anon` ───────────
do $$
declare
  v_abiertas text[];
begin
  select coalesce(array_agg(
           p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
           order by p.proname), '{}')
    into v_abiertas
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname like '%\_caughtcode'
    and has_function_privilege('anon', p.oid, 'EXECUTE');

  if array_length(v_abiertas, 1) > 0 then
    raise exception
      'ABIERTO A INTERNET. Estas funciones las puede llamar cualquiera con la clave pública: %. Agregá `revoke all on function <nombre> from anon;` en una migración.',
      array_to_string(v_abiertas, ', ');
  end if;

  raise notice 'OK · Ninguna función _caughtcode responde sin sesión.';
end;
$$;


-- ── 2. Las funciones de trigger tampoco son endpoints ──────────────────────
-- Las dispara Postgres al tocar la tabla; el permiso se verifica al CREAR el
-- trigger, no en cada disparo. Que tengan EXECUTE no las hace funcionar: solo
-- las publica. Hoy PostgREST no expone funciones que devuelven `trigger`, pero
-- eso es una decisión de PostgREST, no una garantía nuestra.
do $$
declare
  v_abiertas text[];
begin
  select coalesce(array_agg(p.proname order by p.proname), '{}')
    into v_abiertas
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname like '%\_caughtcode'
    and p.prorettype = 'pg_catalog.trigger'::regtype
    and (has_function_privilege('anon', p.oid, 'EXECUTE')
      or has_function_privilege('authenticated', p.oid, 'EXECUTE'));

  if array_length(v_abiertas, 1) > 0 then
    raise exception
      'Funciones de trigger con EXECUTE de más: %. No lo necesitan para dispararse.',
      array_to_string(v_abiertas, ', ');
  end if;

  raise notice 'OK · Las funciones de trigger no están publicadas.';
end;
$$;


-- ── 3. Lo que la app SÍ necesita, sigue estando ────────────────────────────
-- El riesgo de un archivo como este es revocar de más y romper la app sin que
-- nadie se entere hasta producción. Estas seis son la base de TODAS las policies
-- de RLS, y las expresiones de una policy corren con los privilegios del rol que
-- consulta: sin EXECUTE para `authenticated`, cualquier persona con sesión deja
-- de ver una sola fila de la app (error 42501, comprobado contra la base real).
--
-- Las otras cuatro las llama el navegador o un server action con la sesión de la
-- persona, no el worker. Sin EXECUTE, la pantalla correspondiente deja de andar.
do $$
declare
  v_faltantes text[] := '{}';
  v_fn        text;
begin
  foreach v_fn in array array[
    -- ayudantes de tenencia · los evalúan las policies de RLS
    'public.is_org_member_caughtcode(uuid)',
    'public.is_org_admin_caughtcode(uuid)',
    'public.org_of_project_caughtcode(uuid)',
    'public.org_of_run_caughtcode(uuid)',
    'public.org_of_finding_caughtcode(uuid)',
    'public.org_of_thread_caughtcode(uuid)',
    -- acciones que dispara la persona usuaria
    'public.ensure_org_caughtcode(uuid)',
    'public.delete_project_cascade_caughtcode(uuid)',
    'public.delete_account_caughtcode(uuid)',
    'public.set_finding_status_caughtcode(uuid, text)'
  ] loop
    if not has_function_privilege('authenticated', v_fn, 'EXECUTE') then
      v_faltantes := v_faltantes || v_fn;
    end if;
  end loop;

  if array_length(v_faltantes, 1) > 0 then
    raise exception
      'SE REVOCÓ DE MÁS. Sin esto la app no anda para nadie con sesión: %.',
      array_to_string(v_faltantes, ', ');
  end if;

  raise notice 'OK · Las funciones que usa la app siguen disponibles para authenticated.';
end;
$$;


-- ── 4. Y el worker sigue pudiendo trabajar ─────────────────────────────────
do $$
declare
  v_faltantes text[] := '{}';
  v_fn        text;
begin
  foreach v_fn in array array[
    'public.claim_job_caughtcode(text[], int)',
    'public.requeue_expired_jobs_caughtcode()',
    -- El candado de la migración 0016. Sin estas dos, dos ticks corren en
    -- paralelo y vuelve el OOM de la instancia compartida.
    'public.try_acquire_worker_lock_caughtcode(text, text, int)',
    'public.release_worker_lock_caughtcode(text, text)',
    'public.delete_project_cascade_caughtcode(uuid)',
    'public.org_of_project_caughtcode(uuid)'
  ] loop
    if not has_function_privilege('service_role', v_fn, 'EXECUTE') then
      v_faltantes := v_faltantes || v_fn;
    end if;
  end loop;

  if array_length(v_faltantes, 1) > 0 then
    raise exception 'El worker se quedó sin permisos: %.', array_to_string(v_faltantes, ', ');
  end if;

  raise notice 'OK · El worker conserva lo suyo.';
end;
$$;


-- ── 5. Y SOLO el worker: nadie con sesión puede operar la cola ─────────────
-- La §1 cubre `anon`, que es el caso ruidoso (clave pública en el bundle). Pero
-- `authenticated` es cualquier persona registrada, y estas cuatro no son
-- lecturas: manejan la cola de TODAS las organizaciones. Con EXECUTE sobre
-- ellas, alguien con una cuenta gratuita puede robarle trabajos al worker
-- (`claim_job`), reencolar media base (`requeue_expired_jobs`) o quedarse con el
-- candado del tick y dejar la cola parada para todo el mundo.
--
-- Hace falta un test propio y no alcanza con haberlo revocado en 0006/0014/0016:
-- un `create or replace` futuro sobre cualquiera de estas funciones le devuelve
-- el EXECUTE a `authenticated` por el default privilege del schema, en silencio.
do $$
declare
  v_abiertas text[] := '{}';
  v_fn       text;
begin
  foreach v_fn in array array[
    'public.claim_job_caughtcode(text[], int)',
    'public.requeue_expired_jobs_caughtcode()',
    'public.try_acquire_worker_lock_caughtcode(text, text, int)',
    'public.release_worker_lock_caughtcode(text, text)'
  ] loop
    if has_function_privilege('authenticated', v_fn, 'EXECUTE') then
      v_abiertas := v_abiertas || v_fn;
    end if;
  end loop;

  if array_length(v_abiertas, 1) > 0 then
    raise exception
      'LA COLA QUEDÓ EN MANOS DE CUALQUIERA CON SESIÓN: %. Agregá `revoke all on function <nombre> from public, anon, authenticated;` en una migración.',
      array_to_string(v_abiertas, ', ');
  end if;

  raise notice 'OK · Las funciones de la cola son solo del worker.';
end;
$$;


-- ── 6. El databaseUrl del cliente no se lee desde el navegador ─────────────
-- `jobs_caughtcode.payload` guarda el `databaseUrl` en claro y RLS filtra filas,
-- no columnas: sin este corte, cualquier miembro de la organización hace
-- `GET /rest/v1/jobs_caughtcode?select=payload` y se lleva la conexión a la base
-- del cliente. Ver migración 0017.
do $$
declare
  v_rol text;
  v_col text;
begin
  foreach v_rol in array array['anon', 'authenticated'] loop
    if has_column_privilege(v_rol, 'public.jobs_caughtcode', 'payload', 'SELECT') then
      raise exception
        'EL SECRETO DEL CLIENTE ES LEGIBLE: el rol % puede leer jobs_caughtcode.payload, que trae el databaseUrl en claro. Ver migración 0017.',
        v_rol;
    end if;
  end loop;

  -- La otra mitad: revocar de más rompería la pantalla de hallazgos, que lee
  -- `id, kind, status, last_error, created_at, updated_at` y filtra por
  -- `project_id`. Un filtro también exige SELECT sobre su columna.
  foreach v_col in array array[
    'id', 'kind', 'status', 'last_error', 'created_at', 'updated_at', 'project_id'
  ] loop
    if not has_column_privilege('authenticated', 'public.jobs_caughtcode', v_col, 'SELECT') then
      raise exception
        'SE REVOCÓ DE MÁS: la pantalla de hallazgos necesita leer jobs_caughtcode.% y ya no puede.',
        v_col;
    end if;
  end loop;

  raise notice 'OK · El payload de la cola no sale de service_role.';
end;
$$;


-- ── 7. Y tampoco quedó escrito en las filas viejas ─────────────────────────
-- Revocar la lectura es una decisión de hoy: un `grant select on table ... to
-- authenticated` de más y el secreto vuelve a estar expuesto. Borrarlo no se
-- deshace. La migración 0018 limpia las filas que ya existían; esto avisa si
-- alguna quedó, o si alguien volvió a escribirlo.
do $$
declare
  v_con_secreto bigint;
begin
  select count(*) into v_con_secreto
  from public.jobs_caughtcode
  where jsonb_exists(payload, 'databaseUrl');

  if v_con_secreto > 0 then
    raise exception
      'HAY % trabajo(s) con la conexión a la base del cliente EN CLARO en jobs_caughtcode.payload. Si son viejos, falta aplicar la migración 0018; si son nuevos, algo volvió a escribir el secreto en el payload (ver src/server/ingest/conexion.ts).',
      v_con_secreto;
  end if;

  raise notice 'OK · Ningún payload guarda la conexión a la base del cliente.';
end;
$$;


-- ── 8. La guarda de projects_caughtcode existe y no es un endpoint ─────────
-- `storage_path` decide de dónde baja el worker el código a auditar, y lo baja
-- con service_role (ignora las policies del bucket). Ver migración 0019; el
-- comportamiento se prueba de verdad, con sesión de usuario, en `rls.sql`.
do $$
begin
  if not exists (
    select 1 from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'projects_caughtcode'
      and t.tgname = 'projects_guard_update_caughtcode'
      and not t.tgisinternal
  ) then
    raise exception
      'FALTA LA GUARDA: projects_caughtcode no tiene el trigger projects_guard_update_caughtcode. Sin él, cualquier miembro cambia org_id y storage_path por PostgREST. Ver migración 0019.';
  end if;

  if has_function_privilege('anon', 'public.guard_project_update_caughtcode()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.guard_project_update_caughtcode()', 'EXECUTE') then
    raise exception
      'La función de la guarda de proyectos quedó con EXECUTE. Agregá `revoke all on function public.guard_project_update_caughtcode() from public, anon, authenticated;`.';
  end if;

  raise notice 'OK · projects_caughtcode tiene su guarda de columnas y no está publicada.';
  raise notice 'GRANTS RPC OK · Nada abierto de más, nada roto de menos.';
end;
$$;

rollback;
