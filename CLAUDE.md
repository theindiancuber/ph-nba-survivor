# Peakhill NBA Survivor: notes for changes

- Static app (`index.html`, `styles.css`, `src/*.js`), no build step. Rules engine in `src/league.js`, tests in `test/` (`npm test`). Preview with `npm run serve` and `/?demo`.
- **Player-facing changes need a "What's new" entry.** When a change affects how people play or what they see (rules, scoring, picks, screens they use), add an entry to the top of `UPDATES` in `src/updates.js` with the next `id`, the date and short plain-language bullets. Players see it once on their next visit. Commissioner-only changes (the Commissioner tab, SQL, data job, internal fixes) don't get an entry.
- If a change alters the rules covered by the first-login tour (`TOUR` in `src/app.js`) or the Rules tab, update those too.
- League rules (bars, lives, card numbers and more) can be changed by the commissioner in the Commissioner tab. `src/config.js` has the defaults; `src/settings.js` applies the overrides. A new rule number the commissioner should control goes in `settings.js` (`LIMITS` plus the week or season paths) and the Commissioner tab form.
- Before pushing, run `npm test` and the smoke test (`npm run smoke`, needs Playwright). CI runs both on every PR, and a red CI must not be merged. After resolving merge conflicts, run them again: a bad merge took the site down once.
- Database changes ship as a re-runnable SQL file in `supabase/` that the commissioner runs in the Supabase SQL editor before merging.
