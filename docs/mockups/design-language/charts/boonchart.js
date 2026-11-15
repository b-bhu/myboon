/* BoonChart — tiny mobile chart library. No dependencies, no build step.
 *
 * Why it exists: beginners read a chart in about two seconds. They want the
 * line's direction, the last number, and one tap to answer "what was it on
 * Tuesday?". Everything here serves that and nothing else.
 *
 * Usage:
 *   BoonChart.line(el, { data: [1,2,3], ... })
 *   BoonChart.area(el, {...})  BoonChart.bars(el, {...})
 *   BoonChart.donut(el, { slices: [{label,value}] })
 *   BoonChart.sparkline(el, { data: [...] })
 *
 * Every chart returns a handle: { update(data), destroy() }.
 *
 * Deliberately NOT here: zoom, pan, log scales, candlesticks, multi-axis,
 * legends with 12 series, animation easing curves. A beginner reading a chart
 * on a phone needs none of it, and each one costs clarity.
 */
(function (global) {
  'use strict';

  /* ---------- theme: one place, overridable per chart ---------- */
  var THEME = {
    ink: '#F5FAFC',        // primary text
    dim: '#9CB8C2',        // secondary text
    faint: '#6B95A1',      // axis labels
    grid: '#185A70',       // hairlines
    up: '#06D6A0',         // positive
    down: '#EF476F',       // negative
    neutral: '#118AB2',
    accent: '#FFD166',
    bg: 'transparent',
    font: 'ui-monospace, "SF Mono", Menlo, monospace',
    labelSize: 10,
    // Categorical colours for donut / grouped bars. Ordered so the first two
    // are always distinguishable to colour-blind readers.
    series: ['#FFD166', '#118AB2', '#06D6A0', '#EF476F', '#9945FF', '#61D7EF']
  };

  /* ---------- small helpers ---------- */

  function extend(a, b) { for (var k in b) if (b.hasOwnProperty(k)) a[k] = b[k]; return a; }

  function opts(user, defaults) {
    var o = extend({}, defaults);
    extend(o, user || {});
    o.theme = extend(extend({}, THEME), (user && user.theme) || {});
    return o;
  }

  // Numbers people can read: 1.2K, 3.4M, 12.50
  function shortNum(n) {
    var abs = Math.abs(n);
    if (abs >= 1e9) return trim(n / 1e9) + 'B';
    if (abs >= 1e6) return trim(n / 1e6) + 'M';
    if (abs >= 1e3) return trim(n / 1e3) + 'K';
    if (abs >= 100) return Math.round(n).toString();
    if (abs >= 1) return trim(n);
    return trim(n, 2);
  }
  function trim(n, dp) {
    var s = n.toFixed(dp === undefined ? 1 : dp);
    return s.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
  }

  // Normalise input. Accepts [1,2,3] or [{x,y}] or [{label,value}].
  function normalise(data) {
    var out = [], i, d;
    for (i = 0; i < data.length; i++) {
      d = data[i];
      if (typeof d === 'number') out.push({ v: d, label: null });
      else out.push({ v: d.y !== undefined ? d.y : d.value, label: d.x !== undefined ? d.x : (d.label || null) });
    }
    return out;
  }

  function extent(pts, opt) {
    var lo = Infinity, hi = -Infinity, i;
    for (i = 0; i < pts.length; i++) { if (pts[i].v < lo) lo = pts[i].v; if (pts[i].v > hi) hi = pts[i].v; }
    if (lo === Infinity) { lo = 0; hi = 1; }
    if (opt.zeroBased) lo = Math.min(0, lo);
    if (lo === hi) { lo -= 1; hi += 1; }           // flat series still needs a band
    var pad = (hi - lo) * (opt.padding === undefined ? 0.12 : opt.padding);
    return { lo: lo - pad, hi: hi + pad };
  }

  // "Nice" round tick values — people read 0 / 50 / 100, not 3.7 / 41.2
  function ticks(lo, hi, count) {
    var span = hi - lo;
    if (span <= 0) return [lo];
    var raw = span / Math.max(1, count);
    var mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var norm = raw / mag;
    var step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
    var out = [], t = Math.ceil(lo / step) * step;
    for (; t <= hi + step * 0.001; t += step) out.push(Math.round(t / step) * step);
    return out;
  }

  /* ---------- canvas setup, retina-correct ---------- */

  function makeCanvas(el, height) {
    var cv = document.createElement('canvas');
    cv.style.display = 'block';
    cv.style.width = '100%';
    cv.style.height = height + 'px';
    cv.style.touchAction = 'pan-y';   // let the page scroll vertically; we take horizontal
    el.appendChild(cv);
    return cv;
  }

  function sizeCanvas(cv) {
    var dpr = global.devicePixelRatio || 1;
    var w = cv.clientWidth || 300, h = cv.clientHeight || 160;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: w, h: h };
  }

  // Redraw on resize / rotate, debounced to one frame.
  function onResize(cv, draw) {
    var raf = null;
    function go() { if (raf) return; raf = requestAnimationFrame(function () { raf = null; draw(); }); }
    var ro = null;
    if (global.ResizeObserver) { ro = new ResizeObserver(go); ro.observe(cv); }
    else global.addEventListener('resize', go);
    return function () { if (ro) ro.disconnect(); else global.removeEventListener('resize', go); };
  }

  /* ---------- touch scrubbing ----------
   * One finger down anywhere on the chart snaps to the nearest point and
   * reports it. No long-press, no double-tap: a beginner's first instinct is
   * to put a finger on the line, so that is the whole interaction.
   */
  function scrub(cv, hit, onMove, onEnd) {
    var active = false;

    function pos(e) {
      var r = cv.getBoundingClientRect();
      var t = e.touches ? e.touches[0] : e;
      return { x: t.clientX - r.left, y: t.clientY - r.top };
    }
    function start(e) { active = true; var p = pos(e); onMove(hit(p.x, p.y), p); }
    function move(e) {
      if (!active) return;
      e.preventDefault();                 // we own the gesture now
      var p = pos(e); onMove(hit(p.x, p.y), p);
    }
    function end() { if (!active) return; active = false; onEnd(); }

    cv.addEventListener('touchstart', start, { passive: true });
    cv.addEventListener('touchmove', move, { passive: false });
    cv.addEventListener('touchend', end);
    cv.addEventListener('touchcancel', end);
    // Mouse, so the mock is reviewable on a laptop.
    cv.addEventListener('mousedown', start);
    cv.addEventListener('mousemove', function (e) { if (active) move(e); });
    global.addEventListener('mouseup', end);
    cv.addEventListener('mouseleave', end);

    return function () {
      cv.removeEventListener('touchstart', start);
      cv.removeEventListener('touchmove', move);
      cv.removeEventListener('touchend', end);
      cv.removeEventListener('touchcancel', end);
      cv.removeEventListener('mousedown', start);
      global.removeEventListener('mouseup', end);
    };
  }

  /* ---------- the readout above the chart ----------
   * Beginners get the number as text, not as a floating bubble they have to
   * hunt for. It lives in a fixed row above the plot so nothing reflows.
   */
  function makeReadout(el, o) {
    if (o.readout === false) return null;
    var box = document.createElement('div');
    box.style.cssText = 'display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:8px;min-height:22px';
    var left = document.createElement('div');
    left.style.cssText = 'font:600 20px ' + o.theme.font + ';color:' + o.theme.ink + ';letter-spacing:-.3px';
    var right = document.createElement('div');
    right.style.cssText = 'font:10px ' + o.theme.font + ';letter-spacing:1px;text-transform:uppercase;color:' + o.theme.faint;
    box.appendChild(left); box.appendChild(right);
    el.appendChild(box);
    return {
      set: function (value, note) {
        left.textContent = value == null ? '' : value;
        right.textContent = note || '';
      }
    };
  }

  function fmt(o, v) { return (o.prefix || '') + (o.format ? o.format(v) : shortNum(v)) + (o.suffix || ''); }

  // Reserve exactly as much right-hand space as the widest y label needs,
  // so "$-100" is never clipped and "5" never wastes a gutter.
  function gutter(ctx, o, ex) {
    var T = o.theme, tk = ticks(ex.lo, ex.hi, o.yTicks), widest = 0, i, wd;
    ctx.save();
    ctx.font = T.labelSize + 'px ' + T.font;
    for (i = 0; i < tk.length; i++) {
      wd = ctx.measureText(fmt(o, tk[i])).width;
      if (wd > widest) widest = wd;
    }
    ctx.restore();
    return Math.min(72, Math.ceil(widest) + 10);
  }

  /* =================================================================
   * LINE / AREA
   * ================================================================= */

  function lineLike(el, user, filled) {
    var o = opts(user, {
      height: 180,
      data: [],
      zeroBased: false,
      smooth: true,
      yTicks: 3,
      xLabels: true,
      showLast: true,
      colorByTrend: true,   // green when it ended up, red when it ended down
      label: '',            // text shown on the right of the readout at rest
      readout: true
    });
    el.innerHTML = '';
    var T = o.theme;
    var pts = normalise(o.data);
    var out = makeReadout(el, o);
    var cv = makeCanvas(el, o.height);
    var geom = null, held = -1;

    function trendColor() {
      if (!o.color && o.colorByTrend && pts.length > 1)
        return pts[pts.length - 1].v >= pts[0].v ? T.up : T.down;
      return o.color || T.neutral;
    }

    function restReadout() {
      if (!out || !pts.length) return;
      var last = pts[pts.length - 1].v;
      var note = o.label;
      if (o.showLast && pts.length > 1) {
        var first = pts[0].v;
        var pct = first === 0 ? 0 : ((last - first) / Math.abs(first)) * 100;
        var sign = pct >= 0 ? '+' : '';
        note = sign + trim(pct, 1) + '%' + (o.label ? ' · ' + o.label : '');
      }
      out.set(fmt(o, last), note);
    }

    function draw() {
      var s = sizeCanvas(cv), ctx = s.ctx, w = s.w, h = s.h;
      ctx.clearRect(0, 0, w, h);
      if (!pts.length) return;

      // Room for y labels on the right (thumb sits on the left when scrubbing)
      // and one line of x labels at the bottom.
      var ex = extent(pts, o);
      var padR = o.yTicks ? gutter(ctx, o, ex) : 4, padB = o.xLabels ? 16 : 4, padT = 6, padL = 2;
      var pw = Math.max(10, w - padL - padR), ph = Math.max(10, h - padT - padB);
      var xAt = function (i) { return padL + (pts.length === 1 ? pw / 2 : (i / (pts.length - 1)) * pw); };
      var yAt = function (v) { return padT + ph - ((v - ex.lo) / (ex.hi - ex.lo)) * ph; };
      geom = { xAt: xAt, yAt: yAt, padL: padL, pw: pw, padT: padT, ph: ph };

      // grid + y labels
      if (o.yTicks) {
        var tk = ticks(ex.lo, ex.hi, o.yTicks);
        ctx.font = T.labelSize + 'px ' + T.font;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        for (var i = 0; i < tk.length; i++) {
          var y = yAt(tk[i]);
          if (y < padT - 1 || y > padT + ph + 1) continue;
          ctx.strokeStyle = T.grid;
          ctx.globalAlpha = 0.45;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(padL, Math.round(y) + 0.5);
          ctx.lineTo(padL + pw, Math.round(y) + 0.5);
          ctx.stroke();
          ctx.globalAlpha = 1;
          ctx.fillStyle = T.faint;
          ctx.fillText(fmt(o, tk[i]), padL + pw + 6, y);
        }
      }

      var col = trendColor();

      // the path
      ctx.beginPath();
      ctx.moveTo(xAt(0), yAt(pts[0].v));
      for (var j = 1; j < pts.length; j++) {
        if (o.smooth) {
          // Monotone-ish midpoint curve: smooth enough to look calm, never
          // overshoots into inventing values that are not in the data.
          var mx = (xAt(j - 1) + xAt(j)) / 2;
          ctx.bezierCurveTo(mx, yAt(pts[j - 1].v), mx, yAt(pts[j].v), xAt(j), yAt(pts[j].v));
        } else ctx.lineTo(xAt(j), yAt(pts[j].v));
      }

      if (filled) {
        var fillPath = new Path2D();
        // rebuild for fill so the stroke stays crisp
        fillPath.moveTo(xAt(0), yAt(pts[0].v));
        for (var k = 1; k < pts.length; k++) {
          if (o.smooth) {
            var mx2 = (xAt(k - 1) + xAt(k)) / 2;
            fillPath.bezierCurveTo(mx2, yAt(pts[k - 1].v), mx2, yAt(pts[k].v), xAt(k), yAt(pts[k].v));
          } else fillPath.lineTo(xAt(k), yAt(pts[k].v));
        }
        fillPath.lineTo(xAt(pts.length - 1), padT + ph);
        fillPath.lineTo(xAt(0), padT + ph);
        fillPath.closePath();
        var g = ctx.createLinearGradient(0, padT, 0, padT + ph);
        g.addColorStop(0, col + '59');
        g.addColorStop(1, col + '00');
        ctx.fillStyle = g;
        ctx.fill(fillPath);
      }

      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke();

      // last-point dot: tells you where "now" is without reading the axis
      if (o.showLast) {
        var lx = xAt(pts.length - 1), ly = yAt(pts[pts.length - 1].v);
        ctx.fillStyle = col;
        ctx.beginPath(); ctx.arc(lx, ly, 3, 0, Math.PI * 2); ctx.fill();
      }

      // x labels: only first and last, so they never collide on a phone
      if (o.xLabels) {
        ctx.font = T.labelSize + 'px ' + T.font;
        ctx.fillStyle = T.faint;
        ctx.textBaseline = 'bottom';
        var a = pts[0].label, b = pts[pts.length - 1].label;
        if (a) { ctx.textAlign = 'left'; ctx.fillText(String(a), padL, h - 2); }
        if (b) { ctx.textAlign = 'right'; ctx.fillText(String(b), padL + pw, h - 2); }
      }

      // scrub marker
      if (held >= 0 && held < pts.length) {
        var hx = xAt(held), hy = yAt(pts[held].v);
        ctx.strokeStyle = T.grid;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(hx) + 0.5, padT);
        ctx.lineTo(Math.round(hx) + 0.5, padT + ph);
        ctx.stroke();
        ctx.fillStyle = T.ink;
        ctx.beginPath(); ctx.arc(hx, hy, 4.5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = col;
        ctx.beginPath(); ctx.arc(hx, hy, 2.5, 0, Math.PI * 2); ctx.fill();
      }
    }

    function hit(x) {
      if (!geom || !pts.length) return -1;
      var r = (x - geom.padL) / geom.pw * (pts.length - 1);
      return Math.max(0, Math.min(pts.length - 1, Math.round(r)));
    }

    var stopScrub = scrub(cv, hit,
      function (i) {
        held = i;
        if (out && i >= 0) out.set(fmt(o, pts[i].v), pts[i].label ? String(pts[i].label) : '');
        draw();
      },
      function () { held = -1; restReadout(); draw(); });

    var stopResize = onResize(cv, draw);
    restReadout();
    draw();

    return {
      // update(data) or update(data, { label: '1Y' }) to change the resting note
      update: function (data, next) {
        pts = normalise(data);
        if (next) extend(o, next);
        held = -1; restReadout(); draw();
      },
      destroy: function () { stopScrub(); stopResize(); el.innerHTML = ''; }
    };
  }

  /* =================================================================
   * BARS — vertical, one tap reads a bar. Positive/negative aware.
   * ================================================================= */

  function bars(el, user) {
    var o = opts(user, {
      height: 180,
      data: [],
      yTicks: 3,
      xLabels: true,
      readout: true,
      label: '',
      signed: false,        // colour negatives red, draw a zero line
      color: null
    });
    el.innerHTML = '';
    var T = o.theme;
    var pts = normalise(o.data);
    var out = makeReadout(el, o);
    var cv = makeCanvas(el, o.height);
    var geom = null, held = -1;

    function restReadout() {
      if (!out || !pts.length) return;
      var sum = 0; for (var i = 0; i < pts.length; i++) sum += pts[i].v;
      out.set(fmt(o, sum), o.label || 'TOTAL');
    }

    function barColor(v) {
      if (o.signed) return v < 0 ? T.down : T.up;
      return o.color || T.neutral;
    }

    function draw() {
      var s = sizeCanvas(cv), ctx = s.ctx, w = s.w, h = s.h;
      ctx.clearRect(0, 0, w, h);
      if (!pts.length) return;

      var ex = extent(pts, extend(extend({}, o), { zeroBased: !o.signed, padding: 0.08 }));
      if (o.signed) { var m = Math.max(Math.abs(ex.lo), Math.abs(ex.hi)); ex = { lo: -m, hi: m }; }
      var padR = o.yTicks ? gutter(ctx, o, ex) : 4, padB = o.xLabels ? 16 : 4, padT = 6, padL = 2;
      var pw = Math.max(10, w - padL - padR), ph = Math.max(10, h - padT - padB);

      var yAt = function (v) { return padT + ph - ((v - ex.lo) / (ex.hi - ex.lo)) * ph; };
      var slot = pw / pts.length;
      var bw = Math.max(3, Math.min(slot * 0.62, 28));
      var xAt = function (i) { return padL + slot * i + slot / 2; };
      geom = { padL: padL, pw: pw, slot: slot };

      if (o.yTicks) {
        var tk = ticks(ex.lo, ex.hi, o.yTicks);
        ctx.font = T.labelSize + 'px ' + T.font;
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        for (var i = 0; i < tk.length; i++) {
          var y = yAt(tk[i]);
          if (y < padT - 1 || y > padT + ph + 1) continue;
          ctx.strokeStyle = T.grid;
          ctx.globalAlpha = tk[i] === 0 ? 0.9 : 0.4;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(padL, Math.round(y) + 0.5); ctx.lineTo(padL + pw, Math.round(y) + 0.5);
          ctx.stroke();
          ctx.globalAlpha = 1;
          ctx.fillStyle = T.faint;
          ctx.fillText(fmt(o, tk[i]), padL + pw + 6, y);
        }
      }

      var zero = yAt(o.signed ? 0 : Math.max(ex.lo, 0));
      for (var j = 0; j < pts.length; j++) {
        var v = pts[j].v, y = yAt(v);
        var top = Math.min(y, zero), bh = Math.max(1.5, Math.abs(y - zero));
        ctx.fillStyle = barColor(v);
        ctx.globalAlpha = held < 0 || held === j ? 1 : 0.35;   // tapped bar stays bright
        roundRect(ctx, xAt(j) - bw / 2, top, bw, bh, Math.min(3, bw / 2));
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      if (o.xLabels) {
        ctx.font = T.labelSize + 'px ' + T.font;
        ctx.fillStyle = T.faint;
        ctx.textBaseline = 'bottom';
        ctx.textAlign = 'center';
        // Drop labels until they fit — never overlap, never rotate.
        var every = Math.ceil((pts.length * 26) / pw);
        for (var k = 0; k < pts.length; k++) {
          if (!pts[k].label) continue;
          if (k % every !== 0 && k !== pts.length - 1) continue;
          ctx.fillText(String(pts[k].label), xAt(k), h - 2);
        }
      }
    }

    function roundRect(ctx, x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
      ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
      ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
    }

    function hit(x) {
      if (!geom || !pts.length) return -1;
      return Math.max(0, Math.min(pts.length - 1, Math.floor((x - geom.padL) / geom.slot)));
    }

    var stopScrub = scrub(cv, hit,
      function (i) {
        held = i;
        if (out && i >= 0) out.set(fmt(o, pts[i].v), pts[i].label ? String(pts[i].label) : '');
        draw();
      },
      function () { held = -1; restReadout(); draw(); });

    var stopResize = onResize(cv, draw);
    restReadout(); draw();

    return {
      update: function (d, next) {
        pts = normalise(d);
        if (next) extend(o, next);
        held = -1; restReadout(); draw();
      },
      destroy: function () { stopScrub(); stopResize(); el.innerHTML = ''; }
    };
  }

  /* =================================================================
   * DONUT — "what is this made of". Max ~5 slices; the rest becomes Other,
   * because beyond that nobody can match a colour to a label on a phone.
   * ================================================================= */

  function donut(el, user) {
    var o = opts(user, {
      height: 200,
      slices: [],
      maxSlices: 5,
      centerLabel: '',
      thickness: 0.28,     // of radius
      legend: true,
      readout: false
    });
    el.innerHTML = '';
    var T = o.theme;

    function prep(slices) {
      var s = slices.slice().map(function (d, i) {
        return { label: d.label || ('Item ' + (i + 1)), value: Math.max(0, d.value), color: d.color || null };
      }).sort(function (a, b) { return b.value - a.value; });
      if (s.length > o.maxSlices) {
        var rest = s.slice(o.maxSlices - 1);
        var sum = rest.reduce(function (t, d) { return t + d.value; }, 0);
        s = s.slice(0, o.maxSlices - 1);
        s.push({ label: 'Other', value: sum, color: T.grid });
      }
      s.forEach(function (d, i) { if (!d.color) d.color = T.series[i % T.series.length]; });
      return s;
    }

    var data = prep(o.slices);
    var cv = makeCanvas(el, o.height);
    var legendEl = null, held = -1;
    var geom = null;

    if (o.legend) {
      legendEl = document.createElement('div');
      legendEl.style.cssText = 'margin-top:12px;display:flex;flex-direction:column;gap:6px';
      el.appendChild(legendEl);
    }

    function total() { return data.reduce(function (t, d) { return t + d.value; }, 0); }

    function renderLegend() {
      if (!legendEl) return;
      var tot = total() || 1;
      legendEl.innerHTML = '';
      data.forEach(function (d, i) {
        var row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;font:12px ' + T.font +
          ';color:' + (held < 0 || held === i ? T.ink : T.dim) + ';opacity:' + (held < 0 || held === i ? 1 : .5);
        row.innerHTML =
          '<i style="flex:0 0 10px;height:10px;border-radius:2px;background:' + d.color + '"></i>' +
          '<span style="flex:1;font-family:Roboto,system-ui,sans-serif;font-size:14px">' + esc(d.label) + '</span>' +
          '<b style="font-weight:600">' + trim((d.value / tot) * 100, 1) + '%</b>';
        legendEl.appendChild(row);
      });
    }

    function draw() {
      var s = sizeCanvas(cv), ctx = s.ctx, w = s.w, h = s.h;
      ctx.clearRect(0, 0, w, h);
      var tot = total();
      if (!tot) return;

      var cx = w / 2, cy = h / 2;
      var R = Math.min(w, h) / 2 - 4;
      var ring = R * o.thickness;
      geom = { cx: cx, cy: cy, R: R, ring: ring };

      var a0 = -Math.PI / 2;
      for (var i = 0; i < data.length; i++) {
        var frac = data[i].value / tot;
        var a1 = a0 + frac * Math.PI * 2;
        var grow = held === i ? 3 : 0;   // tapped slice lifts out slightly
        ctx.beginPath();
        ctx.arc(cx, cy, R - ring / 2 + grow / 2, a0, a1);
        ctx.strokeStyle = data[i].color;
        ctx.globalAlpha = held < 0 || held === i ? 1 : 0.35;
        ctx.lineWidth = ring + grow;
        ctx.stroke();
        ctx.globalAlpha = 1;
        a0 = a1;
      }

      // centre text: the headline number, or the tapped slice
      var big, small;
      if (held >= 0) { big = trim((data[held].value / tot) * 100, 1) + '%'; small = data[held].label; }
      else { big = o.centerValue != null ? o.centerValue : shortNum(tot); small = o.centerLabel; }

      ctx.textAlign = 'center';
      ctx.fillStyle = T.ink;
      ctx.font = '600 ' + Math.round(R * 0.38) + 'px ' + T.font;
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(String(big), cx, cy + (small ? 2 : R * 0.13));
      if (small) {
        ctx.fillStyle = T.faint;
        ctx.font = '10px ' + T.font;
        ctx.textBaseline = 'top';
        ctx.fillText(String(small).toUpperCase(), cx, cy + 8);
      }
    }

    function hit(x, y) {
      if (!geom) return -1;
      var dx = x - geom.cx, dy = y - geom.cy;
      var r = Math.sqrt(dx * dx + dy * dy);
      if (r > geom.R + 6 || r < geom.R - geom.ring - 6) return -1;
      var ang = Math.atan2(dy, dx) + Math.PI / 2;
      if (ang < 0) ang += Math.PI * 2;
      var tot = total() || 1, acc = 0;
      for (var i = 0; i < data.length; i++) {
        acc += (data[i].value / tot) * Math.PI * 2;
        if (ang <= acc) return i;
      }
      return data.length - 1;
    }

    var stopScrub = scrub(cv, hit,
      function (i) { held = i; draw(); renderLegend(); },
      function () { held = -1; draw(); renderLegend(); });

    var stopResize = onResize(cv, draw);
    renderLegend(); draw();

    return {
      update: function (slices) { data = prep(slices); held = -1; renderLegend(); draw(); },
      destroy: function () { stopScrub(); stopResize(); el.innerHTML = ''; }
    };
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /* =================================================================
   * SPARKLINE — no axes, no labels, no touch. Fits in a list row.
   * ================================================================= */

  function sparkline(el, user) {
    var o = opts(user, { height: 28, data: [], colorByTrend: true, color: null, fill: true });
    el.innerHTML = '';
    var T = o.theme;
    var pts = normalise(o.data);
    var cv = makeCanvas(el, o.height);
    cv.style.touchAction = 'auto';

    function draw() {
      var s = sizeCanvas(cv), ctx = s.ctx, w = s.w, h = s.h;
      ctx.clearRect(0, 0, w, h);
      if (pts.length < 2) return;
      var ex = extent(pts, { padding: 0.15 });
      var xAt = function (i) { return (i / (pts.length - 1)) * (w - 2) + 1; };
      var yAt = function (v) { return h - 2 - ((v - ex.lo) / (ex.hi - ex.lo)) * (h - 4); };
      var col = o.color || (o.colorByTrend
        ? (pts[pts.length - 1].v >= pts[0].v ? T.up : T.down) : T.neutral);

      ctx.beginPath();
      ctx.moveTo(xAt(0), yAt(pts[0].v));
      for (var i = 1; i < pts.length; i++) ctx.lineTo(xAt(i), yAt(pts[i].v));

      if (o.fill) {
        ctx.save();
        var p = new Path2D();
        p.moveTo(xAt(0), yAt(pts[0].v));
        for (var j = 1; j < pts.length; j++) p.lineTo(xAt(j), yAt(pts[j].v));
        p.lineTo(xAt(pts.length - 1), h); p.lineTo(xAt(0), h); p.closePath();
        ctx.fillStyle = col + '2E';
        ctx.fill(p);
        ctx.restore();
      }
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.stroke();
    }

    var stopResize = onResize(cv, draw);
    draw();
    return {
      update: function (d) { pts = normalise(d); draw(); },
      destroy: function () { stopResize(); el.innerHTML = ''; }
    };
  }

  /* =================================================================
   * PROGRESS — a single number against a goal. The most-read "chart" of all.
   * ================================================================= */

  function progress(el, user) {
    var o = opts(user, { value: 0, max: 100, height: 10, label: '', color: null, showPct: true });
    el.innerHTML = '';
    var T = o.theme;
    var v = o.value;

    var head = document.createElement('div');
    head.style.cssText = 'display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px';
    var l = document.createElement('div');
    l.style.cssText = 'font:10px ' + T.font + ';letter-spacing:1px;text-transform:uppercase;color:' + T.faint;
    var r = document.createElement('div');
    r.style.cssText = 'font:600 15px ' + T.font + ';color:' + T.ink;
    head.appendChild(l); head.appendChild(r); el.appendChild(head);

    var track = document.createElement('div');
    track.style.cssText = 'height:' + o.height + 'px;border-radius:' + (o.height / 2) +
      'px;background:' + T.grid + '55;overflow:hidden';
    var bar = document.createElement('div');
    bar.style.cssText = 'height:100%;border-radius:inherit;background:' + (o.color || T.accent) +
      ';transition:width .35s ease';
    track.appendChild(bar); el.appendChild(track);

    function render() {
      var pct = o.max ? Math.max(0, Math.min(1, v / o.max)) : 0;
      bar.style.width = (pct * 100) + '%';
      l.textContent = o.label;
      r.textContent = o.showPct
        ? Math.round(pct * 100) + '%'
        : fmt(o, v) + ' / ' + fmt(o, o.max);
    }
    render();
    return {
      update: function (nv) { v = nv; render(); },
      destroy: function () { el.innerHTML = ''; }
    };
  }

  /* ---------- public API ---------- */

  global.BoonChart = {
    theme: THEME,
    line: function (el, o) { return lineLike(el, o, false); },
    area: function (el, o) { return lineLike(el, o, true); },
    bars: bars,
    donut: donut,
    sparkline: sparkline,
    progress: progress,
    // exposed because mocks and callers format their own numbers
    shortNum: shortNum
  };
})(window);
