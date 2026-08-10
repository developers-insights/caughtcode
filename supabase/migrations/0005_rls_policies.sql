-- ============================================================================
-- caughtcode · 0005 · Permisos y policies
-- ----------------------------------------------------------------------------
-- Dos capas, no una:
--   1. GRANT/REVOKE decide qué comandos puede intentar cada rol.
--   2. RLS decide qué filas ve dentro de esos comandos.
-- Si una sola falla, la otra sigue de pie.
--
-- Reparto:
--   · Tablas que edita la persona  → organizations_caughtcode, org_members_caughtcode, projects_caughtcode,
--     project_connections_caughtcode, chat_threads_caughtcode, chat_messages_caughtcode.
--   · Tablas de sistema (las escribe el worker) → analysis_runs_caughtcode, code_index_caughtcode,
--     findings_caughtcode, agent_sessions_caughtcode, videos_caughtcode, comment_scans_caughtcode, comment_cleanups_caughtcode,
--     usage_events_caughtcode, subscriptions_caughtcode, jobs_caughtcode. La persona LEE, no escribe.
--
-- Una policy por comando, nunca `for all`: así se lee en pg_policies qué se
-- permite exactamente y no hay permisos escondidos detrás de un atajo.
--
-- Nota sobre service_role: en Supabase ese rol tiene BYPASSRLS, así que sus
-- policies son redundantes hoy. Se escriben igual para que la intención quede
-- registrada en el catálogo y para que nada se rompa en silencio si mañana ese
-- rol dejara de tener el bypass.
-- ============================================================================

-- ── Privilegios de tabla ───────────────────────────────────────────────────
revoke all on all tables in schema public from anon, authenticated;

-- Que las tablas futuras tampoco nazcan accesibles para anon.
alter default privileges in schema public revoke all on tables from anon;

grant select on
  public.organizations_caughtcode,
  public.org_members_caughtcode,
  public.projects_caughtcode,
  public.project_connections_caughtcode,
  public.analysis_runs_caughtcode,
  public.code_index_caughtcode,
  public.findings_caughtcode,
  public.agent_sessions_caughtcode,
  public.videos_caughtcode,
  public.comment_scans_caughtcode,
  public.comment_cleanups_caughtcode,
  public.chat_threads_caughtcode,
  public.chat_messages_caughtcode,
  public.usage_events_caughtcode,
  public.subscriptions_caughtcode,
  public.jobs_caughtcode
to authenticated;

grant insert, update, delete on
  public.organizations_caughtcode,
  public.org_members_caughtcode,
  public.projects_caughtcode,
  public.project_connections_caughtcode,
  public.chat_threads_caughtcode
to authenticated;

-- Los mensajes no se editan: se escriben una vez y quedan como evidencia del hilo.
grant insert, delete on public.chat_messages_caughtcode to authenticated;

grant all on all tables in schema public to service_role;


-- ── Guarda de columnas sensibles de organizations_caughtcode ──────────────────────────
-- RLS no distingue columnas. Sin esto, un admin podría transferirse la
-- organización o cambiarse el plan a mano.
create or replace function public.guard_organization_update_caughtcode()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce((select auth.jwt() ->> 'role'), '') = 'service_role' then
    return new;
  end if;

  if new.owner_user_id is distinct from old.owner_user_id
     and old.owner_user_id is distinct from (select auth.uid()) then
    raise exception 'Solo quien es dueño puede transferir la organización.'
      using errcode = 'insufficient_privilege';
  end if;

  if new.plan is distinct from old.plan then
    raise exception 'El plan lo actualiza la facturación, no se cambia a mano.'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

comment on function public.guard_organization_update_caughtcode() is
  'Impide cambiar dueño o plan desde el cliente. Solo el service_role (webhook de pagos) puede.';

create trigger organizations_guard_update_caughtcode
before update on public.organizations_caughtcode
for each row execute function public.guard_organization_update_caughtcode();


-- ════════════════════════════════════════════════════════════════════════════
-- organizations_caughtcode
-- ════════════════════════════════════════════════════════════════════════════
create policy organizations_select_caughtcode on public.organizations_caughtcode
  for select to authenticated
  using ( public.is_org_member_caughtcode(id) );

