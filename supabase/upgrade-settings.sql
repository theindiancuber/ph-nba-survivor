-- Peakhill NBA Survivor: league settings the commissioner edits from the Commissioner tab.
-- Run once in the Supabase SQL editor, after admin.sql. Safe to re-run.
--
-- Three rows, all public (everyone's app needs them to score the league), all written
-- only by commissioners:
--   'rules'        survival bars and card rules, each change taking effect from a week
--   'meta'         lives, drops, decree limits, the commissioner's name, an announcement
--   'adjustments'  public point and life corrections, each with a reason

create table if not exists public.league_settings (
  key text primary key check (key in ('rules', 'meta', 'adjustments')),
  value jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.league_settings enable row level security;
drop policy if exists "settings readable" on public.league_settings;
drop policy if exists "settings commissioner insert" on public.league_settings;
drop policy if exists "settings commissioner update" on public.league_settings;
drop policy if exists "settings commissioner delete" on public.league_settings;
create policy "settings readable" on public.league_settings for select to anon, authenticated using (true);
create policy "settings commissioner insert" on public.league_settings for insert to authenticated with check (public.is_admin());
create policy "settings commissioner update" on public.league_settings for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "settings commissioner delete" on public.league_settings for delete to authenticated using (public.is_admin());

-- How many decrees a season: meta.decree.perSeason in league_settings (from the
-- Commissioner tab), or 3 if that hasn't been set or upgrade-settings.sql hasn't run.
create or replace function public.decree_limit() returns int
  language plpgsql stable security definer set search_path = public
  as $$
  begin
    return coalesce((select (value #>> '{decree,perSeason}')::int from league_settings where key = 'meta'), 3);
  exception when undefined_table then
    return 3;
  end
  $$;

-- The decree insert policy uses decree_limit() (upgrade-decree.sql sets it up the same way).
do $$
begin
  if to_regclass('public.decrees') is not null then
    drop policy if exists "decrees commissioner insert" on public.decrees;
    create policy "decrees commissioner insert" on public.decrees for insert to authenticated
      with check (public.is_admin() and public.decree_open(week) and (select count(*) from public.decrees) < public.decree_limit());
  end if;
end
$$;
