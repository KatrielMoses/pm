// Applies the cached appearance before first paint (DS-23: no flash of the wrong theme). Loaded
// as a same-origin blocking script so the content security policy needs no inline exception.
(function () {
  var root = document.documentElement;
  var a;
  try {
    a = JSON.parse(localStorage.getItem('pm.appearance') || '{}') || {};
  } catch {
    a = {};
  }
  var theme = a.theme === 'light' || a.theme === 'dark' ? a.theme : 'system';
  var dark = theme === 'dark';
  if (theme === 'system') {
    try {
      dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    } catch {
      dark = false;
    }
  }
  root.setAttribute('data-theme', theme);
  root.setAttribute('data-color-scheme', dark ? 'dark' : 'light');
  if (a.density === 'compact') root.setAttribute('data-density', 'compact');
  if (a.motion === 'reduce') root.setAttribute('data-motion', 'reduce');
})();
