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
