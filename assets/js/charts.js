/*
 * charts.js
 * SVG charts for the Havlena–Odeh analyzer, drawn with d3 v7.
 * Colors come from CSS custom properties and are written as explicit attributes,
 * so a chart can be exported to PNG and re-rendered when the theme changes.
 */
(function (root, factory) {
  root.HOCharts = factory(root.d3);
})(typeof self !== 'undefined' ? self : this, function (d3) {
  'use strict';

  var SVGNS = 'http://www.w3.org/2000/svg';

  function tokens() {
    var cs = getComputedStyle(document.documentElement);
    var v = function (n) { return cs.getPropertyValue(n).trim(); };
    return {
      ink: v('--ink'), ink2: v('--ink-2'), muted: v('--muted'),
      line: v('--line'), lineStrong: v('--line-strong'),
      surface: v('--surface'), paper: v('--paper'),
      gridMinor: v('--grid-minor'), gridMajor: v('--grid-major'),
      oil: v('--oil'), gas: v('--gas'), water: v('--water'),
      fontBody: v('--font-body') || 'sans-serif', fontMath: v('--font-math') || 'serif'
    };
  }

  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  /* ---------- formatting ---------- */

  function minus(s) { return String(s).replace(/^-/, '−').replace(/e-/, 'e−'); }

  function fmtSig(v, sig) {
    if (!isFinite(v)) return '–';
    if (v === 0) return '0';
    var a = Math.abs(v);
    if (a >= 1e7 || a < 1e-4) {
      var e = Math.floor(Math.log10(a));
      var mant = v / Math.pow(10, e);
      var sup = String(e).replace(/-/g, '⁻').replace(/[0-9]/g, function (d) { return '⁰¹²³⁴⁵⁶⁷⁸⁹'[+d]; });
      return minus(mant.toFixed(Math.max(0, sig - 1))) + '×10' + sup;
    }
    var d = Math.max(0, sig - 1 - Math.floor(Math.log10(a)));
    return minus(v.toLocaleString('en-US', { minimumFractionDigits: Math.min(d, 6), maximumFractionDigits: Math.min(d, 6) }));
  }

  function tickFmt(scale) {
    var dom = scale.domain(), span = Math.abs(dom[1] - dom[0]);
    var maxAbs = Math.max(Math.abs(dom[0]), Math.abs(dom[1]));
    var step = span / 6;
    var decimals = step > 0 ? Math.max(0, -Math.floor(Math.log10(step)) + 1) : 0;
    if (maxAbs >= 10000) return function (v) { return minus(d3.format(',.0f')(v)); };
    if (maxAbs < 1e-3 && maxAbs > 0) return function (v) { return v === 0 ? '0' : minus(d3.format('.1e')(v)); };
    return function (v) {
      var s = d3.format(',.' + Math.min(decimals, 4) + 'f')(v);
      if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
      return minus(s);
    };
  }

  /* ---------- rich text in SVG: *X* italic, _ab subscript ---------- */

  function richSvg(sel, markup, T) {
    sel.text(null);
    var re = /\*([^*]+)\*|_([A-Za-z0-9]+)|([^*_]+)/g, m, sub = false;
    while ((m = re.exec(markup))) {
      var ts = sel.append('tspan');
      if (m[1] !== undefined) {
        ts.text(m[1]).attr('font-style', 'italic').attr('font-family', T.fontMath).attr('font-size', '1.12em');
        if (sub) { ts.attr('dy', '-0.3em'); sub = false; }
      } else if (m[2] !== undefined) {
        ts.text(m[2]).attr('font-size', '0.76em').attr('dy', sub ? null : '0.3em');
        sub = true;
      } else {
        ts.text(m[3]);
        if (sub) { ts.attr('dy', '-0.3em'); sub = false; }
      }
    }
    return sel;
  }

  /* ---------- frame, axes, grids ---------- */

  function frame(el, o) {
    var w = Math.max(260, Math.floor(el.clientWidth || 600));
    var h = o.height;
    d3.select(el).selectAll('svg').remove();
    d3.select(el).selectAll('.empty').remove();
    var svg = d3.select(el).append('svg')
      .attr('xmlns', SVGNS)
      .attr('width', w).attr('height', h)
      .attr('viewBox', '0 0 ' + w + ' ' + h)
      .attr('role', 'img')
      .attr('aria-label', o.label || '')
      .attr('font-family', o.T.fontBody)
      .attr('font-size', 12);
    var m = o.margin;
    var iw = Math.max(40, w - m.l - m.r), ih = Math.max(40, h - m.t - m.b);
    var g = svg.append('g').attr('transform', 'translate(' + m.l + ',' + m.t + ')');
    return { svg: svg, g: g, w: w, h: h, iw: iw, ih: ih, m: m };
  }

  var clipSeq = 0;
  function clip(f) {
    var id = 'ho-clip-' + (++clipSeq);
    f.svg.append('defs').append('clipPath').attr('id', id)
      .append('rect').attr('x', -6).attr('y', -6).attr('width', f.iw + 12).attr('height', f.ih + 12);
    return 'url(#' + id + ')';
  }

  function styleAxis(sel, T) {
    sel.select('.domain').attr('stroke', T.lineStrong).attr('stroke-width', 1);
    sel.selectAll('.tick line').remove();
    sel.selectAll('text').attr('fill', T.muted).attr('font-size', 12).attr('font-family', T.fontBody)
      .style('font-variant-numeric', 'tabular-nums');
  }

  function axes(f, x, y, T, o) {
    o = o || {};
    var xa = f.g.append('g').attr('class', 'x-axis').attr('transform', 'translate(0,' + f.ih + ')')
      .call(d3.axisBottom(x).ticks(o.xTicks || Math.max(3, Math.round(f.iw / 90))).tickSize(0).tickPadding(9).tickFormat(o.xFmt || tickFmt(x)));
    styleAxis(xa, T);
    var ya = f.g.append('g').attr('class', 'y-axis')
      .call(d3.axisLeft(y).ticks(o.yTicks || Math.max(3, Math.round(f.ih / 60))).tickSize(0).tickPadding(9).tickFormat(o.yFmt || tickFmt(y)));
    styleAxis(ya, T);
    if (o.xTitle) {
      richSvg(f.g.append('text').attr('x', f.iw / 2).attr('y', f.ih + 42).attr('text-anchor', 'middle')
        .attr('fill', T.ink2).attr('font-size', 12.5), o.xTitle, T);
    }
    if (o.yTitle) {
      richSvg(f.g.append('text').attr('transform', 'translate(' + (-f.m.l + 16) + ',' + (f.ih / 2) + ') rotate(-90)')
        .attr('text-anchor', 'middle').attr('fill', T.ink2).attr('font-size', 12.5), o.yTitle, T);
    }
  }

  function minorTicks(scale, major) {
    if (major.length < 2) return [];
    var step = major[1] - major[0], ms = step / 5, dom = scale.domain();
    var lo = Math.min(dom[0], dom[1]), hi = Math.max(dom[0], dom[1]);
    var out = [], i0 = Math.ceil(lo / ms - 1e-9), i1 = Math.floor(hi / ms + 1e-9);
    if (i1 - i0 > 400) return [];
    for (var i = i0; i <= i1; i++) out.push(i * ms);
    return out;
  }

  /** Engineering graph paper: minor and major hairlines, both solid. */
  function graphPaper(f, x, y, T, o) {
    var gp = f.g.append('g').attr('class', 'paper');
    gp.append('rect').attr('width', f.iw).attr('height', f.ih).attr('fill', T.paper);
    var xt = x.ticks((o && o.xTicks) || Math.max(3, Math.round(f.iw / 90))), yt = y.ticks((o && o.yTicks) || Math.max(3, Math.round(f.ih / 60)));
    var line = function (vals, isX, color) {
      gp.append('g').selectAll('line').data(vals).join('line')
        .attr('x1', function (d) { return isX ? Math.round(x(d)) + 0.5 : 0; })
        .attr('x2', function (d) { return isX ? Math.round(x(d)) + 0.5 : f.iw; })
        .attr('y1', function (d) { return isX ? 0 : Math.round(y(d)) + 0.5; })
        .attr('y2', function (d) { return isX ? f.ih : Math.round(y(d)) + 0.5; })
        .attr('stroke', color).attr('stroke-width', 1).attr('shape-rendering', 'crispEdges');
    };
    line(minorTicks(x, xt), true, T.gridMinor);
    line(minorTicks(y, yt), false, T.gridMinor);
    line(xt, true, T.gridMajor);
    line(yt, false, T.gridMajor);
  }

  function hGrid(f, y, T, ticks) {
    f.g.append('g').attr('class', 'grid').selectAll('line').data(y.ticks(ticks || Math.max(3, Math.round(f.ih / 60)))).join('line')
      .attr('x1', 0).attr('x2', f.iw)
      .attr('y1', function (d) { return Math.round(y(d)) + 0.5; }).attr('y2', function (d) { return Math.round(y(d)) + 0.5; })
      .attr('stroke', T.line).attr('stroke-width', 1).attr('shape-rendering', 'crispEdges');
  }

  function halo(sel, T) {
    return sel.attr('stroke', T.paper).attr('stroke-width', 4).attr('stroke-linejoin', 'round').attr('paint-order', 'stroke');
  }

  /* ---------- tooltip ---------- */

  function tipFor(el) {
    var tip = el.querySelector(':scope > .tip');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'tip';
      tip.hidden = true;
      el.appendChild(tip);
    }
    return tip;
  }

  /** rows: [{head}|{k, v, key}] - text is set with textContent. */
  function showTip(el, px, py, content) {
    var tip = tipFor(el);
    tip.textContent = '';
    content.forEach(function (c) {
      var div = document.createElement('div');
      if (c.head) { div.className = 't-head'; div.textContent = c.head; }
      else if (c.foot) { div.className = 't-foot'; div.textContent = c.foot; }
      else {
        div.className = 't-row';
        var a = document.createElement('span'), b = document.createElement('span');
        if (c.key) {
          var k = document.createElement('i');
          k.className = 't-key';
          k.style.background = c.key;
          a.appendChild(k);
        }
        a.appendChild(document.createTextNode(c.k));
        b.textContent = c.v;
        div.appendChild(a); div.appendChild(b);
      }
      tip.appendChild(div);
    });
    tip.hidden = false;
    var W = el.clientWidth, tw = tip.offsetWidth, th = tip.offsetHeight;
    var left = px + 16, top = py - th - 10;
    if (left + tw > W - 4) left = px - tw - 16;
    if (left < 4) left = 4;
    if (top < 4) top = py + 16;
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }

  function hideTip(el) {
    var tip = el.querySelector(':scope > .tip');
    if (tip) tip.hidden = true;
  }

  function empty(el, text) {
    d3.select(el).selectAll('svg').remove();
    d3.select(el).selectAll('.empty').remove();
    hideTip(el);
    d3.select(el).append('div').attr('class', 'empty').text(text);
  }

  /* ---------- legend (HTML) ---------- */

  function legend(ul, items, T) {
    if (!ul) return;
    ul.textContent = '';
    items.forEach(function (it) {
      var li = document.createElement('li');
      var s = document.createElementNS(SVGNS, 'svg');
      s.setAttribute('viewBox', '0 0 18 12');
      s.setAttribute('aria-hidden', 'true');
      var shape;
      if (it.type === 'dot') {
        shape = document.createElementNS(SVGNS, 'circle');
        shape.setAttribute('cx', 9); shape.setAttribute('cy', 6); shape.setAttribute('r', 4.5);
        shape.setAttribute('fill', it.fill || 'none');
        if (it.stroke) { shape.setAttribute('stroke', it.stroke); shape.setAttribute('stroke-width', 1.6); }
      } else if (it.type === 'line') {
        shape = document.createElementNS(SVGNS, 'line');
        shape.setAttribute('x1', 1); shape.setAttribute('x2', 17); shape.setAttribute('y1', 6); shape.setAttribute('y2', 6);
        shape.setAttribute('stroke', it.stroke); shape.setAttribute('stroke-width', 2); shape.setAttribute('stroke-linecap', 'round');
      } else if (it.type === 'diamond') {
        shape = document.createElementNS(SVGNS, 'path');
        shape.setAttribute('d', 'M9 1 L14 6 L9 11 L4 6 Z');
        shape.setAttribute('fill', it.fill);
      } else {
        shape = document.createElementNS(SVGNS, 'rect');
        shape.setAttribute('x', 3); shape.setAttribute('y', 1); shape.setAttribute('width', 12); shape.setAttribute('height', 10); shape.setAttribute('rx', 2);
        shape.setAttribute('fill', it.fill);
      }
      s.appendChild(shape);
      li.appendChild(s);
      var span = document.createElement('span');
      span.innerHTML = it.html; // trusted, built by the app (symbols with <var>/<sub>)
      li.appendChild(span);
      ul.appendChild(li);
    });
  }

  /* =====================================================================
   * Havlena–Odeh plot
   * d = {points:[{key,x,y,p,included,F,Eo,Eg,Efw}], fit:{a,b}|null, yDiv, yUnit, efw, labelsAll,
   *      Ntext, mNtext, legendEl, onToggle(key)}
   * ===================================================================== */
  function hoPlot(el, d) {
    var T = tokens();
    var pts = d.points.filter(function (p) { return isFinite(p.x) && isFinite(p.y); });
    if (d.legendEl) legend(d.legendEl, [
      { type: 'dot', fill: T.oil, html: 'Point in the fit' },
      { type: 'dot', fill: T.paper, stroke: T.muted, html: 'Left out' },
      { type: 'line', stroke: T.ink, html: 'Fitted line' },
      { type: 'diamond', fill: T.ink, html: 'Intercept, <var>N</var>' }
    ], T);
    if (!pts.length) { empty(el, d.emptyText || 'No points to plot yet.'); return; }

    var narrow = el.clientWidth < 560;
    var f = frame(el, {
      height: d.height || (narrow ? 340 : 430), T: T,
      margin: { t: 16, r: narrow ? 14 : 24, b: 54, l: narrow ? 62 : 74 },
      label: 'Havlena–Odeh plot of ' + pts.length + ' points' + (d.fit ? ', intercept N ' + d.Ntext + ', slope mN ' + d.mNtext : '')
    });
    var yd = d.yDiv || 1;
    var xs = pts.map(function (p) { return p.x; });
    var ys = pts.map(function (p) { return p.y / yd; });
    var xmin = Math.min(0, d3.min(xs)), xmax = d3.max(xs);
    var xspan = (xmax - xmin) || Math.abs(xmax) || 1;
    var x = d3.scaleLinear().domain([xmin, xmax + xspan * 0.07]).nice().range([0, f.iw]);
    var yv = ys.slice();
    if (d.fit) {
      x.domain().forEach(function (xx) { yv.push((d.fit.a + d.fit.b * xx) / yd); });
      yv.push(d.fit.a / yd);
    }
    var ylo = d3.min(yv), yhi = d3.max(yv);
    var ypad = (yhi - ylo) * 0.12 || Math.abs(yhi) * 0.1 || 1;
    var y = d3.scaleLinear().domain([ylo - ypad, yhi + ypad]).nice().range([f.ih, 0]);

    graphPaper(f, x, y, T);
    axes(f, x, y, T, {
      xTitle: d.efw ? '(*E*_g + *E*_fw) / (*E*_o + *E*_fw)' : '*E*_g / *E*_o',
      yTitle: (d.efw ? '*F* / (*E*_o + *E*_fw)' : '*F* / *E*_o') + ', ' + d.yUnit
    });
    // zero line for x when the domain starts left of 0
    if (x.domain()[0] < 0) {
      f.g.append('line').attr('x1', x(0)).attr('x2', x(0)).attr('y1', 0).attr('y2', f.ih).attr('stroke', T.lineStrong);
    }

    var cp = clip(f);
    var plot = f.g.append('g').attr('clip-path', cp);
    var anim = !reducedMotion() && d.animate !== false;

    if (d.fit) {
      var x0 = x.domain()[0], x1 = x.domain()[1];
      var l = plot.append('line')
        .attr('x1', x(x0)).attr('y1', y((d.fit.a + d.fit.b * x0) / yd))
        .attr('x2', x(x1)).attr('y2', y((d.fit.a + d.fit.b * x1) / yd))
        .attr('stroke', T.ink).attr('stroke-width', 2).attr('stroke-linecap', 'round');
      if (anim) {
        var len = Math.hypot(x(x1) - x(x0), y((d.fit.a + d.fit.b * x1) / yd) - y((d.fit.a + d.fit.b * x0) / yd));
        l.attr('stroke-dasharray', len + ' ' + len).attr('stroke-dashoffset', len)
          .transition().duration(650).ease(d3.easeCubicOut).attr('stroke-dashoffset', 0)
          .on('end', function () { d3.select(this).attr('stroke-dasharray', null).attr('stroke-dashoffset', null); });
      }
    }

    // points: left-out first, included on top
    var sorted = pts.slice().sort(function (a, b) { return (a.included ? 1 : 0) - (b.included ? 1 : 0); });
    var gp = plot.append('g');
    var dots = gp.selectAll('circle.pt').data(sorted, function (p) { return p.key; }).join('circle')
      .attr('class', 'pt')
      .attr('cx', function (p) { return x(p.x); })
      .attr('cy', function (p) { return y(p.y / yd); })
      .attr('r', 5)
      .attr('fill', function (p) { return p.included ? T.oil : T.paper; })
      .attr('stroke', function (p) { return p.included ? T.paper : T.muted; })
      .attr('stroke-width', function (p) { return p.included ? 2 : 1.6; });

    // intercept diamond and labels (drawn above the points)
    var ann = f.g.append('g');
    if (d.fit && x.domain()[0] <= 0) {
      var cx = x(0), cy = y(d.fit.a / yd);
      if (cy >= -2 && cy <= f.ih + 2) {
        ann.append('path').attr('d', d3.symbol(d3.symbolDiamond, 110)())
          .attr('transform', 'translate(' + cx + ',' + cy + ')')
          .attr('fill', T.ink).attr('stroke', T.paper).attr('stroke-width', 2);
        // put the label on the side of the line that is free: below a rising line, above a falling one
        var rising = d.fit.b / yd > 0;
        var ly = rising ? cy + 22 : cy - 12;
        if (ly < 12) ly = cy + 22;
        if (ly > f.ih - 6) ly = cy - 12;
        var lab = ann.append('text').attr('x', cx + 12).attr('y', ly)
          .attr('fill', T.ink).attr('font-size', 13).attr('font-weight', 600);
        richSvg(lab, '*N* = ' + d.Ntext, T);
        halo(lab, T);
        if (anim) {
          ann.attr('opacity', 0).transition().delay(450).duration(300).attr('opacity', 1);
        }
      }
    }
    var lineY = function (xx) { return d.fit ? y((d.fit.a + d.fit.b * xx) / yd) : NaN; };
    var screenPts = pts.map(function (p) { return [x(p.x), y(p.y / yd)]; });
    if (d.fit && d.mNtext) {
      // slope label on the line, where it is farthest from the points and from the N label
      var dom = x.domain(), best = null;
      var labelLen = (8 + d.mNtext.length) * 6.4;
      var obstacles = screenPts.slice();
      if (x.domain()[0] <= 0) {
        var nx = x(0), ny = y(d.fit.a / yd);
        for (var k = 0; k <= 4; k++) obstacles.push([nx + 12 + k * 28, ny + (d.fit.b / yd > 0 ? 18 : -16)]);
        obstacles.push([nx, ny]);
      }
      [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8].forEach(function (tt) {
        var xa = dom[0] + (dom[1] - dom[0]) * tt, px = x(xa), py = lineY(xa);
        if (!(py > 16 && py < f.ih - 16)) return;
        if (px - labelLen / 2 < 4 || px + labelLen / 2 > f.iw - 4) return;
        var dmin = d3.min(obstacles, function (q) { return Math.hypot(q[0] - px, q[1] - py); });
        if (!best || dmin > best.dmin) best = { px: px, py: py, dmin: dmin };
      });
      var dx = x(dom[1]) - x(dom[0]), dyy = lineY(dom[1]) - lineY(dom[0]);
      var ang = Math.atan2(dyy, dx) * 180 / Math.PI;
      if (best && best.dmin > 26 && Math.abs(ang) < 50) {
        var sl = ann.append('text')
          .attr('transform', 'translate(' + best.px + ',' + best.py + ') rotate(' + ang + ') translate(0,-9)')
          .attr('text-anchor', 'middle').attr('fill', T.ink2).attr('font-size', 12);
        richSvg(sl, 'slope *mN* = ' + d.mNtext, T);
        halo(sl, T);
      }
    }

    // pressure labels: first and last included point, or all; placed on the side away from the line
    var inc = pts.filter(function (p) { return p.included; });
    var labelled = d.labelsAll ? pts : (inc.length ? [inc[0], inc[inc.length - 1]] : []);
    var seen = {};
    labelled = labelled.filter(function (p) { if (seen[p.key]) return false; seen[p.key] = 1; return true; });
    var lg = ann.append('g');
    var taken = [];
    labelled.forEach(function (p) {
      var px = x(p.x), py = y(p.y / yd);
      var text = d3.format(',')(Math.round(p.p)) + (d.labelsAll ? '' : ' psia');
      var w = text.length * 6.2, h = 11;
      // four candidate spots around the point; keep the one farthest from other points, the line and other labels
      var cands = [[8, -7, 'start'], [8, 15, 'start'], [-8, -7, 'end'], [-8, 15, 'end']].map(function (c) {
        var x0 = c[2] === 'start' ? px + c[0] : px + c[0] - w, y0 = py + c[1] - h;
        var cxm = x0 + w / 2, cym = y0 + h / 2;
        if (x0 < 2 || x0 + w > f.iw - 2 || y0 < 2 || y0 + h > f.ih - 2) return null;
        var score = d3.min(screenPts.filter(function (q) { return !(q[0] === px && q[1] === py); }).map(function (q) {
          var dx = Math.max(0, Math.abs(q[0] - cxm) - w / 2), dy = Math.max(0, Math.abs(q[1] - cym) - h / 2);
          return Math.hypot(dx, dy);
        }).concat([40]));
        if (d.fit) {
          var lyc = lineY(x.invert(cxm));
          score = Math.min(score, Math.max(0, Math.abs(lyc - cym) - h / 2) + 2);
        }
        taken.forEach(function (r) {
          var ox = Math.max(0, Math.min(x0 + w, r[0] + r[2]) - Math.max(x0, r[0]));
          var oy = Math.max(0, Math.min(y0 + h, r[1] + r[3]) - Math.max(y0, r[1]));
          if (ox * oy > 0) score -= 30;
        });
        return { x: c[2] === 'start' ? px + c[0] : px + c[0], y: py + c[1], anchor: c[2], score: score, box: [x0, y0, w, h] };
      }).filter(Boolean);
      if (!cands.length) return;
      cands.sort(function (a, b) { return b.score - a.score; });
      var c = cands[0];
      taken.push(c.box);
      var t = lg.append('text').attr('fill', T.muted).attr('font-size', 11).style('font-variant-numeric', 'tabular-nums').text(text)
        .attr('x', c.x).attr('y', c.y).attr('text-anchor', c.anchor);
      halo(t, T);
    });

    // hit areas (24 px), hover, focus, click
    var focusable = pts.length <= 80;
    var hits = f.g.append('g').selectAll('circle.hit').data(pts, function (p) { return p.key; }).join('circle')
      .attr('class', 'hit')
      .attr('cx', function (p) { return x(p.x); })
      .attr('cy', function (p) { return y(p.y / yd); })
      .attr('r', 12).attr('fill', 'transparent').style('cursor', 'pointer')
      .attr('tabindex', focusable ? 0 : null)
      .attr('role', focusable ? 'button' : null)
      .attr('aria-pressed', function (p) { return focusable ? String(p.included) : null; })
      .attr('aria-label', function (p) {
        return 'Point at ' + Math.round(p.p) + ' psia, ' + (p.included ? 'in the fit. Press Enter to leave it out.' : 'left out. Press Enter to add it back.');
      });

    function tipContent(p) {
      return [
        { head: d3.format(',')(Math.round(p.p)) + ' psia' },
        { k: 'x', v: fmtSig(p.x, 4) },
        { k: 'y', v: fmtSig(p.y / yd, 4) + ' ' + d.yUnit },
        { k: 'F', v: fmtSig(p.F / 1e6, 4) + ' MM rb' },
        { k: 'Eo', v: fmtSig(p.Eo, 4) + ' rb/STB' },
        { k: 'Eg', v: fmtSig(p.Eg, 4) + ' rb/STB' },
        { k: 'Efw', v: fmtSig(p.Efw, 3) + ' rb/STB' },
        { foot: p.included ? 'In the fit. Click to leave it out.' : 'Left out. Click to add it back.' }
      ];
    }
    function enter(p) {
      dots.filter(function (q) { return q.key === p.key; }).attr('r', 6.5);
      showTip(el, f.m.l + x(p.x), f.m.t + y(p.y / yd), tipContent(p));
    }
    function leave(p) {
      dots.filter(function (q) { return q.key === p.key; }).attr('r', 5);
      hideTip(el);
    }
    hits.on('pointerenter', function (ev, p) { enter(p); })
      .on('pointerleave', function (ev, p) { leave(p); })
      .on('focus', function (ev, p) { enter(p); })
      .on('blur', function (ev, p) { leave(p); })
      .on('click', function (ev, p) { if (d.onToggle) d.onToggle(p.key); })
      .on('keydown', function (ev, p) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); if (d.onToggle) d.onToggle(p.key, true); }
      });
  }

  /* =====================================================================
   * F against Et through the origin (check of the fit, and the m explorer)
   * d = {points:[{key,p,Et,F,included}], slope (STB per unit Et), slopeText, xUnit, legendEl, lineLabel}
   * ===================================================================== */
  function originPlot(el, d) {
    var T = tokens();
    var pts = d.points.filter(function (p) { return isFinite(p.Et) && isFinite(p.F) && p.Et > 0; });
    if (d.legendEl) legend(d.legendEl, [
      { type: 'dot', fill: T.oil, html: d.pointLabel || 'Production point' },
      { type: 'line', stroke: T.ink, html: d.lineLabel || 'Line through the origin' }
    ], T);
    if (!pts.length) { empty(el, d.emptyText || 'Nothing to show for this m.'); return; }
    var narrow = el.clientWidth < 520;
    var f = frame(el, {
      height: d.height || (narrow ? 260 : 300), T: T,
      margin: { t: 14, r: 18, b: 52, l: narrow ? 56 : 64 },
      label: d.label || ('F against E_t for ' + pts.length + ' points')
    });
    var xmax = d3.max(pts, function (p) { return p.Et; }) * 1.08;
    var x = d3.scaleLinear().domain([0, xmax]).nice().range([0, f.iw]);
    var ymax = d3.max(pts, function (p) { return p.F / 1e6; });
    if (isFinite(d.slope)) ymax = Math.max(ymax, d.slope * x.domain()[1] / 1e6);
    var y = d3.scaleLinear().domain([0, ymax * 1.06]).nice().range([f.ih, 0]);
    hGrid(f, y, T);
    axes(f, x, y, T, { xTitle: d.xTitle || '*E*_t, rb/STB', yTitle: '*F*, MM rb' });
    var plot = f.g.append('g').attr('clip-path', clip(f));
    if (isFinite(d.slope)) {
      plot.append('line').attr('x1', x(0)).attr('y1', y(0))
        .attr('x2', x(x.domain()[1])).attr('y2', y(d.slope * x.domain()[1] / 1e6))
        .attr('stroke', T.ink).attr('stroke-width', 2).attr('stroke-linecap', 'round');
    }
    var dots = plot.append('g').selectAll('circle').data(pts).join('circle')
      .attr('cx', function (p) { return x(p.Et); }).attr('cy', function (p) { return y(p.F / 1e6); })
      .attr('r', 5).attr('fill', T.oil).attr('stroke', T.surface).attr('stroke-width', 2);
    if (d.slopeText && isFinite(d.slope)) {
      // end label near the right edge of the line
      var xe = x.domain()[1] * 0.97, ye = d.slope * xe / 1e6;
      var py = y(ye);
      var t = f.g.append('text').attr('x', x(xe)).attr('y', Math.max(12, py - 10)).attr('text-anchor', 'end')
        .attr('fill', T.ink2).attr('font-size', 12);
      richSvg(t, d.slopeText, T);
      t.attr('stroke', T.surface).attr('stroke-width', 4).attr('stroke-linejoin', 'round').attr('paint-order', 'stroke');
    }
    f.g.append('g').selectAll('circle').data(pts).join('circle')
      .attr('cx', function (p) { return x(p.Et); }).attr('cy', function (p) { return y(p.F / 1e6); })
      .attr('r', 12).attr('fill', 'transparent')
      .on('pointerenter', function (ev, p) {
        dots.filter(function (q) { return q.key === p.key; }).attr('r', 6.5);
        showTip(el, f.m.l + x(p.Et), f.m.t + y(p.F / 1e6), [
          { head: d3.format(',')(Math.round(p.p)) + ' psia' },
          { k: 'Et', v: fmtSig(p.Et, 4) + ' rb/STB' },
          { k: 'F', v: fmtSig(p.F / 1e6, 4) + ' MM rb' },
          { k: 'F / Et', v: fmtSig(p.F / p.Et / (d.nDiv || 1e6), 4) + ' ' + (d.nUnit || 'MMSTB') }
        ]);
      })
      .on('pointerleave', function (ev, p) {
        dots.filter(function (q) { return q.key === p.key; }).attr('r', 5);
        hideTip(el);
      });
  }

  /* =====================================================================
   * Drive indices, stacked (diverging when an index is negative)
   * d = {rows:[{key,p,DDI,SDI,CDI}], legendEl, showWater}
   * ===================================================================== */
  function driveBars(el, d) {
    var T = tokens();
    var series = [
      { k: 'DDI', name: 'Depletion drive', color: T.oil },
      { k: 'SDI', name: 'Gas-cap drive', color: T.gas },
      { k: 'CDI', name: 'Water and rock expansion', color: T.water }
    ].filter(function (s) { return s.k !== 'CDI' || d.showWater; });
    if (d.blockedText) {
      if (d.legendEl) legend(d.legendEl, [], T);
      empty(el, d.blockedText);
      return;
    }
    if (d.legendEl) legend(d.legendEl, series.map(function (s) { return { type: 'rect', fill: s.color, html: s.name }; }), T);
    var rows = d.rows.filter(function (r) { return series.every(function (s) { return isFinite(r[s.k]); }); });
    if (!rows.length) { empty(el, d.emptyText || 'Drive indices appear once N and m are found.'); return; }
    rows = rows.map(function (r) {
      var sum = series.reduce(function (a, s) { return a + r[s.k]; }, 0);
      var o = { key: r.key, p: r.p, sum: sum };
      series.forEach(function (s) { o[s.k] = sum !== 0 ? r[s.k] / sum : NaN; });
      return o;
    });
    var narrow = el.clientWidth < 520;
    var endLabels = el.clientWidth >= 400 && rows.length >= 1;
    var f = frame(el, {
      height: d.height || (narrow ? 260 : 300), T: T,
      margin: { t: 14, r: endLabels ? 104 : 14, b: 52, l: 52 },
      label: 'Drive indices at ' + rows.length + ' pressures'
    });
    var x = d3.scaleBand().domain(rows.map(function (r) { return r.key; })).range([0, f.iw]).paddingInner(0.32).paddingOuter(0.18);
    var lo = 0, hi = 1;
    rows.forEach(function (r) {
      var pos = 0, neg = 0;
      series.forEach(function (s) { if (r[s.k] >= 0) pos += r[s.k]; else neg += r[s.k]; });
      hi = Math.max(hi, pos); lo = Math.min(lo, neg);
    });
    var y = d3.scaleLinear().domain([lo, hi]).nice().range([f.ih, 0]);
    hGrid(f, y, T, 5);
    var xa = f.g.append('g').attr('transform', 'translate(0,' + f.ih + ')')
      .call(d3.axisBottom(x).tickSize(0).tickPadding(9).tickFormat(function (k, i) {
        var every = Math.ceil(rows.length / Math.max(1, Math.floor(f.iw / 46)));
        return i % every === 0 ? d3.format(',')(Math.round(rows[i].p)) : '';
      }));
    styleAxis(xa, T);
    var ya = f.g.append('g').call(d3.axisLeft(y).ticks(5).tickSize(0).tickPadding(9).tickFormat(function (v) { return minus(d3.format('.0%')(v)); }));
    styleAxis(ya, T);
    f.g.append('text').attr('x', f.iw / 2).attr('y', f.ih + 42).attr('text-anchor', 'middle').attr('fill', T.ink2).attr('font-size', 12.5).text('Average reservoir pressure, psia');
    if (lo < 0) f.g.append('line').attr('x1', 0).attr('x2', f.iw).attr('y1', y(0)).attr('y2', y(0)).attr('stroke', T.lineStrong);

    var bw = Math.min(24, x.bandwidth());
    var gap = bw >= 6 ? 2 : 0;
    var radius = bw >= 10 ? 4 : 0;
    function segPath(x0, w, top, bottom, roundTop, roundBottom) {
      var h = bottom - top;
      if (h <= 0) return '';
      var rt = roundTop ? Math.min(radius, h / 2, w / 2) : 0, rb = roundBottom ? Math.min(radius, h / 2, w / 2) : 0;
      return 'M' + x0 + ',' + (top + rt) +
        (rt ? 'Q' + x0 + ',' + top + ' ' + (x0 + rt) + ',' + top : '') +
        'L' + (x0 + w - rt) + ',' + top +
        (rt ? 'Q' + (x0 + w) + ',' + top + ' ' + (x0 + w) + ',' + (top + rt) : '') +
        'L' + (x0 + w) + ',' + (bottom - rb) +
        (rb ? 'Q' + (x0 + w) + ',' + bottom + ' ' + (x0 + w - rb) + ',' + bottom : '') +
        'L' + (x0 + rb) + ',' + bottom +
        (rb ? 'Q' + x0 + ',' + bottom + ' ' + x0 + ',' + (bottom - rb) : '') + 'Z';
    }
    var segs = [];
    rows.forEach(function (r) {
      var x0 = x(r.key) + (x.bandwidth() - bw) / 2;
      var posSegs = [], negSegs = [];
      series.forEach(function (s) { if (r[s.k] > 0) posSegs.push(s); else if (r[s.k] < 0) negSegs.push(s); });
      var acc = 0;
      posSegs.forEach(function (s, i) {
        var top = y(acc + r[s.k]), bottom = y(acc) - (i > 0 ? gap : 0);
        segs.push({ row: r, s: s, d: segPath(x0, bw, top, bottom, i === posSegs.length - 1, false), mid: (top + bottom) / 2, h: bottom - top });
        acc += r[s.k];
      });
      acc = 0;
      negSegs.forEach(function (s, i) {
        var top = y(acc) + ((i > 0 || posSegs.length) ? gap : 0), bottom = y(acc + r[s.k]);
        segs.push({ row: r, s: s, d: segPath(x0, bw, top, bottom, false, i === negSegs.length - 1), mid: (top + bottom) / 2, h: bottom - top });
        acc += r[s.k];
      });
    });
    var bars = f.g.append('g').selectAll('path').data(segs).join('path')
      .attr('d', function (s) { return s.d; }).attr('fill', function (s) { return s.s.color; });

    if (endLabels) {
      var last = rows[rows.length - 1];
      var lastSegs = segs.filter(function (s) { return s.row === last && s.h >= 2; }).sort(function (a, b) { return a.mid - b.mid; });
      var placed = [];
      lastSegs.forEach(function (s) {
        var yy = s.mid;
        if (placed.length && yy - placed[placed.length - 1] < 14) yy = placed[placed.length - 1] + 14;
        if (yy > f.ih + 4) return;
        placed.push(yy);
        var lx = x(last.key) + (x.bandwidth() + bw) / 2 + 8;
        f.g.append('line').attr('x1', lx - 6).attr('x2', lx - 2).attr('y1', s.mid).attr('y2', yy).attr('stroke', T.lineStrong);
        f.g.append('text').attr('x', lx).attr('y', yy + 4).attr('fill', T.ink2).attr('font-size', 11.5)
          .style('font-variant-numeric', 'tabular-nums')
          .text(minus(d3.format('.0%')(last[s.s.k])) + ' ' + s.s.name.split(' ')[0].toLowerCase());
      });
    }

    // per-bar hit areas
    f.g.append('g').selectAll('rect').data(rows).join('rect')
      .attr('x', function (r) { return x(r.key) - x.step() * x.paddingInner() / 2; })
      .attr('width', x.step()).attr('y', 0).attr('height', f.ih).attr('fill', 'transparent')
      .on('pointerenter pointermove', function (ev, r) {
        bars.attr('opacity', function (s) { return s.row === r ? 1 : 0.55; });
        var content = [{ head: d3.format(',')(Math.round(r.p)) + ' psia' }];
        series.forEach(function (s) { content.push({ k: s.name, v: minus(d3.format('.1%')(r[s.k])), key: s.color }); });
        content.push({ foot: 'Sum before scaling to 100 %: ' + fmtSig(r.sum, 3) });
        showTip(el, f.m.l + x(r.key) + x.bandwidth() / 2, f.m.t + y(Math.max(0, d3.max(series, function (s) { return r[s.k]; }))), content);
      })
      .on('pointerleave', function () { bars.attr('opacity', 1); hideTip(el); });
  }

  /* =====================================================================
   * m scan: spread of F/Et against m
   * d = {scan:[{m,cv}], mFit, mNow, onPick(m)}
   * ===================================================================== */
  function scanPlot(el, d) {
    var T = tokens();
    var pts = d.scan.filter(function (s) { return isFinite(s.cv); });
    if (pts.length < 2) { empty(el, 'Not enough points to compare values of m.'); return; }
    var narrow = el.clientWidth < 520;
    var f = frame(el, {
      height: d.height || (narrow ? 240 : 300), T: T,
      margin: { t: 14, r: 16, b: 52, l: 52 },
      label: 'Spread of F over E_t for m between ' + fmtSig(pts[0].m, 3) + ' and ' + fmtSig(pts[pts.length - 1].m, 3)
    });
    var x = d3.scaleLinear().domain(d3.extent(d.scan, function (s) { return s.m; })).range([0, f.iw]);
    var cvs = pts.map(function (s) { return s.cv; }).sort(d3.ascending);
    var cap = Math.max(d3.quantile(cvs, 0.8), (d3.min(cvs) || 0) * 3, 1);
    var y = d3.scaleLinear().domain([0, cap * 1.05]).nice().range([f.ih, 0]);
    hGrid(f, y, T, 5);
    axes(f, x, y, T, { xTitle: '*m*', yTitle: 'Spread of *F* / *E*_t, %', yTicks: 5 });
    var plot = f.g.append('g').attr('clip-path', clip(f));
    var lineGen = d3.line().defined(function (s) { return isFinite(s.cv); })
      .x(function (s) { return x(s.m); }).y(function (s) { return y(s.cv); }).curve(d3.curveMonotoneX);
    plot.append('path').datum(d.scan).attr('d', lineGen).attr('fill', 'none')
      .attr('stroke', T.ink2).attr('stroke-width', 2).attr('stroke-linejoin', 'round').attr('stroke-linecap', 'round');

    function cvAt(m) {
      var best = null;
      d.scan.forEach(function (s) { if (isFinite(s.cv) && (!best || Math.abs(s.m - m) < Math.abs(best.m - m))) best = s; });
      return best;
    }
    if (isFinite(d.mFit) && d.mFit >= x.domain()[0] && d.mFit <= x.domain()[1]) {
      var sf = cvAt(d.mFit);
      if (sf) {
        var fy = Math.min(y(sf.cv), f.ih);
        f.g.append('path').attr('d', d3.symbol(d3.symbolDiamond, 90)()).attr('transform', 'translate(' + x(d.mFit) + ',' + fy + ')')
          .attr('fill', T.ink).attr('stroke', T.surface).attr('stroke-width', 2);
        var toRight = x(d.mFit) < f.iw - 70;
        var tl = f.g.append('text').attr('x', x(d.mFit) + (toRight ? 10 : -10)).attr('y', Math.max(12, fy - 10))
          .attr('text-anchor', toRight ? 'start' : 'end').attr('fill', T.ink).attr('font-size', 12);
        richSvg(tl, 'fitted *m*', T);
        tl.attr('stroke', T.surface).attr('stroke-width', 4).attr('stroke-linejoin', 'round').attr('paint-order', 'stroke');
      }
    }
    if (isFinite(d.mNow)) {
      var sn = cvAt(d.mNow);
      f.g.append('line').attr('x1', x(d.mNow)).attr('x2', x(d.mNow)).attr('y1', 0).attr('y2', f.ih).attr('stroke', T.oil).attr('stroke-width', 1.5);
      if (sn) f.g.append('circle').attr('cx', x(d.mNow)).attr('cy', Math.min(y(sn.cv), f.ih)).attr('r', 5).attr('fill', T.oil).attr('stroke', T.surface).attr('stroke-width', 2);
    }
    // crosshair and click to pick m
    var cross = f.g.append('line').attr('y1', 0).attr('y2', f.ih).attr('stroke', T.lineStrong).attr('stroke-width', 1).attr('opacity', 0);
    f.g.append('rect').attr('width', f.iw).attr('height', f.ih).attr('fill', 'transparent').style('cursor', 'crosshair')
      .on('pointermove', function (ev) {
        var mx = d3.pointer(ev, this)[0];
        var s = cvAt(x.invert(mx));
        if (!s) return;
        cross.attr('x1', x(s.m)).attr('x2', x(s.m)).attr('opacity', 1);
        showTip(el, f.m.l + x(s.m), f.m.t + Math.min(y(s.cv), f.ih), [
          { head: 'm = ' + minus(s.m.toFixed(3)) },
          { k: 'Spread', v: fmtSig(s.cv, 3) + ' %' },
          { k: 'N', v: fmtSig(s.N / (d.nDiv || 1e6), 4) + ' ' + (d.nUnit || 'MMSTB') },
          { foot: 'Click to try this m.' }
        ]);
      })
      .on('pointerleave', function () { cross.attr('opacity', 0); hideTip(el); })
      .on('click', function (ev) {
        var s = cvAt(x.invert(d3.pointer(ev, this)[0]));
        if (s && d.onPick) d.onPick(s.m);
      });
  }

  /* ---------- PNG export ---------- */

  function toPNG(svgNode, background, cb) {
    var w = +svgNode.getAttribute('width'), h = +svgNode.getAttribute('height');
    var clone = svgNode.cloneNode(true);
    clone.setAttribute('xmlns', SVGNS);
    var bg = document.createElementNS(SVGNS, 'rect');
    bg.setAttribute('width', w); bg.setAttribute('height', h); bg.setAttribute('fill', background);
    clone.insertBefore(bg, clone.firstChild);
    var data = new XMLSerializer().serializeToString(clone);
    var img = new Image();
    img.onload = function () {
      var scale = 2, c = document.createElement('canvas');
      c.width = w * scale; c.height = h * scale;
      var ctx = c.getContext('2d');
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      c.toBlob(function (b) { cb(b); }, 'image/png');
    };
    img.onerror = function () { cb(null); };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(data);
  }

  return {
    tokens: tokens,
    hoPlot: hoPlot,
    originPlot: originPlot,
    driveBars: driveBars,
    scanPlot: scanPlot,
    legend: legend,
    empty: empty,
    hideTip: hideTip,
    toPNG: toPNG,
    fmtSig: fmtSig,
    minus: minus
  };
});
