// Boot watchdog. A plain script (not a module), so it still runs when the app's
// modules fail to load or parse. If the app hasn't replaced the "Loading the
// league…" placeholder, it shows what went wrong and a Reload button instead of
// spinning forever.
(function () {
  var firstError = null;
  var shown = false;

  function stillLoading() {
    var app = document.getElementById('app');
    return !!(app && app.querySelector('[data-loading]'));
  }

  function show(reason) {
    if (shown || !stillLoading()) return;
    shown = true;
    var app = document.getElementById('app');
    var box = document.createElement('div');
    box.className = 'panel empty-state';
    var ic = document.createElement('div');
    ic.className = 'ic';
    ic.textContent = '⚠️';
    var b = document.createElement('b');
    b.textContent = "The league didn't load.";
    var p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'Check your connection and reload. If it keeps happening, tell the commissioner.';
    var btn = document.createElement('button');
    btn.className = 'btn primary';
    btn.textContent = 'Reload';
    btn.addEventListener('click', function () { location.reload(); });
    box.append(ic, b, p, btn);
    if (reason) {
      var d = document.createElement('p');
      d.className = 'dim';
      d.style.fontSize = '12px';
      d.style.marginTop = '12px';
      d.textContent = 'Details: ' + reason;
      box.append(d);
    }
    app.replaceChildren(box);
  }

  // A module that fails to download or parse surfaces here, before the app can run.
  window.addEventListener('error', function (e) {
    var t = e.target;
    var script = t && t.tagName === 'SCRIPT';
    // Images, fonts and stylesheets failing don't stop the app; only scripts and code errors do.
    if (t && t !== window && !script) return;
    var msg = script ? 'could not load ' + (t.src || 'a script') : e.message;
    if (!firstError) firstError = msg;
    // Before the app has rendered, an error means it never will: say so straight away.
    if (stillLoading()) setTimeout(function () { show(firstError); }, 1500);
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    if (!firstError) firstError = String((e.reason && e.reason.message) || e.reason);
  });

  // Slow network: give it 20 seconds before offering a reload.
  setTimeout(function () { show(firstError || 'took too long to load'); }, 20000);
})();
