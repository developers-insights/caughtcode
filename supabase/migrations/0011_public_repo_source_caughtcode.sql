-- 0011 — Repositorios públicos como fuente de proyecto.
--
-- Por qué: la única vía de GitHub que existía exigía instalar la GitHub App.
-- Alguien que armó su app con Lovable o Bolt y la tiene pública en GitHub no
-- debería tener que instalar nada para que la revisemos: alcanza con pegar la
-- dirección. Ese camino necesita su propio `source_type`, porque no hay
-- credencial guardada ni instalación asociada — y esa diferencia importa
-- después, al decidir si se puede volver a traer el código.
--
-- Es un valor más en el CHECK, sin tocar datos ni policies.

alter table public.projects_caughtcode
  drop constraint if exists projects_caughtcode_source_type_check;

alter table public.projects_caughtcode
  add constraint projects_caughtcode_source_type_check
  check (source_type in ('github', 'github_public', 'zip'));
