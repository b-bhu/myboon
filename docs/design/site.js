/* Design reference — shared navigation.
   Adds a route back to the design hub on every page. The single-screen
   viewer (?proto&embed=1) is left untouched so it never covers a capture. */
(function () {
  if (new URLSearchParams(location.search).has('embed')) return;
  if (document.querySelector('.hub-back')) return;
  if (document.body.hasAttribute('data-no-hub-back')) return;

  var inFolder = /\/(charts|market-experience|web-landing-page|wallet-connect)\//.test(location.pathname);
  if (!inFolder && /\/index\.html$/.test(location.pathname)) return;

  var params = new URLSearchParams(location.search);
  var proto = params.has('proto');

  if (proto) {
    var p = document.createElement('a');
    p.className = 'hub-proto-back';
    p.href = inFolder ? '../index.html' : 'index.html';
    p.textContent = '← Design index';
    var ps = document.createElement('style');
    ps.textContent = [
      '.hub-proto-back{display:inline-flex;align-items:center;gap:6px;margin:0 0 10px;',
      'color:#FFD166;text-decoration:none;font:600 10px/1 ui-monospace,SFMono-Regular,Menlo,monospace;',
      'letter-spacing:.1em;text-transform:uppercase}',
      '.hub-proto-back:hover,.hub-proto-back:focus-visible{color:#F5FAFC}'
    ].join('');
    document.head.appendChild(ps);
    document.body.insertBefore(p, document.body.firstChild);
    return;
  }

  var a = document.createElement('a');
  a.className = 'hub-back';
  a.href = inFolder ? '../index.html' : 'index.html';
  a.setAttribute('aria-label', 'Back to the design index');
  a.title = 'Design index';
  a.innerHTML = '<span aria-hidden="true">←</span>';

  var s = document.createElement('style');
  s.textContent = [
    '.hub-back{position:fixed;left:14px;bottom:14px;z-index:9999;width:40px;height:40px;',
    'display:grid;place-items:center;border-radius:50%;text-decoration:none;',
    'background:rgba(2,24,33,.9);border:1px solid #185A70;color:#F5FAFC;',
    'font:600 18px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;',
    'box-shadow:0 6px 20px rgba(0,0,0,.35);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px)}',
    '.hub-back:hover,.hub-back:focus-visible{border-color:#FFD166;color:#FFD166}',
    '@media print{.hub-back{display:none}}'
  ].join('');
  document.head.appendChild(s);
  document.body.appendChild(a);
})();
