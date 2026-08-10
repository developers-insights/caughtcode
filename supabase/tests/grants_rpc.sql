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
  raise notice 'GRANTS RPC OK · Nada abierto de más, nada roto de menos.';
end;
$$;

rollback;
