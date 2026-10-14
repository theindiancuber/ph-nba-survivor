-- Peakhill NBA Survivor: database schema.
-- Paste into Supabase → SQL Editor → Run. Safe to re-run.

-- People in the league. One row per signed-in account.
create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  display_name text not null check (char_length(display_name) between 2 and 24),
  fav_team text,
  rival_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index if not exists profiles_name_unique on public.profiles (lower(display_name));

-- Pick locks. The data script moves each lock to the week's real first tip-off.
create table if not exists public.weeks (
  week int primary key,
  lock_at timestamptz not null
);

-- One row per person, week and slot.
create table if not exists public.picks (
  user_id uuid not null references public.profiles(id) on delete cascade,
  week int not null references public.weeks(week),
  slot text not null check (slot in ('PTS', 'REB', 'AST')),
  player_id int not null,
  alt_id int,
  double_down boolean not null default false,
  auto boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, week, slot),
  check (alt_id is null or alt_id <> player_id)
);
-- Double Down joker: once a season.
create unique index if not exists picks_one_double_down on public.picks (user_id) where double_down;

-- Un-burn joker: once a season, one player back in one slot.
create table if not exists public.unburns (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  slot text not null check (slot in ('PTS', 'REB', 'AST')),
  player_id int not null,
  week int not null references public.weeks(week),
  created_at timestamptz not null default now()
);

create or replace function public.week_open(w int) returns boolean
  language sql stable security definer set search_path = public
  as $$ select exists (select 1 from weeks where week = w and lock_at > now()) $$;

create or replace function public.week_locked(w int) returns boolean
  language sql stable security definer set search_path = public
  as $$ select exists (select 1 from weeks where week = w and lock_at <= now()) $$;

alter table public.profiles enable row level security;
alter table public.weeks enable row level security;
alter table public.picks enable row level security;
alter table public.unburns enable row level security;

drop policy if exists "profiles readable" on public.profiles;
drop policy if exists "profiles insert own" on public.profiles;
drop policy if exists "profiles update own" on public.profiles;
create policy "profiles readable" on public.profiles for select to anon, authenticated using (true);
create policy "profiles insert own" on public.profiles for insert to authenticated with check (id = auth.uid());
create policy "profiles update own" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists "weeks readable" on public.weeks;
create policy "weeks readable" on public.weeks for select to anon, authenticated using (true);

-- Your own picks any time; everyone's picks once the week locks.
drop policy if exists "picks readable" on public.picks;
drop policy if exists "picks insert own before lock" on public.picks;
drop policy if exists "picks update own before lock" on public.picks;
drop policy if exists "picks delete own before lock" on public.picks;
create policy "picks readable" on public.picks for select to anon, authenticated
  using (user_id = auth.uid() or public.week_locked(week));
create policy "picks insert own before lock" on public.picks for insert to authenticated
  with check (user_id = auth.uid() and public.week_open(week) and not auto);
create policy "picks update own before lock" on public.picks for update to authenticated
  using (user_id = auth.uid() and public.week_open(week))
  with check (user_id = auth.uid() and public.week_open(week) and not auto);
create policy "picks delete own before lock" on public.picks for delete to authenticated
  using (user_id = auth.uid() and public.week_open(week));

drop policy if exists "unburns readable" on public.unburns;
drop policy if exists "unburns insert own before lock" on public.unburns;
drop policy if exists "unburns delete own before lock" on public.unburns;
create policy "unburns readable" on public.unburns for select to anon, authenticated
  using (user_id = auth.uid() or public.week_locked(week));
create policy "unburns insert own before lock" on public.unburns for insert to authenticated
  with check (user_id = auth.uid() and public.week_open(week));
create policy "unburns delete own before lock" on public.unburns for delete to authenticated
  using (user_id = auth.uid() and public.week_open(week));

