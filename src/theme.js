// Light or dark theme. A classic script loaded in <head>, so the page never paints in the wrong one.
// A choice made with the header button is kept on this device for both leagues (phs-theme);
// until then the device's own setting decides.
(function () {
  const root = document.documentElement;
  const KEY = 'phs-theme';
  const device = () => (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch { /* storage blocked */ }
  const apply = (theme) => {
    root.dataset.theme = theme;
    const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta && bg) meta.content = bg;
    const btn = document.getElementById('theme-toggle');
    if (btn) {
      const next = theme === 'light' ? 'dark' : 'light';
      btn.textContent = theme === 'light' ? '☾' : '☀';
      btn.title = btn.ariaLabel = `Switch to the ${next} theme`;
    }
  };
  apply(saved === 'light' || saved === 'dark' ? saved : device());
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    let s = null;
    try { s = localStorage.getItem(KEY); } catch { /* storage blocked */ }
    if (!s) apply(device());
  });
  document.addEventListener('DOMContentLoaded', () => {
    apply(root.dataset.theme);
    document.getElementById('theme-toggle')?.addEventListener('click', () => {
      const theme = root.dataset.theme === 'light' ? 'dark' : 'light';
      try { localStorage.setItem(KEY, theme); } catch { /* storage blocked */ }
      apply(theme);
    });
  });
})();
