-- 0012 — Guardar qué se revisó, no solo qué se encontró.
--
-- Por qué: la pantalla de hallazgos le promete al usuario "guardamos el
-- detalle de todo lo que miramos por si querés verlo" cuando no aparece nada
-- serio. Hasta ahora esa lista solo existía como líneas de log efímeras del
-- trabajo (`ctx.log`), invisibles para la pantalla. Sin esta columna, ese
-- botón no tiene nada real que mostrar.

alter table public.analysis_runs_caughtcode
  add column coverage jsonb;

comment on column public.analysis_runs_caughtcode.coverage is
  'Qué chequeo corrió, encontró algo, salió limpio o se salteó y por qué. Lo arma run_checks al terminar.';
