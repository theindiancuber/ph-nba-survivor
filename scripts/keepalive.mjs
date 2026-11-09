// Keeps the Supabase project awake. The free tier pauses a project after about a week
// with no database activity. The data job usually counts as activity, but only when the
// NBA/NHL feeds and the tests are working. This script depends on nothing else: it runs
// one small read per league (NBA in public, NHL in the nhl schema) and fails if either
// read doesn't come back.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
const url = process.env.SUPABASE_URL?.replace(/\/$/, '');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
  process.exit(1);
}

async function ping(schema) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${url}/rest/v1/weeks?select=week&limit=1`, {
        headers: { apikey: key, Authorization: `Bearer ${key}`, 'Accept-Profile': schema },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`);
      await res.json();
      console.log(`${schema}: ok`);
      return;
    } catch (e) {
      if (attempt >= 3) throw new Error(`${schema}: ${e.message}`);
      console.warn(`${schema}: ${e.message}; retrying in 30s.`);
      await new Promise(r => setTimeout(r, 30000));
    }
  }
}

try {
  await ping('public');
  await ping('nhl');
} catch (e) {
  console.error(`Supabase did not answer: ${e.message}`);
  console.error('If the project is paused, restore it from the Supabase dashboard (Project → Restore).');
  process.exit(1);
}
