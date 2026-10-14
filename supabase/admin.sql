-- Peakhill NBA Survivor: commissioner access.
-- Run in Supabase → SQL Editor. Safe to re-run.

-- Who is a commissioner. No API policies: rows can only be added here, in the SQL editor.
create table if not exists public.admins (
  user_id uuid primary key references public.profiles(id) on delete cascade
);
alter table public.admins enable row level security;

create or replace function public.is_admin() returns boolean
  language sql stable security definer set search_path = public
  as $$ select exists (select 1 from admins where user_id = auth.uid()) $$;

-- Members with email and last sign-in. Empty for anyone who isn't a commissioner.
create or replace function public.admin_members()
  returns table (user_id uuid, display_name text, email text, joined_at timestamptz, last_sign_in_at timestamptz)
  language sql stable security definer set search_path = public
  as $$
    select p.id, p.display_name, u.email::text, p.created_at, u.last_sign_in_at
    from profiles p join auth.users u on u.id = p.id
    where public.is_admin()
    order by p.created_at
  $$;

-- Who has picked for a week, and how many slots. Counts only, never the players,
-- so the commissioner gets no edge before the lock.
create or replace function public.admin_pick_status(w int)
  returns table (user_id uuid, slots int, backups int, last_saved timestamptz)
  language sql stable security definer set search_path = public
  as $$
    select pk.user_id, count(*)::int, count(pk.alt_id)::int, max(pk.updated_at)
    from picks pk
    where pk.week = w and public.is_admin()
    group by pk.user_id
  $$;

revoke execute on function public.admin_members() from public, anon;
revoke execute on function public.admin_pick_status(int) from public, anon;
grant execute on function public.admin_members() to authenticated;
grant execute on function public.admin_pick_status(int) to authenticated;

-- ---- Removing members ----

-- Emails that can't sign up again. Only reachable through the functions below.
create table if not exists public.blocked_emails (
  email text primary key,
  blocked_at timestamptz not null default now()
);
alter table public.blocked_emails enable row level security;

-- Deletes the account and everything tied to it (profile, picks, jokers), and
-- optionally blocks the email. Commissioners can't remove themselves or each other.
create or replace function public.admin_remove_member(target uuid, block boolean default true)
  returns void
  language plpgsql security definer set search_path = public
  as $$
  declare target_email text;
  begin
    if not public.is_admin() then raise exception 'Only the commissioner can remove members.'; end if;
    if target = auth.uid() then raise exception 'You can''t remove yourself.'; end if;
    if exists (select 1 from public.admins a where a.user_id = target) then
      raise exception 'That member is a commissioner. Remove them from the admins table first.';
    end if;
    select u.email into target_email from auth.users u where u.id = target;
    if block and target_email is not null then
      insert into public.blocked_emails (email) values (lower(target_email)) on conflict do nothing;
    end if;
    delete from auth.users u where u.id = target;
  end
  $$;

create or replace function public.admin_blocked()
  returns table (email text, blocked_at timestamptz)
  language sql stable security definer set search_path = public
  as $$ select b.email, b.blocked_at from blocked_emails b where public.is_admin() order by b.blocked_at desc $$;

create or replace function public.admin_unblock(target_email text)
  returns void
  language plpgsql security definer set search_path = public
  as $$
  begin
    if not public.is_admin() then raise exception 'Only the commissioner can do that.'; end if;
    delete from public.blocked_emails b where b.email = lower(target_email);
  end
  $$;

-- Sign-ups from blocked emails fail.
create or replace function public.reject_blocked_signup()
  returns trigger
  language plpgsql security definer set search_path = public
  as $$
  begin
    if exists (select 1 from public.blocked_emails b where b.email = lower(new.email)) then
      raise exception 'This email has been removed from the league.';
    end if;
    return new;
  end
  $$;
drop trigger if exists reject_blocked_signup on auth.users;
create trigger reject_blocked_signup before insert on auth.users
  for each row execute function public.reject_blocked_signup();

revoke execute on function public.admin_remove_member(uuid, boolean) from public, anon;
revoke execute on function public.admin_blocked() from public, anon;
revoke execute on function public.admin_unblock(text) from public, anon;
grant execute on function public.admin_remove_member(uuid, boolean) to authenticated;
grant execute on function public.admin_blocked() to authenticated;
grant execute on function public.admin_unblock(text) to authenticated;
