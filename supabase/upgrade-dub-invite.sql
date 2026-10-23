-- Peakhill NBA Survivor: Dub slot + invite code. Run once in the SQL editor. Safe to re-run.

-- ---- Dub: a fourth pick slot (a team's wins) ----
alter table public.picks drop constraint if exists picks_slot_check;
alter table public.picks add constraint picks_slot_check check (slot in ('PTS', 'REB', 'AST', 'WIN'));
alter table public.unburns drop constraint if exists unburns_slot_check;
alter table public.unburns add constraint unburns_slot_check check (slot in ('PTS', 'REB', 'AST', 'WIN'));

-- ---- Invite code ----
-- One settings row. No API policies: read and changed only through the functions below.
create table if not exists public.league_settings (
  id boolean primary key default true check (id),
  invite_code text
);
insert into public.league_settings (id) values (true) on conflict do nothing;
alter table public.league_settings enable row level security;

-- Starts with a random 6-character code; change it from the Commissioner tab.
update public.league_settings set invite_code = upper(substr(md5(random()::text), 1, 6))
  where id and invite_code is null;

-- True when the code matches, or when no code is set.
create or replace function public.check_invite(code text) returns boolean
  language sql stable security definer set search_path = public
  as $$
    select coalesce(
      (select s.invite_code is null or lower(s.invite_code) = lower(trim(coalesce(code, '')))
       from league_settings s where s.id),
      true)
  $$;

-- Sign-ups must carry the code (the app sends it as user metadata). One account works in every
-- league on the site, so the NHL league's code (supabase/nhl/setup.sql) opens an account too, but
-- only an actual match: the NHL league switching its code off doesn't open sign-ups.
create or replace function public.require_invite() returns trigger
  language plpgsql security definer set search_path = public
  as $$
  declare
    code text := new.raw_user_meta_data->>'invite_code';
    ok boolean := public.check_invite(code);
  begin
    if not ok and to_regclass('nhl.league_settings') is not null then
      execute 'select exists (select 1 from nhl.league_settings s where s.id and s.invite_code is not null
        and lower(s.invite_code) = lower(trim(coalesce($1, ''''))))' into ok using code;
    end if;
    if not ok then
      raise exception 'Invalid invite code.';
    end if;
    return new;
  end
  $$;
drop trigger if exists require_invite on auth.users;
create trigger require_invite before insert on auth.users
  for each row execute function public.require_invite();

create or replace function public.admin_get_invite() returns text
  language sql stable security definer set search_path = public
  as $$ select s.invite_code from league_settings s where s.id and public.is_admin() $$;

-- An empty code turns the requirement off.
create or replace function public.admin_set_invite(code text) returns void
  language plpgsql security definer set search_path = public
  as $$
  begin
    if not public.is_admin() then raise exception 'Only the commissioner can change the invite code.'; end if;
    update public.league_settings set invite_code = nullif(trim(code), '') where id;
  end
  $$;

-- Only the sign-up trigger calls it, so the code can't be guessed over the API.
revoke execute on function public.check_invite(text) from public, anon, authenticated;
revoke execute on function public.admin_get_invite() from public, anon;
revoke execute on function public.admin_set_invite(text) from public, anon;
grant execute on function public.admin_get_invite() to authenticated;
grant execute on function public.admin_set_invite(text) to authenticated;
