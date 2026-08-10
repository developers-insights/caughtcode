-- ============================================================================
-- caughtcode · 0007 · Alta del espacio de trabajo
-- ----------------------------------------------------------------------------
-- ⚠️  SIN TRIGGER SOBRE auth.users. A propósito, y no es negociable.
--
-- caughtcode vive dentro de un proyecto de Supabase COMPARTIDO con otro
-- producto en producción. `auth.users` es una sola tabla para los dos.
--
-- La versión anterior de este archivo creaba un trigger `on_auth_user_created`
-- que armaba una organización por cada usuario nuevo. En una base compartida eso
-- significa dos cosas inaceptables:
--
--   1. Cada persona que se registre en el OTRO producto crearía una
--      organización de caughtcode. Basura cruzada, y para siempre.
--   2. Peor: si nuestro trigger falla por cualquier motivo (un check, un dato
--      raro, un deploy nuestro a mitad), la excepción se propaga y **rompe el
--      registro de usuarios del otro producto**. Un bug nuestro se convierte en
--      una caída ajena.
--
-- Filtrar por una marca en raw_user_meta_data reduciría (1) pero no elimina (2):
-- el trigger sigue corriendo dentro de la transacción de registro de todos.
--
-- Por eso: caughtcode NO instala nada sobre auth.users. Solo lee. La
-- organización se crea desde nuestro código, llamando a esta función.
--
-- 📣 FRENTE DE AUTENTICACIÓN: hay que llamar a
--       supabase.rpc('ensure_org_caughtcode')
--    en el primer ingreso de cada usuario (callback de login o layout de la
--    zona autenticada). Es idempotente y barata: si ya hay organización, la
--    devuelve sin escribir. Sin esa llamada, el usuario entra y no tiene dónde
--    crear proyectos.
-- ============================================================================

create or replace function public.ensure_org_caughtcode(p_user_id uuid default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := coalesce(p_user_id, (select auth.uid()));
  v_rol     text := coalesce((select auth.jwt() ->> 'role'), '');
  v_org     uuid;
  v_nombre  text;
begin
  if v_user_id is null then
    raise exception 'Hace falta iniciar sesión.'
      using errcode = 'insufficient_privilege';
  end if;

  -- Cada quien crea su propio espacio. El servidor puede crear el de cualquiera.
  if v_rol <> 'service_role' and (select auth.uid()) is distinct from v_user_id then
    raise exception 'Solo podés crear tu propio espacio de trabajo.'
      using errcode = 'insufficient_privilege';
  end if;

  -- Dos pedidos simultáneos en el primer ingreso crearían dos organizaciones.
  -- El lock es por usuario y dura lo que dura la transacción.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_user_id::text, 0)
  );

  select om.org_id into v_org
  from public.org_members_caughtcode om
  join public.organizations_caughtcode o on o.id = om.org_id
  where om.user_id = v_user_id
  order by o.created_at
  limit 1;

  if v_org is not null then
    return v_org;
  end if;

  -- Solo LECTURA de auth.users, nunca escritura: es la tabla del otro producto.
  select coalesce(
    nullif(btrim(u.raw_user_meta_data ->> 'full_name'), ''),
    nullif(btrim(u.raw_user_meta_data ->> 'name'), ''),
    nullif(btrim(split_part(coalesce(u.email, ''), '@', 1)), ''),
    'mi espacio'
  ) into v_nombre
  from auth.users u
  where u.id = v_user_id;

  insert into public.organizations_caughtcode (name, owner_user_id, plan)
  values (left('Espacio de ' || coalesce(v_nombre, 'mi espacio'), 120), v_user_id, 'free')
  returning id into v_org;

  -- El trigger organizations_add_owner_membership_caughtcode (0001) ya sumó la
  -- fila de org_members con rol owner.
  return v_org;
end;
$$;

comment on function public.ensure_org_caughtcode(uuid) is
  'Crea el espacio de trabajo personal si todavía no existe, y devuelve su id. Idempotente y segura ante llamadas simultáneas. La llama el código de caughtcode en el primer ingreso: no hay trigger sobre auth.users porque la base es compartida.';

revoke all on function public.ensure_org_caughtcode(uuid) from public;
grant execute on function public.ensure_org_caughtcode(uuid) to authenticated, service_role;