create policy organizations_insert_caughtcode on public.organizations_caughtcode
  for insert to authenticated
  with check ( owner_user_id = (select auth.uid()) );

create policy organizations_update_caughtcode on public.organizations_caughtcode
  for update to authenticated
  using ( public.is_org_admin_caughtcode(id) )
  with check ( public.is_org_admin_caughtcode(id) );

create policy organizations_delete_caughtcode on public.organizations_caughtcode
  for delete to authenticated
  using ( owner_user_id = (select auth.uid()) );


-- ════════════════════════════════════════════════════════════════════════════
-- org_members_caughtcode
-- Acá está el riesgo de recursión: la policy consulta la membresía de la misma
-- tabla que protege. Se resuelve porque is_org_member_caughtcode() es security definer y
-- no vuelve a pasar por estas policies.
-- ════════════════════════════════════════════════════════════════════════════
create policy org_members_select_caughtcode on public.org_members_caughtcode
  for select to authenticated
  using ( public.is_org_member_caughtcode(org_id) );

create policy org_members_insert_caughtcode on public.org_members_caughtcode
  for insert to authenticated
  with check ( public.is_org_admin_caughtcode(org_id) );

create policy org_members_update_caughtcode on public.org_members_caughtcode
  for update to authenticated
  using ( public.is_org_admin_caughtcode(org_id) )
  with check ( public.is_org_admin_caughtcode(org_id) );

-- Un admin da de baja a cualquiera; cualquiera puede irse por su cuenta.
create policy org_members_delete_caughtcode on public.org_members_caughtcode
  for delete to authenticated
  using ( public.is_org_admin_caughtcode(org_id) or user_id = (select auth.uid()) );


-- ════════════════════════════════════════════════════════════════════════════
-- projects_caughtcode
-- ════════════════════════════════════════════════════════════════════════════
create policy projects_select_caughtcode on public.projects_caughtcode
  for select to authenticated
  using ( public.is_org_member_caughtcode(org_id) );

create policy projects_insert_caughtcode on public.projects_caughtcode
  for insert to authenticated
  with check ( public.is_org_member_caughtcode(org_id) );

create policy projects_update_caughtcode on public.projects_caughtcode
  for update to authenticated
  using ( public.is_org_member_caughtcode(org_id) )
  with check ( public.is_org_member_caughtcode(org_id) );

-- Borrar un proyecto se lleva puesto todo su historial: queda para owner/admin.
create policy projects_delete_caughtcode on public.projects_caughtcode
  for delete to authenticated
  using ( public.is_org_admin_caughtcode(org_id) );


-- ════════════════════════════════════════════════════════════════════════════
-- project_connections_caughtcode
-- ════════════════════════════════════════════════════════════════════════════
create policy project_connections_select_caughtcode on public.project_connections_caughtcode
  for select to authenticated
  using ( public.is_org_member_caughtcode(public.org_of_project_caughtcode(project_id)) );

create policy project_connections_insert_caughtcode on public.project_connections_caughtcode
  for insert to authenticated
  with check ( public.is_org_member_caughtcode(public.org_of_project_caughtcode(project_id)) );

create policy project_connections_update_caughtcode on public.project_connections_caughtcode
  for update to authenticated
  using ( public.is_org_member_caughtcode(public.org_of_project_caughtcode(project_id)) )
  with check ( public.is_org_member_caughtcode(public.org_of_project_caughtcode(project_id)) );

create policy project_connections_delete_caughtcode on public.project_connections_caughtcode
  for delete to authenticated
  using ( public.is_org_member_caughtcode(public.org_of_project_caughtcode(project_id)) );


-- ════════════════════════════════════════════════════════════════════════════
-- chat_threads_caughtcode
-- ════════════════════════════════════════════════════════════════════════════
create policy chat_threads_select_caughtcode on public.chat_threads_caughtcode
  for select to authenticated
  using ( public.is_org_member_caughtcode(public.org_of_project_caughtcode(project_id)) );

create policy chat_threads_insert_caughtcode on public.chat_threads_caughtcode
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and public.is_org_member_caughtcode(public.org_of_project_caughtcode(project_id))
  );

