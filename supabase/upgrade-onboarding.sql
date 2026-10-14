-- Peakhill NBA Survivor: remember who has seen the tour and which updates they've read.
-- Run once in the SQL editor. Safe to re-run.
alter table public.profiles add column if not exists intro_seen boolean not null default false;
alter table public.profiles add column if not exists updates_seen int not null default 0;
