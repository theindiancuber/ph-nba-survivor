-- Peakhill NBA Survivor: Commissioner's Decree. Run once in the Supabase SQL editor,
-- after admin.sql. Safe to re-run.
--
-- A decree is a one-week rule twist. The commissioner either imposes one (one option)
-- or puts two or three to a league vote. Everyone can see decrees and the running vote
-- counts; nobody can see who voted for what. Decrees have to be posted, and votes
-- cast, at least 24 hours before that week's lock, and there are 3 a season unless the
-- commissioner changes that in the Commissioner tab (see decree_limit()).

create table if not exists public.decrees (
  week int primary key references public.weeks(week),
  options text[] not null check (
    array_length(options, 1) between 1 and 3
    and options <@ array[
      'spotlight:PTS', 'spotlight:REB', 'spotlight:AST', 'spotlight:WIN',
      'opposite:PTS', 'opposite:REB', 'opposite:AST', 'opposite:WIN',
      'bounty', 'mercy', 'sudden_death', 'amnesty', 'ceasefire', 'free_for_all', 'pack_day'
    ]::text[]
  ),
  created_at timestamptz not null default now()
);

create table if not exists public.decree_votes (
  week int not null references public.decrees(week) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  choice int not null check (choice >= 0),
  created_at timestamptz not null default now(),
  primary key (week, user_id)
);

-- Still more than 24 hours before the week locks.
create or replace function public.decree_open(w int) returns boolean
  language sql stable security definer set search_path = public
  as $$ select exists (select 1 from weeks where week = w and lock_at > now() + interval '24 hours') $$;

-- How many decrees a season: meta.decree.perSeason in league_config (from the
-- Commissioner tab), or 3 if that hasn't been set or upgrade-settings.sql hasn't run.
create or replace function public.decree_limit() returns int
  language plpgsql stable security definer set search_path = public
  as $$
  begin
    return coalesce((select (value #>> '{decree,perSeason}')::int from league_config where key = 'meta'), 3);
  exception when undefined_table or undefined_column then
    return 3;
  end
  $$;

alter table public.decrees enable row level security;
drop policy if exists "decrees readable" on public.decrees;
drop policy if exists "decrees commissioner insert" on public.decrees;
drop policy if exists "decrees commissioner delete" on public.decrees;
create policy "decrees readable" on public.decrees for select to authenticated using (true);
create policy "decrees commissioner insert" on public.decrees for insert to authenticated
  with check (public.is_admin() and public.decree_open(week) and (select count(*) from public.decrees) < public.decree_limit());
create policy "decrees commissioner delete" on public.decrees for delete to authenticated
  using (public.is_admin() and public.decree_open(week));

alter table public.decree_votes enable row level security;
drop policy if exists "votes own" on public.decree_votes;
drop policy if exists "votes insert own" on public.decree_votes;
drop policy if exists "votes update own" on public.decree_votes;
drop policy if exists "votes delete own" on public.decree_votes;
create policy "votes own" on public.decree_votes for select to authenticated using (user_id = auth.uid());
create policy "votes insert own" on public.decree_votes for insert to authenticated
  with check (user_id = auth.uid() and public.decree_open(week)
    and exists (select 1 from public.decrees d where d.week = decree_votes.week
                and array_length(d.options, 1) > 1 and decree_votes.choice < array_length(d.options, 1)));
create policy "votes update own" on public.decree_votes for update to authenticated
  using (user_id = auth.uid() and public.decree_open(week))
  with check (user_id = auth.uid() and public.decree_open(week)
    and exists (select 1 from public.decrees d where d.week = decree_votes.week
                and array_length(d.options, 1) > 1 and decree_votes.choice < array_length(d.options, 1)));
create policy "votes delete own" on public.decree_votes for delete to authenticated
  using (user_id = auth.uid() and public.decree_open(week));

-- Vote counts per option. Counts only, never who voted.
create or replace function public.decree_tally()
  returns table (week int, choice int, votes int)
  language sql stable security definer set search_path = public
  as $$ select v.week, v.choice, count(*)::int from decree_votes v group by v.week, v.choice $$;
revoke execute on function public.decree_tally() from public, anon;
grant execute on function public.decree_tally() to authenticated, service_role;
