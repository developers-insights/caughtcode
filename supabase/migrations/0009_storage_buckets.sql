-- ============================================================================
-- caughtcode · 0009 · Buckets de Storage
-- ----------------------------------------------------------------------------
-- Los tres privados y con sufijo _caughtcode: `storage.buckets` es compartido
-- con el otro producto del proyecto, así que el nombre tiene que ser nuestro sin
-- ambigüedad. Nada del código, las grabaciones o los videos de nadie es público:
-- la app sirve todo con URLs firmadas de vida corta, generadas en el servidor
-- con el service role.
--
-- Falla ruidosamente si alguno ya existe (sin `on conflict`): que un bucket con
-- ese nombre ya esté ahí sería una señal de que algo no entendimos de la base.
-- El preflight (supabase/tests/preflight.sql) lo avisa antes del push.
--
-- CONVENCIÓN DE RUTAS (contrato con los demás frentes, respetarla):
--
--     repos_caughtcode/<org_id>/<project_id>/<sha-o-timestamp>.zip
--     repos_caughtcode/<org_id>/<project_id>/cleanups/<cleanup_id>.patch
--     recordings_caughtcode/<org_id>/<project_id>/<agent_session_id>.webm
--     videos_caughtcode/<org_id>/<project_id>/<video_id>.mp4
--
-- El org_id va primero a propósito: deja la puerta abierta a policies sobre
-- storage.objects por prefijo si algún día se sirve directo desde el cliente.
-- Hoy no hacen falta y no se crean, porque el service role no pasa por RLS —
-- y en una base compartida, cuantas menos policies ajenas toquemos, mejor.
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('repos_caughtcode',      'repos_caughtcode',      false, 209715200, null),
  ('recordings_caughtcode', 'recordings_caughtcode', false, 524288000, null),
  ('videos_caughtcode',     'videos_caughtcode',     false, 524288000, array['video/mp4', 'video/webm']);