create policy chat_threads_update_caughtcode on public.chat_threads_caughtcode
  for update to authenticated
  using ( user_id = (select auth.uid()) )
  with check (
    user_id = (select auth.uid())
    and public.is_org_member_caughtcode(public.org_of_project_caughtcode(project_id))
  );

create policy chat_threads_delete_caughtcode on public.chat_threads_caughtcode
  for delete to authenticated
  using (
    user_id = (select auth.uid())
    or public.is_org_admin_caughtcode(public.org_of_project_caughtcode(project_id))
  );


-- ════════════════════════════════════════════════════════════════════════════
-- chat_messages_caughtcode
-- La persona solo puede escribir mensajes suyos. Las respuestas del asistente
-- las escribe el servidor: si el cliente pudiera insertarlas, podría fabricar
-- una respuesta con citas falsas y después mostrarla como nuestra.
-- ════════════════════════════════════════════════════════════════════════════
create policy chat_messages_select_caughtcode on public.chat_messages_caughtcode
  for select to authenticated
  using ( public.is_org_member_caughtcode(public.org_of_thread_caughtcode(thread_id)) );

create policy chat_messages_insert_caughtcode on public.chat_messages_caughtcode
  for insert to authenticated
  with check (
    role = 'user'
    and public.is_org_member_caughtcode(public.org_of_thread_caughtcode(thread_id))
  );

create policy chat_messages_update_caughtcode on public.chat_messages_caughtcode
  for update to service_role
  using ( true ) with check ( true );

create policy chat_messages_delete_caughtcode on public.chat_messages_caughtcode
  for delete to authenticated
  using ( public.is_org_member_caughtcode(public.org_of_thread_caughtcode(thread_id)) );


-- ════════════════════════════════════════════════════════════════════════════
-- TABLAS DE SISTEMA — la persona lee, el worker escribe.
-- ════════════════════════════════════════════════════════════════════════════

-- ── analysis_runs_caughtcode ──────────────────────────────────────────────────────────
create policy analysis_runs_select_caughtcode on public.analysis_runs_caughtcode
  for select to authenticated
  using ( public.is_org_member_caughtcode(public.org_of_project_caughtcode(project_id)) );

create policy analysis_runs_insert_caughtcode on public.analysis_runs_caughtcode
  for insert to service_role with check ( true );

create policy analysis_runs_update_caughtcode on public.analysis_runs_caughtcode
  for update to service_role using ( true ) with check ( true );

create policy analysis_runs_delete_caughtcode on public.analysis_runs_caughtcode
  for delete to service_role using ( true );


-- ── code_index_caughtcode ─────────────────────────────────────────────────────────────
create policy code_index_select_caughtcode on public.code_index_caughtcode
  for select to authenticated
  using ( public.is_org_member_caughtcode(public.org_of_run_caughtcode(analysis_run_id)) );

create policy code_index_insert_caughtcode on public.code_index_caughtcode
  for insert to service_role with check ( true );

create policy code_index_update_caughtcode on public.code_index_caughtcode
  for update to service_role using ( true ) with check ( true );

create policy code_index_delete_caughtcode on public.code_index_caughtcode
  for delete to service_role using ( true );


-- ── findings_caughtcode ───────────────────────────────────────────────────────────────
-- "Marcar como resuelto" no pasa por un UPDATE directo: va por
-- public.set_finding_status_caughtcode(), que solo toca status y resolved_at.
create policy findings_select_caughtcode on public.findings_caughtcode
  for select to authenticated
  using ( public.is_org_member_caughtcode(public.org_of_project_caughtcode(project_id)) );

create policy findings_insert_caughtcode on public.findings_caughtcode
  for insert to service_role with check ( true );

create policy findings_update_caughtcode on public.findings_caughtcode
  for update to service_role using ( true ) with check ( true );

create policy findings_delete_caughtcode on public.findings_caughtcode
  for delete to service_role using ( true );


-- ── agent_sessions_caughtcode ─────────────────────────────────────────────────────────
create policy agent_sessions_select_caughtcode on public.agent_sessions_caughtcode
  for select to authenticated
  using ( public.is_org_member_caughtcode(public.org_of_run_caughtcode(analysis_run_id)) );

create policy agent_sessions_insert_caughtcode on public.agent_sessions_caughtcode
  for insert to service_role with check ( true );

