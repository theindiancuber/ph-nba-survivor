# Peakhill NBA Survivor

A free, season-long NBA player-survivor league for the office. Every week you pick a scorer (**Bucket**), a rebounder (**Glass**), a passer (**Dime**) and a team to win (**Dub**). Each pick scores its weekly total. Once you use a player or team in a category, it's burned in that category for the season. You score 1 point for every colleague your pick beats, keep 3 lives on the survivor ladder, and play two Jokers. Champions get a downloadable certificate. Rules and design notes are in [CONCEPT.md](CONCEPT.md).

**Try it now:** serve the folder and open `/?demo`. You'll get a made-up league frozen in early December, with week 6 live and week 7 open for picks.

```
npm run serve     # http://localhost:8080/?demo
npm test          # league engine + data pipeline tests
```

## How it fits together

| Piece | What it does |
|---|---|
| `index.html`, `styles.css`, `src/app.js` | The app. Static files, no build step. |
| `src/league.js` | The rules engine: burns, backups, rank scoring, lives, drops, Monthly Crowns, awards, head-to-head, Autopilot. Shared by the app and the data script. |
| `src/config.js` | League settings: name, commissioner, bars, calendar, Supabase keys. |
| `supabase/schema.sql` | Accounts, picks and jokers, with row-level security. You can only write your own picks, only before the lock, and nobody can see anyone else's picks until the lock. |
| `scripts/update-data.mjs` + `.github/workflows/update-data.yml` | Hourly on game nights: pulls the NBA schedule and box scores into `data/`, moves each week's lock to the real first tip-off, and runs Autopilot for empty slots after the lock. |

## Setup (about 15 minutes)

1. **Create a Supabase project** (free tier) at supabase.com.
   - SQL Editor → paste `supabase/schema.sql` → Run.
   - Authentication → Sign In / Providers → Email: turn **off** "Confirm email". Colleagues then join with an email and password and no inbox step (Supabase's built-in mailer only sends a few emails an hour).
   - Project Settings → API: copy the **Project URL** and **anon public** key into `src/config.js` (`supabaseUrl`, `supabaseAnonKey`). Set `commissioner` to the name you want on certificates.
2. **Add two repository secrets** (GitHub → Settings → Secrets and variables → Actions):
   - `SUPABASE_URL`: the Project URL
   - `SUPABASE_SERVICE_ROLE_KEY`: the **service_role** key from the same page. Keep it out of `config.js`: it bypasses all security and is only used by the hourly job.
3. **Merge to `main`**, then Actions → "Update NBA data" → **Run workflow** once. It should commit `data/weeks.json`, `players.json`, `totals.json` and box scores under `data/games/`. After that it runs hourly on its own.
4. **Host it.** The repo is private, and GitHub Pages on a private repo needs a paid plan. Pick one:
   - Make the repo public and turn on Pages (Settings → Pages → Deploy from branch → `main` / root). Nothing in the repo is secret: the anon key is meant to be public, and the service key lives in Actions secrets.
   - Or connect the repo to Netlify. Leave the build command empty and set the publish directory to `/`. It redeploys whenever the hourly job commits data.
5. **Share the link.** Picks for week 1 lock at the first tip-off on Tuesday, Oct 20.

## Commissioner tab

Run `supabase/admin.sql` and then `supabase/upgrade-dub-invite.sql` in the Supabase SQL editor (both are safe to re-run), then make yourself commissioner:

```sql
insert into public.admins (user_id)
select id from public.profiles where display_name = 'Your display name'
on conflict do nothing;
```

Sign out and back in. A **Commissioner** tab appears with:
- **Member list:** everyone's email and when they were last seen.
- **Invite code:** new sign-ups need it (the database rejects them otherwise). Copy an invite link that fills it in, change it, or turn it off. Changing it doesn't affect people who've already joined.
- **This week's check-in:** who has filled 0–4 slots, with a button to copy the emails of people who still need to pick.
- **Burn ledger:** search any player to see who burned him, in which category and when.
- **League-wide stats:** most-burned players, untouched gems, firepower left, playing styles, and the best and worst picks of the season.
- **Best strategy (hindsight):** each final week's perfect three picks, the perfect season plan per category (every player used at most once, the same rule everyone plays under), and how close each person came to it.
- **Remove member:** deletes the account with its picks and jokers, and by default blocks that email from signing up again. Blocked emails are listed with an **Unblock** button.

The database only answers these requests for accounts in the `admins` table. Before a lock, the check-in shows how many slots each person has filled, never which players.

## Things to know

- **Stats source:** NBA.com's public JSON (`cdn.nba.com`: the season schedule and per-game box scores). It's free and unofficial. Player headshots and team logos also load from there. If NBA.com ever blocks the hourly job, the parser in `scripts/update-data.mjs` is the only place that needs changing.
- **Player pool:** built from box scores, so it fills in from preseason games. A player who hasn't appeared in a box score yet can't be picked until he does.
- **Scoring is computed in the browser** from picks plus `data/totals.json`, using the same engine the tests cover. A tampered pick (for example, an already-burned player) simply scores 0.
- **Changing rules:** bars, lives and drops live in `src/config.js`. The calendar is `buildWeeks()` in the same file.
