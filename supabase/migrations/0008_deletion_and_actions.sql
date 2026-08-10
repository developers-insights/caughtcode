-- ============================================================================
-- caughtcode · 0008 · Borrado real y acciones del usuario
-- ----------------------------------------------------------------------------
-- Prometemos que el código del usuario desaparece. Entonces desaparece: acá no
-- hay baja lógica, hay DELETE.
--
-- ⚠️  QUÉ QUEDA A CARGO DEL STORAGE (esto la base NO lo puede hacer sola)
--
-- Postgres borra filas. Los archivos viven en Supabase Storage, que es otro
-- sistema: ningún DELETE ni ningún ON DELETE CASCADE los toca. Por eso las dos
-- funciones de borrado devuelven `storage_objects`: la lista de objetos que
-- quedaron huérfanos.
--
-- Quien llama a estas funciones TIENE que, inmediatamente después:
--   1. Borrar esos objetos con el cliente admin (service role), bucket por bucket:
--        repos       → código descargado (projects_caughtcode.storage_path) y parches
--                      (comment_cleanups_caughtcode.patch_path)
--        videos_caughtcode      → clips renderizados (videos_caughtcode.url)
--        recordings  → grabaciones del agente (agent_sessions_caughtcode.recording_url)
--      El helper de Storage es `storage.from(bucket).remove([...])`.
--   2. En delete_account_caughtcode, además: `auth.admin.deleteUser(userId)`. Esa fila la
--      administra GoTrue y no se toca desde SQL.
--
-- Si el paso 1 falla, quedan archivos sin dueño en el bucket: hay que
-- reintentar. La lista devuelta es el registro de qué reintentar.
-- ============================================================================

