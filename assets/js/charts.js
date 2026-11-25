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
      oil: v('--oil'), gas: v('--gas'), water: v('--water'), rock: v('--rock'),
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
      } else if (it.type === 'line' || it.type === 'dash') {
        shape = document.createElementNS(SVGNS, 'line');
        shape.setAttribute('x1', 1); shape.setAttribute('x2', 17); shape.setAttribute('y1', 6); shape.setAttribute('y2', 6);
        shape.setAttribute('stroke', it.stroke); shape.setAttribute('stroke-width', it.type === 'dash' ? 1.6 : 2); shape.setAttribute('stroke-linecap', 'round');
        if (it.type === 'dash') shape.setAttribute('stroke-dasharray', '4 3');
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
   *      Ntext, mNtext, legendEl, onToggle(key),
   *      optional: xTitle, yTitle (rich text), slopeLabel (replaces "slope mN = …"), noIntercept (line through the origin),
   *      height, paperTitles (axis titles as F/Eo (MMSTB), for print)}
   * ===================================================================== */
  function hoPlot(el, d) {
    var T = tokens();
    var pts = d.points.filter(function (p) { return isFinite(p.x) && isFinite(p.y); });
    if (d.legendEl) legend(d.legendEl, [
      { type: 'dot', fill: T.oil, html: 'Point in the fit' },
      { type: 'dot', fill: T.paper, stroke: T.muted, html: 'Left out' },
      { type: 'line', stroke: T.ink, html: d.noIntercept ? 'Line through the origin, slope <var>N</var>' : 'Fitted line' }
    ].concat(d.noIntercept ? [] : [{ type: 'diamond', fill: T.ink, html: 'Intercept, <var>N</var>' }]), T);
    if (!pts.length) { empty(el, d.emptyText || 'No points to plot yet.'); return; }

    var narrow = el.clientWidth < 560;
    var f = frame(el, {
      height: d.height || (narrow ? 340 : 430), T: T,
      margin: { t: 16, r: narrow ? 14 : 24, b: 54, l: narrow ? 62 : 74 },
      label: 'Havlena–Odeh plot of ' + pts.length + ' points' + (d.fit ? (d.noIntercept ? ', slope N ' + d.Ntext : ', intercept N ' + d.Ntext + ', ' + String(d.slopeLabel || 'slope mN ' + d.mNtext).replace(/\*/g, '')) : '')
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
    // room for the N label at the intercept: below a rising line, above a falling one
    if (d.fit && !d.noIntercept && x.domain()[0] <= 0) {
      var aY = d.fit.a / yd, dm = y.domain(), rr;
      if (d.fit.b > 0 && y(aY) > f.ih - 34) { rr = 34 / f.ih; y.domain([(aY - rr * dm[1]) / (1 - rr), dm[1]]).nice(); }
      if (d.fit.b <= 0 && y(aY) < 28) { rr = 28 / f.ih; y.domain([dm[0], (aY - rr * dm[0]) / (1 - rr)]).nice(); }
    }

    graphPaper(f, x, y, T);
    // on screen "F / Eo, MMSTB"; on paper (paperTitles) "F/Eo (MMSTB)"
    var axisTitle = function (t) { return d.paperTitles ? t.replace(/ \/ /g, '/').replace(/, ([^,]+)$/, ' ($1)') : t; };
    axes(f, x, y, T, {
      xTitle: axisTitle(d.xTitle || (d.efw ? '*E*_g / [*E*_o + (1 + *m*) *E*_fw]' : '*E*_g / *E*_o')),
      yTitle: axisTitle(d.yTitle || ((d.influx ? '(*F* − *W*_e)' : '*F*') + (d.efw ? ' / [*E*_o + (1 + *m*) *E*_fw]' : ' / *E*_o') + ', ' + d.yUnit))
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

    // points: left-out first, included on top; many points are drawn smaller and without the ring,
    // so the rings do not hide the points they overlap
    var sorted = pts.slice().sort(function (a, b) { return (a.included ? 1 : 0) - (b.included ? 1 : 0); });
    var dense = pts.length > 60;
    var gp = plot.append('g');
    var dots = gp.selectAll('circle.pt').data(sorted, function (p) { return p.key; }).join('circle')
      .attr('class', 'pt')
      .attr('cx', function (p) { return x(p.x); })
      .attr('cy', function (p) { return y(p.y / yd); })
      .attr('r', dense ? 2.6 : 5)
      .attr('fill', function (p) { return p.included ? T.oil : T.paper; })
      .attr('stroke', function (p) { return p.included ? (dense ? 'none' : T.paper) : T.muted; })
      .attr('stroke-width', function (p) { return p.included ? (dense ? 0 : 2) : (dense ? 1 : 1.6); });

    // intercept diamond and labels (drawn above the points)
    var ann = f.g.append('g');
    var nBox = null;   // where the N label sits, so the slope label keeps clear of it
    if (d.fit && !d.noIntercept && x.domain()[0] <= 0) {
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
        nBox = [cx + 12, ly - 11, ('N = ' + d.Ntext).length * 7.4, 14];
        if (anim) {
          ann.attr('opacity', 0).transition().delay(450).duration(300).attr('opacity', 1);
        }
      }
    }
    var lineY = function (xx) { return d.fit ? y((d.fit.a + d.fit.b * xx) / yd) : NaN; };
    var screenPts = pts.map(function (p) { return [x(p.x), y(p.y / yd)]; });
    // the points that get a pressure label: the first and last in the fit, or all
    var inc = pts.filter(function (p) { return p.included; });
    var labelled = d.labelsAll ? pts : (inc.length ? [inc[0], inc[inc.length - 1]] : []);
    var labelText = function (p) { return d3.format(',')(Math.round(p.p)) + (d.labelsAll ? '' : ' psia'); };
    var slopeBox = null;   // where the slope label sits, so the pressure labels keep clear of it
    if (d.fit && (d.mNtext || d.slopeLabel)) {
      // slope label on the line, where it is farthest from the points and from the N label
      var dom = x.domain(), best = null;
      var slopeText = d.slopeLabel || ('slope *mN* = ' + d.mNtext);
      var labelLen = slopeText.replace(/\*/g, '').length * 6.4;
      var obstacles = screenPts.slice();
      if (x.domain()[0] <= 0 && !d.noIntercept) obstacles.push([x(0), y(d.fit.a / yd)]);
      if (nBox) for (var k = 0; k <= 4; k++) obstacles.push([nBox[0] + k * nBox[2] / 4, nBox[1] + nBox[3] / 2]);
      // keep away from where the pressure labels will go
      labelled.forEach(function (p) {
        var lx = x(p.x), ly = y(p.y / yd), hw = labelText(p).length * 3.1 + 8;
        obstacles.push([lx + hw, ly - 12], [lx - hw, ly - 12], [lx + hw, ly + 10], [lx - hw, ly + 10]);
      });
      var dx = x(dom[1]) - x(dom[0]), dyy = lineY(dom[1]) - lineY(dom[0]);
      var ang = Math.atan2(dyy, dx) * 180 / Math.PI, ca = Math.cos(ang * Math.PI / 180), sa = Math.sin(ang * Math.PI / 180);
      d3.range(0.1, 0.91, 0.05).forEach(function (tt) {
        var xa = dom[0] + (dom[1] - dom[0]) * tt, px = x(xa), py = lineY(xa);
        if (!(py > 16 && py < f.ih - 16)) return;
        var ex = labelLen / 2 * Math.abs(ca);
        if (px - ex < 4 || px + ex > f.iw - 4) return;
        // the label runs along the line, 9 px above it: measure from five spots along its length
        var dmin = Infinity;
        [-0.5, -0.25, 0, 0.25, 0.5].forEach(function (sx) {
          var qx = px + 9 * sa + sx * labelLen * ca, qy = py - 9 * ca + sx * labelLen * sa;
          obstacles.forEach(function (q) { dmin = Math.min(dmin, Math.hypot(q[0] - qx, q[1] - qy)); });
        });
        if (!best || dmin > best.dmin) best = { px: px, py: py, dmin: dmin };
      });
      if (best && best.dmin > 15 && Math.abs(ang) < 50) {
        var sl = ann.append('text')
          .attr('transform', 'translate(' + best.px + ',' + best.py + ') rotate(' + ang + ') translate(0,-9)')
          .attr('text-anchor', 'middle').attr('fill', T.ink2).attr('font-size', 12);
        richSvg(sl, slopeText, T);
        halo(sl, T);
        var rad = ang * Math.PI / 180, cx = best.px + 9 * Math.sin(rad), cy = best.py - 9 * Math.cos(rad);
        var bw = Math.abs(labelLen * Math.cos(rad)) + Math.abs(13 * Math.sin(rad)), bh = Math.abs(labelLen * Math.sin(rad)) + Math.abs(13 * Math.cos(rad));
        slopeBox = [cx - bw / 2, cy - bh / 2, bw, bh];
      } else if (Math.abs(ang) < 80) {
        // no room along the line (points all the way along it): the corner the line leaves free
        var rise = ang < 0, bx = 8, by = rise ? 4 : f.ih - 18, bW = labelLen, bH = 14;
        var clear = obstacles.every(function (q) {
          var ddx = Math.max(0, bx - q[0], q[0] - (bx + bW)), ddy = Math.max(0, by - q[1], q[1] - (by + bH));
          return Math.hypot(ddx, ddy) > 10;
        }) && [0, 0.5, 1].every(function (tt) {
          var lx = bx + bW * tt, lyy = lineY(x.invert(lx));
          return lyy < by - 6 || lyy > by + bH + 6;
        });
        if (clear) {
          var sc = ann.append('text').attr('x', bx).attr('y', by + 11).attr('fill', T.ink2).attr('font-size', 12);
          richSvg(sc, slopeText, T);
          halo(sc, T);
          slopeBox = [bx, by, bW, bH];
        }
      }
    }

    // pressure labels: first and last included point, or all; placed on the side away from the line
    var seen = {};
    labelled = labelled.filter(function (p) { if (seen[p.key]) return false; seen[p.key] = 1; return true; });
    var lg = ann.append('g');
    var taken = slopeBox ? [slopeBox] : [];
    labelled.forEach(function (p) {
      var px = x(p.x), py = y(p.y / yd);
      var text = labelText(p);
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
        { k: 'Efw', v: fmtSig(p.Efw, 3) + ' rb/STB' }
      ].concat(d.influx ? [{ k: 'We', v: fmtSig(p.We / 1e6, 4) + ' MM rb' }] : []).concat([
        { foot: p.included ? 'In the fit. Click to leave it out.' : 'Left out. Click to add it back.' }
      ]);
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
    axes(f, x, y, T, { xTitle: d.xTitle || '*E*_t, rb/STB', yTitle: (d.influx ? '*F* − *W*_e' : '*F*') + ', MM rb' });
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
          { k: d.influx ? 'F − We' : 'F', v: fmtSig(p.F / 1e6, 4) + ' MM rb' },
          { k: d.influx ? '(F − We) / Et' : 'F / Et', v: fmtSig(p.F / p.Et / (d.nDiv || 1e6), 4) + ' ' + (d.nUnit || 'MMSTB') }
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
      { k: 'DDI', name: 'Depletion drive', short: 'depletion', color: T.oil },
      { k: 'SDI', name: 'Gas-cap drive', short: 'gas cap', color: T.gas },
      { k: 'WDI', name: 'Water influx', short: 'influx', color: T.water },
      { k: 'CDI', name: 'Water and rock expansion', short: 'expansion', color: T.rock }
    ].filter(function (s) { return (s.k !== 'CDI' || d.showWater) && (s.k !== 'WDI' || d.showInflux); });
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
          .text(minus(d3.format('.0%')(last[s.s.k])) + ' ' + s.s.short);
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

  /* ---------- reservoir sketch ---------- */

  var sketchSeq = 0;

  /**
   * A schematic cross-section of an anticline drawn from the material balance: a sand layer under the cap rock
   * holding gas, oil and, with water drive, the aquifer water. Contacts are level lines, placed so that the areas
   * in the drawing are in proportion to the volumes given, as parts of the initial hydrocarbon pore volume.
   * Zones that gas or water moved into since the start are hatched.
   * d = { now, start: {gas, oil, water} (parts of the pore volume, at the step shown and at the start),
   *       gasCap: free gas gathers in a gas cap (otherwise it is drawn as bubbles in the oil),
   *       aquifer: null or { reach: aquifer edge over the oil-zone edge (Infinity: past the drawing), lines: [rich text] },
   *       gasLines, oilLines, corner: [rich text], label: text for screen readers }
   */
  function reservoirSketch(el, d) {
    var T = tokens();
    var w = Math.max(280, Math.floor(el.clientWidth || 600));
    var h = Math.round(Math.max(230, Math.min(360, w * 0.4)));
    d3.select(el).selectAll('svg').remove();
    d3.select(el).selectAll('.empty').remove();
    var svg = d3.select(el).append('svg').attr('xmlns', SVGNS).attr('width', w).attr('height', h).attr('viewBox', '0 0 ' + w + ' ' + h)
      .attr('role', 'img').attr('aria-label', d.label || '').attr('font-family', T.fontBody).attr('font-size', 12);
    var id = 'sk' + (++sketchSeq);
    var mix = function (c, k) { return d3.interpolateRgb(T.paper, c)(k); };
    var col = {
      shale: mix(T.ink, 0.06), shaleLine: mix(T.ink, 0.2),
      gas: mix(T.gas, 0.34), gasIn: mix(T.gas, 0.12),
      oil: mix(T.oil, 0.36),
      water: mix(T.water, 0.34), waterIn: mix(T.water, 0.12)
    };

    // the structure: a dome-shaped top, and a layer that is a lens (no aquifer) or of even thickness (aquifer)
    var X = function (u) { return w / 2 + u * w / 2; };
    var y0 = h * 0.22, relief = h * 0.5, sig = 0.36;
    var top = function (u) { return y0 + relief * (1 - Math.exp(-u * u / (2 * sig * sig))); };
    var topU = function (z) { var q = (z - y0) / relief; return q <= 0 ? 0 : q >= 1 ? Infinity : sig * Math.sqrt(-2 * Math.log(1 - q)); };
    var aq = d.aquifer;
    var thick = aq ? h * 0.2 : h * 0.3;
    var uHc = 0.5;   // with an aquifer: where the oil zone ends on the top of the layer
    // the aquifer's outer edge, or none in the drawing when it lies past it
    var uEdge = !aq ? 0.74 : isFinite(aq.reach) && aq.reach * uHc <= 0.97 ? Math.max(uHc + 0.14, aq.reach * uHc) : Infinity;
    var th = function (u) {
      var a = Math.abs(u);
      if (!aq) return a >= uEdge ? 0 : thick * (1 - Math.pow(a / uEdge, 2));
      if (!isFinite(uEdge) || a <= uEdge - 0.07) return thick;
      return a >= uEdge ? 0 : thick * Math.sqrt(1 - Math.pow((a - uEdge + 0.07) / 0.07, 2));
    };
    var S = d3.range(0, w + 1).map(function (x) { var u = (x - w / 2) / (w / 2), t = top(u); return { x: x, u: u, t: t, b: t + th(u) }; });
    var layer = S.filter(function (s) { return s.b - s.t > 0.05; });
    var areaAbove = function (z) {
      var a = 0;
      for (var i = 0; i < layer.length; i++) a += Math.max(0, Math.min(z, layer[i].b) - layer[i].t);
      return a;
    };
    var depthFor = function (a) {
      var lo = y0 - 1, hi = h * 3;
      for (var i = 0; i < 44; i++) { var mid = (lo + hi) / 2; if (areaAbove(mid) < a) lo = mid; else hi = mid; }
      return (lo + hi) / 2;
    };
    // contacts: the hydrocarbon zone is the layer above the initial oil-water contact (or the whole lens)
    var owc0 = aq ? top(uHc) : null;
    var aHc = aq ? areaAbove(owc0) : areaAbove(h * 3);
    var part = function (f) {
      var g = Math.max(0, f.gas || 0), wt = Math.max(0, f.water || 0), o = Math.max(0, f.oil || 0);
      var sum = g + wt + o;
      return sum > 1 ? { gas: g / sum, water: wt / sum, oil: o / sum } : { gas: g, water: wt, oil: o };
    };
    var now = part(d.now), start = part(d.start);
    var goc = function (f) { return d.gasCap && f.gas > 0.001 ? depthFor(f.gas * aHc) : null; };
    var g0 = goc(start), g1 = goc(now);
    var o1 = aq ? depthFor((1 - now.water) * aHc) : null;
    if (g1 != null && o1 != null && g1 > o1) g1 = o1;
    var lowest = h * 3;

    // defs: the layer as a clip path, rock textures and hatching
    var defs = svg.append('defs');
    var path = function (pts) { return pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0] + ',' + p[1].toFixed(1); }).join(''); };
    var topPts = layer.map(function (s) { return [s.x, s.t]; }), botPts = layer.map(function (s) { return [s.x, s.b]; });
    defs.append('clipPath').attr('id', id + '-layer').append('path').attr('d', path(topPts.concat(botPts.slice().reverse())) + 'Z');
    var pat = function (pid, wd, ht) { return defs.append('pattern').attr('id', id + pid).attr('patternUnits', 'userSpaceOnUse').attr('width', wd).attr('height', ht); };
    var shale = pat('-shale', 24, 10);
    shale.append('line').attr('x1', 2).attr('y1', 3).attr('x2', 12).attr('y2', 3).attr('stroke', col.shaleLine).attr('stroke-width', 1);
    shale.append('line').attr('x1', 14).attr('y1', 8).attr('x2', 23).attr('y2', 8).attr('stroke', col.shaleLine).attr('stroke-width', 1);
    var sand = pat('-sand', 9, 8);
    [[2, 2], [6.5, 6]].forEach(function (c) { sand.append('circle').attr('cx', c[0]).attr('cy', c[1]).attr('r', 0.85).attr('fill', T.ink).attr('fill-opacity', 0.2); });
    var hatch = function (pid, color) {
      pat(pid, 6, 6).attr('patternTransform', 'rotate(45)')
        .append('line').attr('x1', 1).attr('y1', 0).attr('x2', 1).attr('y2', 6).attr('stroke', color).attr('stroke-width', 1.3).attr('stroke-opacity', 0.7);
    };
    hatch('-gh', T.gas);
    hatch('-wh', T.water);

    // rock around the reservoir
    svg.append('rect').attr('width', w).attr('height', h).attr('fill', col.shale);
    svg.append('rect').attr('width', w).attr('height', h).attr('fill', 'url(#' + id + '-shale)');

    // fluids in the layer, from the bottom up
    var fl = svg.append('g').attr('clip-path', 'url(#' + id + '-layer)');
    var band = function (z1, z2, fill) {
      if (!(z2 > z1)) return;
      fl.append('rect').attr('x', 0).attr('width', w).attr('y', Math.max(-1, z1)).attr('height', Math.min(lowest, z2) - Math.max(-1, z1)).attr('fill', fill);
    };
    band(-1, lowest, aq ? col.water : col.oil);
    if (aq && o1 < owc0 - 0.5) { band(o1, owc0, col.waterIn); band(o1, owc0, 'url(#' + id + '-wh)'); }
    band(g1 != null ? g1 : -1, aq ? o1 : lowest, col.oil);
    if (g0 != null || g1 != null) {
      var gTop = g0 != null && g1 != null ? Math.min(g0, g1) : g1 != null ? g1 : -1;
      band(-1, gTop, col.gas);
      if (g0 != null && g1 != null && g1 > g0 + 0.5) { band(g0, g1, col.gasIn); band(g0, g1, 'url(#' + id + '-gh)'); }
    }
    fl.append('rect').attr('width', w).attr('height', h).attr('fill', 'url(#' + id + '-sand)');

    // gas out of solution, as bubbles in the oil when there is no gas cap
    if (!d.gasCap && now.gas > 0.002) {
      var zTop = -1, zBot = aq ? o1 : lowest;
      var oilArea = areaAbove(zBot) - areaAbove(zTop);
      var count = Math.min(420, Math.round(now.gas / Math.max(1e-6, now.gas + now.oil) * oilArea / 34));
      var rnd = (function (seed) { return function () { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; })(7);
      var bubbles = [], xs = layer[0].x, xe = layer[layer.length - 1].x;
      for (var k = 0; k < 6000 && bubbles.length < count; k++) {
        var bx = xs + rnd() * (xe - xs), by = y0 + rnd() * (relief + thick), r = 1.3 + rnd() * 1.3;
        var sx = S[Math.max(0, Math.min(S.length - 1, Math.round(bx)))];
        if (by - r > sx.t + 1 && by + r < Math.min(sx.b, zBot) - 1) bubbles.push([bx, by, r]);
      }
      svg.append('g').attr('class', 'sk-bubbles').selectAll('circle').data(bubbles).join('circle')
        .attr('cx', function (q) { return q[0].toFixed(1); }).attr('cy', function (q) { return q[1].toFixed(1); }).attr('r', function (q) { return q[2].toFixed(2); })
        .attr('fill', mix(T.gas, 0.22)).attr('stroke', T.gas).attr('stroke-width', 0.9);
    }

    // the layer's top and base
    var edge = function (pts) { svg.append('path').attr('d', path(pts)).attr('fill', 'none').attr('stroke', T.ink2).attr('stroke-width', 1.2); };
    edge(topPts);
    edge(botPts);
    if (aq && !isFinite(uEdge)) {
      // the aquifer runs on past the drawing: break marks
      [6, w - 6].forEach(function (bx) {
        var s = S[bx], zz = [];
        for (var j = 0; j <= 4; j++) zz.push([bx + (j % 2 ? 4 : -4), s.t - 4 + (s.b - s.t + 8) * j / 4]);
        svg.append('path').attr('d', path(zz)).attr('fill', 'none').attr('stroke', T.ink2).attr('stroke-width', 1.4);
      });
    }

    // contacts: level lines inside the layer; dashed where they were at the start
    var cl = svg.append('g').attr('clip-path', 'url(#' + id + '-layer)');
    var lab = svg.append('g').attr('class', 'sk-labels');
    var text = function (x, y, markup, o) {
      o = o || {};
      var t = lab.append('text').attr('x', x).attr('y', y).attr('text-anchor', o.anchor || 'start').attr('fill', o.fill || T.ink)
        .attr('font-size', o.size || 12).attr('font-weight', o.weight || null);
      richSvg(t, markup, T);
      halo(t, T);
      return t;
    };
    var contact = function (z, color, name, initial) {
      cl.append('line').attr('x1', 0).attr('x2', w).attr('y1', z).attr('y2', z)
        .attr('stroke', initial ? T.muted : color).attr('stroke-width', initial ? 1.1 : 1.8).attr('stroke-dasharray', initial ? '5 4' : null);
      var u = topU(z);
      if (!isFinite(u)) return;
      if (initial) text(X(-u) - 6, z + 4, name + ' at start', { anchor: 'end', fill: T.muted, size: 11.5 });
      else text(X(u) + 6, z + 4, name, { weight: 600 });
    };
    if (g0 != null && g1 != null && Math.abs(g1 - g0) > 1.5) contact(g0, T.gas, 'GOC', true);
    if (aq && Math.abs(o1 - owc0) > 1.5) contact(owc0, T.water, 'OWC', true);
    if (g1 != null) contact(g1, T.gas, 'GOC', false);
    if (aq) contact(o1, T.water, 'OWC', false);

    // water coming in from the aquifer, up the flanks
    if (aq) {
      var reach = isFinite(uEdge) ? uEdge - 0.06 : 0.98;
      [0.3, 0.75].forEach(function (k) {
        var ua = uHc + 0.06 + (reach - uHc - 0.06) * k;
        if (ua <= uHc + 0.05) return;
        [-1, 1].forEach(function (sgn) {
          var u1 = sgn * ua, u2 = sgn * (ua - 0.07);
          var p1 = [X(u1), top(u1) + th(u1) / 2], p2 = [X(u2), top(u2) + th(u2) / 2];
          var ang = Math.atan2(p2[1] - p1[1], p2[0] - p1[0]);
          var head = 'M' + p2[0] + ',' + p2[1] + 'L' + (p2[0] - 7 * Math.cos(ang - 0.45)) + ',' + (p2[1] - 7 * Math.sin(ang - 0.45)) +
            'L' + (p2[0] - 7 * Math.cos(ang + 0.45)) + ',' + (p2[1] - 7 * Math.sin(ang + 0.45)) + 'Z';
          var ar = svg.append('g').attr('class', 'sk-influx');
          ar.append('line').attr('x1', p1[0]).attr('y1', p1[1]).attr('x2', p2[0]).attr('y2', p2[1]).attr('stroke', T.water).attr('stroke-width', 2);
          ar.append('path').attr('d', head).attr('fill', T.water);
        });
      });
    }

    // a producing well, left of the crest where the oil column was thickest at the start, perforated in it
    var oilAt = function (u) { return { a: g0 != null ? Math.max(g0, top(u)) : top(u), b: Math.min(top(u) + th(u), aq ? owc0 : lowest) }; };
    var uw = -0.2, best = -1;
    for (var uu = -0.14; uu >= -0.5; uu -= 0.01) {
      var oc = oilAt(uu), hh = oc.b - oc.a;
      if (hh > best + 2) { best = hh; uw = uu; }
    }
    var xw = Math.round(X(uw)) + 0.5, pTop = oilAt(uw).a, pBot = oilAt(uw).b;
    if (pBot > pTop + 6) {
      var p1 = pTop + (pBot - pTop) * 0.35, p2 = pTop + (pBot - pTop) * 0.75;
      svg.append('line').attr('class', 'sk-well').attr('x1', xw).attr('x2', xw).attr('y1', 0).attr('y2', p2 + 3).attr('stroke', T.ink).attr('stroke-width', 2.2);
      for (var yp = p1; yp <= p2; yp += 5) {
        svg.append('line').attr('x1', xw - 6).attr('x2', xw + 6).attr('y1', yp).attr('y2', yp).attr('stroke', T.ink).attr('stroke-width', 1.2);
      }
    }

    // names in the drawing: inside a zone where it is thick enough, otherwise outside with a leader line
    text(X(-0.94), h * 0.1, 'Cap rock', { fill: T.ink2 });
    var block = function (x, yMid, lines, anchor) {
      lines.forEach(function (l, i) { text(x, yMid + 4 + (i - (lines.length - 1) / 2) * 15, l, { anchor: anchor || 'middle', weight: i ? null : 600 }); });
    };
    var zoneAt = function (u, zTop, zBot) { return [Math.max(zTop, top(u)), Math.min(zBot, top(u) + th(u))]; };
    var name = function (lines, zTop, zBot, outside) {
      if (!lines || !lines.length || !(zBot > zTop)) return;
      var tall = lines.length * 15 + 4;
      var halfU = (d3.max(lines, function (l) { return l.replace(/[*_]/g, '').length; }) * 3.6 + 6) / (w / 2);
      var fit = null, thickest = null;
      for (var u = 0.04; u <= 0.62; u += 0.02) {
        var zc = zoneAt(u, zTop, zBot), mid = (zc[0] + zc[1]) / 2;
        if (!thickest || zc[1] - zc[0] > thickest.t + 0.5) thickest = { u: u, t: zc[1] - zc[0], y: mid };
        // the whole label, end to end, must sit inside the zone and clear of the well
        var inside = X(u - halfU) > xw + 10 && [-1, -0.5, 0, 0.5, 1].every(function (k) {
          var z = zoneAt(u + k * halfU, zTop, zBot);
          return z[0] <= mid - tall / 2 && z[1] >= mid + tall / 2;
        });
        if (inside && !fit) fit = { u: u, y: mid };
      }
      if (fit) { block(X(fit.u), fit.y, lines); return; }
      if (!thickest || !(thickest.t > 1)) return;
      // outside, in the rock above or below the layer, clear of it along the label's length
      var ua = thickest.u, ax = X(ua), ay = thickest.y;
      var u0 = Math.min(0.62, ua + 0.16), us = [u0, u0 + halfU, u0 + 2 * halfU];
      var ly = outside === 'above'
        ? Math.max(14, d3.min(us, function (q) { return top(q); }) - 12 - (lines.length - 1) * 15)
        : Math.min(h - 8 - (lines.length - 1) * 15, d3.max(us, function (q) { return top(q) + th(q); }) + 22);
      var lx = Math.max(4, Math.min(X(u0), w - 4 - halfU * w));   // the whole label on the drawing
      svg.insert('line', '.sk-labels').attr('x1', ax).attr('y1', ay).attr('x2', lx - 3).attr('y2', outside === 'above' ? ly + 3 : ly - 12)
        .attr('stroke', T.ink2).attr('stroke-width', 1);
      svg.insert('circle', '.sk-labels').attr('cx', ax).attr('cy', ay).attr('r', 2.2).attr('fill', T.ink2);
      block(lx, ly - 4 + (lines.length - 1) * 7.5, lines, 'start');
    };
    var gasBottom = g1 != null ? g1 : null;
    if (gasBottom != null) name(d.gasLines, -1, gasBottom, 'above');
    name(d.oilLines, gasBottom != null ? gasBottom : -1, aq ? o1 : lowest, gasBottom != null ? 'below' : 'above');
    if (aq && aq.lines) {
      var ua2 = isFinite(uEdge) ? Math.min(0.8, uEdge - 0.13) : 0.8;
      var half2 = d3.max(aq.lines, function (l) { return l.replace(/[*_]/g, '').length; }) * 3.3 + 4;
      var xa2 = Math.max(half2 + 4, Math.min(w - half2 - 4, X(ua2)));
      aq.lines.forEach(function (l, i) { text(xa2, top(ua2) - 12 - (aq.lines.length - 1 - i) * 15, l, { anchor: 'middle', weight: i ? null : 600 }); });
    }
    // the pressure and production in the corner; on a narrow screen the slider and the list say it
    if (w >= 520) (d.corner || []).forEach(function (l, i) { text(w - 10, 20 + i * 16, l, { anchor: 'end', weight: i ? null : 600 }); });
    return { w: w, h: h, goc: g1, owc: o1, gocStart: g0, owcStart: owc0 };
  }

  return {
    tokens: tokens,
    reservoirSketch: reservoirSketch,
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