-- ---- Joker cards ----
-- Packs are dealt in the browser from a seeded shuffle, so the only things stored
-- are the card you kept from each pack ('_keep'), duel answers ('_reply'), gifts
-- and plays. The league engine rebuilds every hand from these rows and ignores
-- any play for a card you don't actually hold.
create table if not exists public.card_plays (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  week int not null references public.weeks(week),
  card text not null check (card in (
    '_keep', '_reply', 'gift',
    'jinx', 'load', 'heist', 'blue_shell', 'burn_notice', 'clown', 'nickname', 'charge', 'reverse',
    'sixth', 'copycat', 'leech', 'switcheroo', 'garbage', 'embargo', 'scout', 'duel')),
  card_uid text,
  target_id uuid references public.profiles(id) on delete cascade,
  slot text check (slot in ('PTS', 'REB', 'AST')),
  player_id int,
  params jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
-- Each card (or pack, for '_keep') can be used once.
create unique index if not exists card_plays_once on public.card_plays (user_id, card_uid) where card_uid is not null;
create index if not exists card_plays_week on public.card_plays (week);

-- The server sets the id and time, so nobody can backdate a play.
create or replace function public.card_plays_stamp() returns trigger
  language plpgsql as $$
  begin
    new.id := gen_random_uuid();
    new.created_at := now();
    return new;
  end
  $$;
drop trigger if exists card_plays_stamp on public.card_plays;
create trigger card_plays_stamp before insert on public.card_plays
  for each row execute function public.card_plays_stamp();

-- When a row can be added or taken back. Hindsight cards rewrite last week, so
-- they go in after that week locks and before the next one does. An Embargo
-- has to give everyone a day's notice.
create or replace function public.card_window(c text, w int) returns boolean
  language sql stable security definer set search_path = public
  as $$
    select case
      when c in ('switcheroo', 'garbage') then public.week_locked(w) and public.week_open(w + 1)
      when c = 'embargo' then exists (select 1 from weeks where week = w and lock_at > now() + interval '24 hours')
      else public.week_open(w)
    end
  $$;

alter table public.card_plays enable row level security;
drop policy if exists "card plays readable" on public.card_plays;
drop policy if exists "card plays insert own" on public.card_plays;
drop policy if exists "card plays delete own" on public.card_plays;
-- Your own rows any time; everyone's once the week locks. Embargoes and kept
-- cards are public straight away, and a duel is visible to the person challenged.
create policy "card plays readable" on public.card_plays for select to anon, authenticated
  using (
    user_id = auth.uid() or public.week_locked(week) or card in ('embargo', '_keep')
    or (card in ('duel', '_reply') and target_id = auth.uid())
  );
create policy "card plays insert own" on public.card_plays for insert to authenticated
  with check (user_id = auth.uid() and public.card_window(card, week));
create policy "card plays delete own" on public.card_plays for delete to authenticated
  using (user_id = auth.uid() and card <> '_keep' and public.card_window(card, week));

-- Scout Report: the five most-picked players in one slot of the open week, as
-- counts only. Answers only someone who has played a Scout Report on that slot.
create or replace function public.scout_report(w int, s text)
  returns table (player_id int, picks int, entries int)
  language sql stable security definer set search_path = public
  as $$
    select p.player_id, count(*)::int,
      (select count(distinct x.user_id)::int from picks x where x.week = w)
    from picks p
    where p.week = w and p.slot = s and public.week_open(w)
      and exists (select 1 from card_plays c where c.user_id = auth.uid() and c.week = w and c.card = 'scout' and c.slot = s)
    group by p.player_id
    order by count(*) desc, p.player_id
    limit 5
  $$;
revoke execute on function public.scout_report(int, text) from public, anon;
grant execute on function public.scout_report(int, text) to authenticated;

-- Default locks: 7pm ET on the first day of each week.
insert into public.weeks (week, lock_at) values
  (1, '2026-10-20T23:00:00.000Z'),
  (2, '2026-11-03T00:00:00.000Z'),
  (3, '2026-11-10T00:00:00.000Z'),
  (4, '2026-11-17T00:00:00.000Z'),
  (5, '2026-11-24T00:00:00.000Z'),
  (6, '2026-12-01T00:00:00.000Z'),
  (7, '2026-12-08T00:00:00.000Z'),
  (8, '2026-12-15T00:00:00.000Z'),
  (9, '2026-12-22T00:00:00.000Z'),
  (10, '2026-12-29T00:00:00.000Z'),
  (11, '2027-01-05T00:00:00.000Z'),
  (12, '2027-01-12T00:00:00.000Z'),
  (13, '2027-01-19T00:00:00.000Z'),
  (14, '2027-01-26T00:00:00.000Z'),
  (15, '2027-02-02T00:00:00.000Z'),
  (16, '2027-02-09T00:00:00.000Z'),
  (17, '2027-02-16T00:00:00.000Z'),
  (18, '2027-03-02T00:00:00.000Z'),
  (19, '2027-03-09T00:00:00.000Z'),
  (20, '2027-03-15T23:00:00.000Z'),
  (21, '2027-03-22T23:00:00.000Z'),
  (22, '2027-03-29T23:00:00.000Z'),
  (23, '2027-04-05T23:00:00.000Z')
on conflict (week) do nothing;