-- ── Borrar un proyecto, de verdad ──────────────────────────────────────────
create or replace function public.delete_project_cascade_caughtcode(p_project_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org      uuid;
  v_rol      text := coalesce((select auth.jwt() ->> 'role'), '');
  v_objetos  text[];
begin
  select p.org_id into v_org from public.projects_caughtcode p where p.id = p_project_id;

  if v_org is null then
    raise exception 'No encontramos ese proyecto.'
      using errcode = 'no_data_found';
  end if;

  if v_rol <> 'service_role' and not public.is_org_admin_caughtcode(v_org) then
    raise exception 'No tenés permiso para borrar este proyecto.'
      using errcode = 'insufficient_privilege';
  end if;

  -- Se juntan los archivos ANTES del delete: después ya no hay de dónde leerlos.
  select coalesce(array_agg(distinct x.objeto) filter (where x.objeto is not null), '{}')
    into v_objetos
  from (
    select p.storage_path as objeto
      from public.projects_caughtcode p
     where p.id = p_project_id

    union all
    select v.url
      from public.videos_caughtcode v
     where v.project_id = p_project_id

    union all
    select v.url
      from public.videos_caughtcode v
      join public.findings_caughtcode f on f.id = v.finding_id
     where f.project_id = p_project_id

    union all
    select s.recording_url
      from public.agent_sessions_caughtcode s
      join public.analysis_runs_caughtcode r on r.id = s.analysis_run_id
     where r.project_id = p_project_id

    union all
    select c.patch_path
      from public.comment_cleanups_caughtcode c
     where c.project_id = p_project_id
  ) x;

  -- El resto se va solo por las FK en cascada: corridas, índice, hallazgos,
  -- sesiones del agente, videos_caughtcode, escaneos de comentarios, hilos de chat y jobs_caughtcode.
  delete from public.projects_caughtcode where id = p_project_id;

  return jsonb_build_object(
    'project_id',      p_project_id,
    'org_id',          v_org,
    'storage_objects', to_jsonb(v_objetos)
  );
end;
$$;

comment on function public.delete_project_cascade_caughtcode(uuid) is
  'Borra un proyecto y todo lo que cuelga de él. Devuelve los objetos de Storage que el llamador tiene que borrar aparte.';


-- ── Borrar una cuenta, de verdad ───────────────────────────────────────────
create or replace function public.delete_account_caughtcode(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rol      text := coalesce((select auth.jwt() ->> 'role'), '');
  v_orgs     uuid[];
  v_objetos  text[];
begin
  if v_rol <> 'service_role' and (select auth.uid()) is distinct from p_user_id then
    raise exception 'Solo podés borrar tu propia cuenta.'
      using errcode = 'insufficient_privilege';
  end if;

  -- Se borran las organizaciones de las que esta persona es dueña. De las que
  -- solo era miembro, se la saca sin tocar el trabajo del resto.
  select coalesce(array_agg(o.id), '{}') into v_orgs
  from public.organizations_caughtcode o
  where o.owner_user_id = p_user_id;

  select coalesce(array_agg(distinct x.objeto) filter (where x.objeto is not null), '{}')
    into v_objetos
  from (
    select p.storage_path as objeto
      from public.projects_caughtcode p
     where p.org_id = any (v_orgs)

    union all
    select v.url
      from public.videos_caughtcode v
      join public.projects_caughtcode p on p.id = v.project_id
     where p.org_id = any (v_orgs)

    union all
    select v.url
      from public.videos_caughtcode v
      join public.findings_caughtcode f on f.id = v.finding_id
      join public.projects_caughtcode p on p.id = f.project_id
     where p.org_id = any (v_orgs)

    union all
    select s.recording_url
      from public.agent_sessions_caughtcode s
      join public.analysis_runs_caughtcode r on r.id = s.analysis_run_id
      join public.projects_caughtcode p on p.id = r.project_id
     where p.org_id = any (v_orgs)

    union all
    select c.patch_path
      from public.comment_cleanups_caughtcode c
      join public.projects_caughtcode p on p.id = c.project_id
     where p.org_id = any (v_orgs)
  ) x;

  delete from public.organizations_caughtcode where id = any (v_orgs);
  delete from public.org_members_caughtcode  where user_id = p_user_id;
  delete from public.chat_threads_caughtcode where user_id = p_user_id;

  return jsonb_build_object(
    'user_id',         p_user_id,
    'orgs_deleted',    to_jsonb(v_orgs),
    'storage_objects', to_jsonb(v_objetos)
  );
end;
$$;

comment on function public.delete_account_caughtcode(uuid) is
  'Borra las organizaciones propias y todo su contenido, y saca a la persona del resto. NO borra auth.users: eso lo hace auth.admin.deleteUser() después.';


-- ── Marcar un hallazgo como resuelto (o descartado) ────────────────────────
-- findings_caughtcode es tabla de sistema: el cliente no la actualiza. Pero "marcar como
-- resuelto" es una acción del producto, así que va por acá, donde solo se
-- pueden tocar dos columnas y ninguna otra.
create or replace function public.set_finding_status_caughtcode(p_finding_id uuid, p_status text)
returns public.findings_caughtcode
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rol text := coalesce((select auth.jwt() ->> 'role'), '');
  v_row public.findings_caughtcode;
begin
  if p_status not in ('open', 'fixed', 'dismissed') then
    raise exception 'Ese estado no existe: %', p_status
      using errcode = 'check_violation';
  end if;

  if v_rol <> 'service_role'
     and not public.is_org_member_caughtcode(public.org_of_finding_caughtcode(p_finding_id)) then
    raise exception 'No tenés permiso sobre este hallazgo.'
      using errcode = 'insufficient_privilege';
  end if;

  update public.findings_caughtcode
     set status      = p_status,
         resolved_at = case when p_status = 'open' then null else now() end
   where id = p_finding_id
  returning * into v_row;

  if not found then
    raise exception 'No encontramos ese hallazgo.'
      using errcode = 'no_data_found';
  end if;

  return v_row;
end;
$$;

comment on function public.set_finding_status_caughtcode(uuid, text) is
  'Única vía para que el cliente cambie el estado de un hallazgo. Solo toca status y resolved_at.';


-- ── Permisos ───────────────────────────────────────────────────────────────
revoke all on function public.delete_project_cascade_caughtcode(uuid)   from public;
revoke all on function public.delete_account_caughtcode(uuid)           from public;
revoke all on function public.set_finding_status_caughtcode(uuid, text) from public;

grant execute on function public.delete_project_cascade_caughtcode(uuid)   to authenticated, service_role;
grant execute on function public.delete_account_caughtcode(uuid)           to authenticated, service_role;
grant execute on function public.set_finding_status_caughtcode(uuid, text) to authenticated, service_role;