create policy agent_sessions_update_caughtcode on public.agent_sessions_caughtcode
  for update to service_role using ( true ) with check ( true );

create policy agent_sessions_delete_caughtcode on public.agent_sessions_caughtcode
  for delete to service_role using ( true );


-- ── videos_caughtcode ─────────────────────────────────────────────────────────────────
create policy videos_select_caughtcode on public.videos_caughtcode
  for select to authenticated
  using (
    public.is_org_member_caughtcode(public.org_of_project_caughtcode(project_id))
    or public.is_org_member_caughtcode(public.org_of_finding_caughtcode(finding_id))
  );

create policy videos_insert_caughtcode on public.videos_caughtcode
  for insert to service_role with check ( true );

create policy videos_update_caughtcode on public.videos_caughtcode
  for update to service_role using ( true ) with check ( true );

create policy videos_delete_caughtcode on public.videos_caughtcode
  for delete to service_role using ( true );


-- ── comment_scans_caughtcode ──────────────────────────────────────────────────────────
create policy comment_scans_select_caughtcode on public.comment_scans_caughtcode
  for select to authenticated
  using ( public.is_org_member_caughtcode(public.org_of_project_caughtcode(project_id)) );

create policy comment_scans_insert_caughtcode on public.comment_scans_caughtcode
  for insert to service_role with check ( true );

create policy comment_scans_update_caughtcode on public.comment_scans_caughtcode
  for update to service_role using ( true ) with check ( true );

create policy comment_scans_delete_caughtcode on public.comment_scans_caughtcode
  for delete to service_role using ( true );


-- ── comment_cleanups_caughtcode ───────────────────────────────────────────────────────
create policy comment_cleanups_select_caughtcode on public.comment_cleanups_caughtcode
  for select to authenticated
  using ( public.is_org_member_caughtcode(public.org_of_project_caughtcode(project_id)) );

create policy comment_cleanups_insert_caughtcode on public.comment_cleanups_caughtcode
  for insert to service_role with check ( true );

create policy comment_cleanups_update_caughtcode on public.comment_cleanups_caughtcode
  for update to service_role using ( true ) with check ( true );

create policy comment_cleanups_delete_caughtcode on public.comment_cleanups_caughtcode
  for delete to service_role using ( true );


-- ── usage_events_caughtcode ───────────────────────────────────────────────────────────
-- Se lee para mostrar cuánto costó cada cosa, antes y después de gastarlo.
create policy usage_events_select_caughtcode on public.usage_events_caughtcode
  for select to authenticated
  using ( public.is_org_member_caughtcode(org_id) );

create policy usage_events_insert_caughtcode on public.usage_events_caughtcode
  for insert to service_role with check ( true );

create policy usage_events_update_caughtcode on public.usage_events_caughtcode
  for update to service_role using ( true ) with check ( true );

create policy usage_events_delete_caughtcode on public.usage_events_caughtcode
  for delete to service_role using ( true );


-- ── subscriptions_caughtcode ──────────────────────────────────────────────────────────
create policy subscriptions_select_caughtcode on public.subscriptions_caughtcode
  for select to authenticated
  using ( public.is_org_member_caughtcode(org_id) );

create policy subscriptions_insert_caughtcode on public.subscriptions_caughtcode
  for insert to service_role with check ( true );

create policy subscriptions_update_caughtcode on public.subscriptions_caughtcode
  for update to service_role using ( true ) with check ( true );

create policy subscriptions_delete_caughtcode on public.subscriptions_caughtcode
  for delete to service_role using ( true );


-- ── jobs_caughtcode ───────────────────────────────────────────────────────────────────
-- Encolar cuesta plata: solo el servidor lo hace, después de mostrar el costo.
create policy jobs_select_caughtcode on public.jobs_caughtcode
  for select to authenticated
  using ( public.is_org_member_caughtcode(org_id) );

create policy jobs_insert_caughtcode on public.jobs_caughtcode
  for insert to service_role with check ( true );

create policy jobs_update_caughtcode on public.jobs_caughtcode
  for update to service_role using ( true ) with check ( true );

create policy jobs_delete_caughtcode on public.jobs_caughtcode
  for delete to service_role using ( true );
