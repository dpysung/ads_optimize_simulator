/**
 * charts.js — Pure Canvas 2D chart library
 *
 * Exported functions (all draw into the supplied <canvas> element):
 *   drawLineChart(canvas, config)
 *   drawHistogram(canvas, config)
 *   drawBacktestChart(canvas, config)
 *   drawOptimizationChart(canvas, config)
 *
 * No external dependencies.
 */

const ChartsModule = (() => {

  /* ── Palette ────────────────────────────────────────────────────── */
  const C = {
    bg:      '#0f172a',
    surface: '#1e293b',
    border:  '#334155',
    text:    '#f1f5f9',
    muted:   '#94a3b8',
    blue:    '#3b82f6',
    green:   '#22c55e',
    orange:  '#f97316',
    purple:  '#a855f7',
    red:     '#ef4444',
    yellow:  '#eab308',
    teal:    '#14b8a6',
    pink:    '#ec4899',
    white:   '#ffffff',
  };

  const DATASET_COLORS = [C.blue, C.orange, C.green, C.purple, C.teal, C.pink, C.yellow, C.red];

  /* ── Utilities ──────────────────────────────────────────────────── */

  /** High-DPI canvas setup. Returns { ctx, W, H }. */
  function setup(canvas) {
    const dpr  = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const W    = rect.width  || canvas.offsetWidth  || 600;
    const H    = rect.height || canvas.offsetHeight || 320;
    canvas.width  = W * dpr;
    canvas.height = H * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    return { ctx, W, H };
  }

  /** Fill canvas background */
  function clear(ctx, W, H) {
    ctx.fillStyle = C.surface;
    ctx.fillRect(0, 0, W, H);
  }

  /**
   * Compute a "nice" axis scale with clean tick values.
   * Returns { min, max, ticks[] }
   */
  function niceScale(rawMin, rawMax, nTicks = 6) {
    if (rawMin === rawMax) {
      const d = Math.abs(rawMin) * 0.1 || 1;
      rawMin -= d; rawMax += d;
    }
    const range    = rawMax - rawMin;
    const rawStep  = range / nTicks;
    const mag      = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const nice     = [1, 2, 2.5, 5, 10];
    let step = mag * 10;
    for (const n of nice) {
      if (mag * n >= rawStep) { step = mag * n; break; }
    }
    const lo = Math.floor(rawMin / step) * step;
    const hi = Math.ceil(rawMax  / step) * step;
    const ticks = [];
    for (let t = lo; t <= hi + step * 1e-6; t += step) {
      ticks.push(parseFloat(t.toPrecision(10)));
    }
    return { min: lo, max: hi, ticks };
  }

  /** Compact number formatter */
  function fmt(v, type = 'num') {
    if (v === null || v === undefined || isNaN(v)) return '—';
    if (type === 'usd') {
      if (Math.abs(v) >= 1e6) return `$${(v/1e6).toFixed(2)}M`;
      if (Math.abs(v) >= 1e3) return `$${(v/1e3).toFixed(1)}K`;
      return `$${v.toFixed(0)}`;
    }
    if (type === 'pct') return `${v.toFixed(1)}%`;
    if (Math.abs(v) >= 1e6) return `${(v/1e6).toFixed(2)}M`;
    if (Math.abs(v) >= 1e3) return `${(v/1e3).toFixed(1)}K`;
    return v.toFixed(1);
  }

  /* ── Common drawing helpers ─────────────────────────────────────── */

  /**
   * Draw X/Y axes, grid lines, and axis labels.
   * px,py = plot origin (top-left);  pw,ph = plot size
   */
  function drawGrid(ctx, { px, py, pw, ph }, yScale, xTicks, xFmt, yFmt, xLabel, yLabel) {
    ctx.save();

    // Horizontal grid + Y labels
    ctx.strokeStyle = 'rgba(51,65,85,0.7)';
    ctx.lineWidth   = 1;
    ctx.font        = '11px Inter,system-ui,sans-serif';
    ctx.fillStyle   = C.muted;

    yScale.ticks.forEach(t => {
      const y = py + ph - (t - yScale.min) / (yScale.max - yScale.min) * ph;
      ctx.beginPath(); ctx.moveTo(px, y); ctx.lineTo(px + pw, y); ctx.stroke();
      ctx.textAlign     = 'right';
      ctx.textBaseline  = 'middle';
      ctx.fillText(yFmt ? yFmt(t) : fmt(t), px - 8, y);
    });

    // X labels
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'top';
    (xTicks || []).forEach(({ pos, label }) => {
      ctx.fillText(xFmt ? xFmt(label) : label, px + pos * pw, py + ph + 6);
    });

    // Axis lines
    ctx.strokeStyle = C.border;
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(px, py); ctx.lineTo(px, py + ph); ctx.lineTo(px + pw, py + ph);
    ctx.stroke();

    // Y-axis label (rotated)
    if (yLabel) {
      ctx.save();
      ctx.translate(12, py + ph / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillStyle    = C.muted;
      ctx.font         = '11px Inter,system-ui,sans-serif';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(yLabel, 0, 0);
      ctx.restore();
    }

    // X-axis label
    if (xLabel) {
      ctx.fillStyle    = C.muted;
      ctx.font         = '11px Inter,system-ui,sans-serif';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(xLabel, px + pw / 2, py + ph + 36);
    }

    ctx.restore();
  }

  /** Draw chart title */
  function drawTitle(ctx, W, title) {
    if (!title) return;
    ctx.save();
    ctx.fillStyle    = C.text;
    ctx.font         = 'bold 13px Inter,system-ui,sans-serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(title, W / 2, 10);
    ctx.restore();
  }

  /** Draw top-right legend */
  function drawLegend(ctx, { px, py, pw }, items) {
    if (!items || !items.length) return;
    ctx.save();
    ctx.font         = '11px Inter,system-ui,sans-serif';
    ctx.textBaseline = 'middle';

    // Measure max label width
    const lw = Math.max(...items.map(it => ctx.measureText(it.label).width));
    const itemH = 18;
    const boxW  = lw + 36;
    const boxH  = items.length * itemH + 10;
    const bx    = px + pw - boxW - 6;
    const by    = py + 6;

    ctx.fillStyle = 'rgba(15,23,42,0.6)';
    ctx.fillRect(bx, by, boxW, boxH);

    items.forEach((it, i) => {
      const ly = by + 5 + i * itemH + itemH / 2;
      ctx.strokeStyle = it.color;
      ctx.lineWidth   = 2;
      ctx.setLineDash(it.dashed ? [5, 3] : []);
      ctx.beginPath();
      ctx.moveTo(bx + 6, ly); ctx.lineTo(bx + 22, ly);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle    = C.muted;
      ctx.textAlign    = 'left';
      ctx.fillText(it.label, bx + 26, ly);
    });
    ctx.restore();
  }

  /* ══════════════════════════════════════════════════════════════════
   * PUBLIC: Line chart with optional confidence band
   * ══════════════════════════════════════════════════════════════════
   *
   * config = {
   *   datasets: [{
   *     label, data[], xs[],        // xs[] = x-values (numeric)
   *     bandLow[], bandHigh[],      // optional confidence band
   *     color, dashed, lineWidth, noDots
   *   }],
   *   title, xLabel, yLabel,
   *   xFmt, yFmt,                  // optional formatters
   *   xType: 'index' | 'value',
   * }
   */
  function drawLineChart(canvas, config) {
    const { ctx, W, H } = setup(canvas);
    clear(ctx, W, H);

    const { datasets = [], title, xLabel, yLabel, xFmt, yFmt } = config;
    if (!datasets.length || !datasets[0].data.length) {
      ctx.fillStyle = C.muted; ctx.font = '13px Inter,system-ui,sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('No data', W / 2, H / 2);
      return;
    }

    const M  = { t: 40, r: 20, b: 60, l: 80 };
    const px = M.l, py = M.t, pw = W - M.l - M.r, ph = H - M.t - M.b;

    // Collect all Y values (including bands)
    let allY = [];
    datasets.forEach(ds => {
      allY.push(...ds.data.filter(isFinite));
      if (ds.bandLow)  allY.push(...ds.bandLow.filter(isFinite));
      if (ds.bandHigh) allY.push(...ds.bandHigh.filter(isFinite));
    });
    const yScale = niceScale(Math.min(...allY) * 0.88, Math.max(...allY) * 1.08);

    // X scale from xs[] of first dataset with xs
    const refDs = datasets.find(d => d.xs);
    const xsRef = refDs ? refDs.xs : datasets[0].data.map((_, i) => i);
    const xMin  = Math.min(...xsRef);
    const xMax  = Math.max(...xsRef);
    const xScale = niceScale(xMin, xMax, 7);

    const toSX = x => px + (x - xScale.min) / (xScale.max - xScale.min) * pw;
    const toSY = y => py + ph - (y - yScale.min) / (yScale.max - yScale.min) * ph;

    // X tick positions
    const xTicks = xScale.ticks.map(t => ({ pos: (t - xScale.min) / (xScale.max - xScale.min), label: t }));

    drawTitle(ctx, W, title);
    drawGrid(ctx, { px, py, pw, ph }, yScale, xTicks, xFmt, yFmt, xLabel, yLabel);

    // Draw each dataset
    datasets.forEach((ds, di) => {
      const color  = ds.color || DATASET_COLORS[di % DATASET_COLORS.length];
      const xs     = ds.xs || ds.data.map((_, i) => i);
      const points = xs.map((x, i) => ({ sx: toSX(x), sy: toSY(ds.data[i]), v: ds.data[i] }));

      // Confidence band
      if (ds.bandLow && ds.bandHigh) {
        ctx.beginPath();
        xs.forEach((x, i) => {
          if (!isFinite(ds.bandHigh[i])) return;
          const sx = toSX(x), sy = toSY(ds.bandHigh[i]);
          i === 0 ? ctx.moveTo(sx, sy) : ctx.lineTo(sx, sy);
        });
        for (let i = xs.length - 1; i >= 0; i--) {
          if (!isFinite(ds.bandLow[i])) continue;
          ctx.lineTo(toSX(xs[i]), toSY(ds.bandLow[i]));
        }
        ctx.closePath();
        ctx.fillStyle = color + '28';
        ctx.fill();
      }

      // Line
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth   = ds.lineWidth || 2.5;
      ctx.lineJoin    = 'round';
      if (ds.dashed) ctx.setLineDash([6, 4]);
      ctx.beginPath();
      let first = true;
      points.forEach(p => {
        if (!isFinite(p.v)) { first = true; return; }
        first ? ctx.moveTo(p.sx, p.sy) : ctx.lineTo(p.sx, p.sy);
        first = false;
      });
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();

      // Dots
      if (!ds.noDots && points.length <= 60) {
        points.forEach(p => {
          if (!isFinite(p.v)) return;
          ctx.beginPath();
          ctx.arc(p.sx, p.sy, 3, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.fill();
        });
      }
    });

    drawLegend(ctx, { px, py, pw }, datasets.map((ds, i) => ({
      label: ds.label || `Series ${i+1}`,
      color: ds.color || DATASET_COLORS[i % DATASET_COLORS.length],
      dashed: !!ds.dashed,
    })));
  }

  /* ══════════════════════════════════════════════════════════════════
   * PUBLIC: Histogram (for Monte Carlo distributions)
   * ══════════════════════════════════════════════════════════════════
   *
   * config = {
   *   values[],                         // sorted sample array
   *   markers: [{ value, label, color }],
   *   title, xLabel, color
   * }
   */
  function drawHistogram(canvas, config) {
    const { ctx, W, H } = setup(canvas);
    clear(ctx, W, H);

    const { values = [], markers = [], title, xLabel, color } = config;
    if (!values.length) return;

    const M  = { t: 48, r: 20, b: 52, l: 55 };
    const px = M.l, py = M.t, pw = W - M.l - M.r, ph = H - M.t - M.b;

    const nBins  = Math.min(50, Math.round(Math.sqrt(values.length)));
    const vMin   = values[0];
    const vMax   = values[values.length - 1];
    const span   = vMax - vMin || 1;
    const binW   = span / nBins;

    // Bin the values
    const bins = new Array(nBins).fill(0);
    values.forEach(v => {
      const idx = Math.min(nBins - 1, Math.floor((v - vMin) / binW));
      bins[idx]++;
    });
    const maxBin = Math.max(...bins);

    const toSX = v => px + (v - vMin) / span * pw;
    const toSY = n => py + ph - (n / maxBin) * ph;
    const barPx = pw / nBins - 0.5;

    // Bars
    bins.forEach((cnt, i) => {
      if (!cnt) return;
      const x = px + (i / nBins) * pw;
      const y = toSY(cnt);
      ctx.fillStyle = (color || C.blue) + 'a0';
      ctx.fillRect(x, y, barPx, py + ph - y);
    });

    // Axis line
    ctx.strokeStyle = C.border;
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(px, py); ctx.lineTo(px, py + ph); ctx.lineTo(px + pw, py + ph);
    ctx.stroke();

    // X ticks
    const xScale = niceScale(vMin, vMax, 5);
    ctx.fillStyle    = C.muted;
    ctx.font         = '10px Inter,system-ui,sans-serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'top';
    xScale.ticks.filter(t => t >= vMin && t <= vMax).forEach(t => {
      ctx.fillText(fmt(t), toSX(t), py + ph + 5);
    });

    if (xLabel) {
      ctx.fillText(xLabel, px + pw / 2, py + ph + 30);
    }

    // Markers
    const mkrPosY = py + 4;
    markers.forEach(mk => {
      if (mk.value < vMin || mk.value > vMax) return;
      const sx = toSX(mk.value);

      ctx.strokeStyle = mk.color;
      ctx.lineWidth   = 2;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(sx, py); ctx.lineTo(sx, py + ph);
      ctx.stroke();
      ctx.setLineDash([]);

      // Label above
      ctx.fillStyle    = mk.color;
      ctx.font         = 'bold 10px Inter,system-ui,sans-serif';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(mk.label, sx, mkrPosY);
    });

    drawTitle(ctx, W, title);

    // Legend row below title
    const legItems = markers.map(m => m.label).join('  |  ');
    if (legItems) {
      ctx.fillStyle    = C.muted;
      ctx.font         = '10px Inter,system-ui,sans-serif';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(legItems, W / 2, 26);
    }
  }

  /* ══════════════════════════════════════════════════════════════════
   * PUBLIC: Backtest chart (actual vs predicted, train/test bands)
   * ══════════════════════════════════════════════════════════════════
   *
   * config = {
   *   trainResults[], testResults[],
   *   kpi: 'purchase' | 'revenue',
   *   title, yFmt
   * }
   */
  function drawBacktestChart(canvas, config) {
    const { ctx, W, H } = setup(canvas);
    clear(ctx, W, H);

    const { trainResults = [], testResults = [], kpi = 'purchase', title, yFmt } = config;
    const allRows = [...trainResults, ...testResults];
    if (!allRows.length) return;

    const actualKey = kpi === 'purchase' ? 'actualPurchase'    : 'actualRevenue';
    const predKey   = kpi === 'purchase' ? 'predictedPurchase' : 'predictedRevenue';

    const M  = { t: 40, r: 20, b: 72, l: 80 };
    const px = M.l, py = M.t, pw = W - M.l - M.r, ph = H - M.t - M.b;

    const allY = allRows.flatMap(r => [r[actualKey], r[predKey]]).filter(isFinite);
    const yScale = niceScale(Math.min(...allY) * 0.85, Math.max(...allY) * 1.1);

    const n     = allRows.length;
    const nTrain = trainResults.length;
    const toSX  = i => px + (i / (n - 1 || 1)) * pw;
    const toSY  = v => py + ph - (v - yScale.min) / (yScale.max - yScale.min) * ph;

    // Train / test bands
    if (nTrain > 0) {
      const divX = toSX(nTrain - 1);
      ctx.fillStyle = 'rgba(59,130,246,0.06)';
      ctx.fillRect(px, py, divX - px, ph);
      ctx.fillStyle = 'rgba(34,197,94,0.06)';
      ctx.fillRect(divX, py, px + pw - divX, ph);

      ctx.strokeStyle = C.blue + '60';
      ctx.lineWidth   = 1;
      ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(divX, py); ctx.lineTo(divX, py + ph); ctx.stroke();
      ctx.setLineDash([]);

      ctx.font         = '11px Inter,system-ui,sans-serif';
      ctx.textBaseline = 'top';
      ctx.fillStyle    = C.blue + 'cc';
      ctx.textAlign    = 'center';
      ctx.fillText('▐ Train', px + (divX - px) / 2, py + 4);
      ctx.fillStyle    = C.green + 'cc';
      ctx.fillText('Test ▌', divX + (px + pw - divX) / 2, py + 4);
    }

    // Grid
    const xTicks = [];
    const step   = Math.max(1, Math.round(n / 8));
    allRows.forEach((r, i) => { if (i % step === 0) xTicks.push({ pos: i / (n - 1 || 1), label: r.date.slice(5) }); });

    drawGrid(ctx, { px, py, pw, ph }, yScale, xTicks, null, yFmt, 'Date (MM-DD)', null);

    // Draw lines helper
    const line = (data, key, color, dashed, offset = 0) => {
      if (!data.length) return;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth   = 2;
      ctx.lineJoin    = 'round';
      if (dashed) ctx.setLineDash([6, 4]);
      ctx.beginPath();
      data.forEach((r, i) => {
        const sx = toSX(i + offset);
        const sy = toSY(r[key]);
        i === 0 ? ctx.moveTo(sx, sy) : ctx.lineTo(sx, sy);
      });
      ctx.stroke();
      ctx.restore();
    };

    line(trainResults, actualKey, C.blue,   false, 0);
    line(trainResults, predKey,   C.blue,   true,  0);
    line(testResults,  actualKey, C.green,  false, nTrain);
    line(testResults,  predKey,   C.orange, true,  nTrain);

    drawTitle(ctx, W, title);
    drawLegend(ctx, { px, py, pw }, [
      { label: 'Actual (Train)',    color: C.blue,   dashed: false },
      { label: 'Predicted (Train)', color: C.blue,   dashed: true  },
      { label: 'Actual (Test)',     color: C.green,  dashed: false },
      { label: 'Predicted (Test)',  color: C.orange, dashed: true  },
    ]);
  }

  /* ══════════════════════════════════════════════════════════════════
   * PUBLIC: Optimization chart
   * Shows ROAS curve and Purchase/Revenue curves vs Budget
   * ══════════════════════════════════════════════════════════════════
   *
   * config = {
   *   curve[]: { budget, purchase, revenue, roas },
   *   optimalBudget,
   *   objective: 'roas' | 'purchase' | 'revenue',
   *   kpi: 'roas' | 'purchase' | 'revenue',    // which to draw
   *   title, yFmt, xFmt
   * }
   */
  function drawOptimizationChart(canvas, config) {
    const { ctx, W, H } = setup(canvas);
    clear(ctx, W, H);

    const { curve = [], optimalBudget, kpi = 'revenue', title, yFmt, xFmt } = config;
    if (!curve.length) return;

    const M  = { t: 40, r: 20, b: 60, l: 80 };
    const px = M.l, py = M.t, pw = W - M.l - M.r, ph = H - M.t - M.b;

    const xs   = curve.map(p => p.budget);
    const ys   = curve.map(p => p[kpi]);
    const color = kpi === 'roas' ? C.purple : kpi === 'purchase' ? C.orange : C.green;

    const xScale = niceScale(Math.min(...xs), Math.max(...xs), 7);
    const yScale = niceScale(Math.min(...ys) * 0.88, Math.max(...ys) * 1.08);

    const toSX = b => px + (b - xScale.min) / (xScale.max - xScale.min) * pw;
    const toSY = v => py + ph - (v - yScale.min) / (yScale.max - yScale.min) * ph;

    const xTicks = xScale.ticks.map(t => ({ pos: (t - xScale.min) / (xScale.max - xScale.min), label: t }));
    drawGrid(ctx, { px, py, pw, ph }, yScale, xTicks, xFmt, yFmt, 'Daily Budget (USD)', null);

    // Curve
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth   = 2.5;
    ctx.lineJoin    = 'round';
    curve.forEach((pt, i) => {
      const sx = toSX(pt.budget);
      const sy = toSY(pt[kpi]);
      i === 0 ? ctx.moveTo(sx, sy) : ctx.lineTo(sx, sy);
    });
    ctx.stroke();

    // Optimal vertical line
    if (optimalBudget) {
      const ox = toSX(optimalBudget);
      ctx.strokeStyle = C.yellow;
      ctx.lineWidth   = 1.5;
      ctx.setLineDash([5, 3]);
      ctx.beginPath();
      ctx.moveTo(ox, py); ctx.lineTo(ox, py + ph);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle    = C.yellow;
      ctx.font         = 'bold 10px Inter,system-ui,sans-serif';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText('★ Optimal', ox, py + ph - 2);
    }

    drawTitle(ctx, W, title);
  }

  /* ══════════════════════════════════════════════════════════════════
   * PUBLIC: Timeline Chart (Highlights custom period modification)
   * ══════════════════════════════════════════════════════════════════
   *
   * config = {
   *   timeline: [{ date, inPeriod, baselineCost, modifiedCost, baselineRevenue, modifiedRevenue, baselineROAS, modifiedROAS }],
   *   metric: 'revenue' | 'cost' | 'roas',
   *   title, yFmt
   * }
   */
  function drawTimelineChart(canvas, config) {
    const { ctx, W, H } = setup(canvas);
    clear(ctx, W, H);

    const { timeline = [], metric = 'revenue', title, yFmt } = config;
    if (!timeline.length) return;

    const baseKey = metric === 'cost' ? 'baselineCost' : metric === 'roas' ? 'baselineROAS' : 'baselineRevenue';
    const modKey  = metric === 'cost' ? 'modifiedCost' : metric === 'roas' ? 'modifiedROAS' : 'modifiedRevenue';
    const actKey  = metric === 'cost' ? 'actualCost'   : metric === 'roas' ? 'actualROAS'   : 'actualRevenue';

    const M  = { t: 40, r: 20, b: 64, l: 80 };
    const px = M.l, py = M.t, pw = W - M.l - M.r, ph = H - M.t - M.b;

    const allY = timeline.flatMap(p => [p[baseKey], p[modKey], p[actKey] || 0]).filter(isFinite);
    const yScale = niceScale(Math.min(...allY) * 0.85, Math.max(...allY) * 1.12);

    const n    = timeline.length;
    const toSX = i => px + (i / (n - 1 || 1)) * pw;
    const toSY = v => py + ph - (v - yScale.min) / (yScale.max - yScale.min) * ph;

    // Highlight period areas (single or multiple)
    const inPeriodIndices = [];
    timeline.forEach((pt, i) => {
      if (pt.inPeriod) inPeriodIndices.push(i);
    });

    if (inPeriodIndices.length > 0) {
      // Find contiguous blocks of inPeriod
      const blocks = [];
      let curStart = inPeriodIndices[0], curEnd = inPeriodIndices[0];
      for (let j = 1; j < inPeriodIndices.length; j++) {
        if (inPeriodIndices[j] === curEnd + 1) {
          curEnd = inPeriodIndices[j];
        } else {
          blocks.push({ s: curStart, e: curEnd });
          curStart = inPeriodIndices[j];
          curEnd = inPeriodIndices[j];
        }
      }
      blocks.push({ s: curStart, e: curEnd });

      blocks.forEach((blk, bIdx) => {
        const hx1 = toSX(blk.s);
        const hx2 = toSX(blk.e);
        const hw  = Math.max(6, hx2 - hx1);

        ctx.fillStyle = bIdx % 2 === 0 ? 'rgba(59, 130, 246, 0.13)' : 'rgba(168, 85, 247, 0.13)';
        ctx.fillRect(hx1, py, hw, ph);

        ctx.strokeStyle = bIdx % 2 === 0 ? 'rgba(59, 130, 246, 0.45)' : 'rgba(168, 85, 247, 0.45)';
        ctx.lineWidth   = 1;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(hx1, py); ctx.lineTo(hx1, py + ph);
        ctx.moveTo(hx2, py); ctx.lineTo(hx2, py + ph);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.font         = '10px Inter,system-ui,sans-serif';
        ctx.fillStyle    = bIdx % 2 === 0 ? C.blue : C.purple;
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(blocks.length > 1 ? `Period #${bIdx+1}` : '★ Modified Period', hx1 + hw / 2, py + 4);
      });
    }

    // X Axis ticks
    const xTicks = [];
    const step   = Math.max(1, Math.round(n / 8));
    timeline.forEach((r, i) => {
      if (i % step === 0 || i === n - 1) xTicks.push({ pos: i / (n - 1 || 1), label: r.date.slice(5) });
    });

    drawGrid(ctx, { px, py, pw, ph }, yScale, xTicks, null, yFmt, 'Date (MM-DD)', null);

    // Line helper
    const drawSeries = (key, color, dashed, lineWidth = 2) => {
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth   = lineWidth;
      ctx.lineJoin    = 'round';
      if (dashed) ctx.setLineDash([5, 3]);
      ctx.beginPath();
      timeline.forEach((pt, i) => {
        const sx = toSX(i);
        const sy = toSY(pt[key]);
        i === 0 ? ctx.moveTo(sx, sy) : ctx.lineTo(sx, sy);
      });
      ctx.stroke();
      ctx.restore();
    };

    // 1) Actual historical
    drawSeries(actKey, 'rgba(148, 163, 184, 0.45)', true, 1.5);
    // 2) Baseline
    drawSeries(baseKey, C.muted, false, 2);
    // 3) Modified Simulation
    drawSeries(modKey, metric === 'roas' ? C.purple : C.green, false, 2.5);

    drawTitle(ctx, W, title);
    drawLegend(ctx, { px, py, pw }, [
      { label: 'Historical Actual', color: 'rgba(148, 163, 184, 0.7)', dashed: true },
      { label: 'Current Baseline', color: C.muted, dashed: false },
      { label: 'Simulated Budget', color: metric === 'roas' ? C.purple : C.green, dashed: false },
    ]);
  }

  /* ══════════════════════════════════════════════════════════════════
   * PUBLIC: Strategy Simulation Timeline Chart
   * ══════════════════════════════════════════════════════════════════
   */
  function drawStrategyTimelineChart(canvas, config) {
    const { ctx, W, H } = setup(canvas);
    clear(ctx, W, H);

    const { timeline = [], metric = 'revenue', title, yFmt } = config;
    if (!timeline.length) return;

    const actKey   = metric === 'cost' ? 'actualCost' : metric === 'roas' ? 'actualROAS' : 'actualRevenue';
    const stratKey = metric === 'cost' ? 'strategyCost' : metric === 'roas' ? 'strategyROAS' : 'strategyRevenue';

    const M  = { t: 40, r: 20, b: 64, l: 80 };
    const px = M.l, py = M.t, pw = W - M.l - M.r, ph = H - M.t - M.b;

    const allY = timeline.flatMap(p => [p[actKey], p[stratKey]]).filter(isFinite);
    const yScale = niceScale(Math.min(...allY) * 0.85, Math.max(...allY) * 1.12);

    const n    = timeline.length;
    const toSX = i => px + (i / (n - 1 || 1)) * pw;
    const toSY = v => py + ph - (v - yScale.min) / (yScale.max - yScale.min) * ph;

    const xTicks = [];
    const step   = Math.max(1, Math.round(n / 8));
    timeline.forEach((r, i) => {
      if (i % step === 0 || i === n - 1) xTicks.push({ pos: i / (n - 1 || 1), label: r.date.slice(5) });
    });

    drawGrid(ctx, { px, py, pw, ph }, yScale, xTicks, null, yFmt, 'Date (MM-DD)', null);

    const drawSeries = (key, color, dashed, lineWidth = 2) => {
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth   = lineWidth;
      ctx.lineJoin    = 'round';
      if (dashed) ctx.setLineDash([5, 3]);
      ctx.beginPath();
      timeline.forEach((pt, i) => {
        const sx = toSX(i);
        const sy = toSY(pt[key]);
        i === 0 ? ctx.moveTo(sx, sy) : ctx.lineTo(sx, sy);
      });
      ctx.stroke();
      ctx.restore();
    };

    // Actual vs Strategy
    drawSeries(actKey, 'rgba(148, 163, 184, 0.65)', true, 2);
    drawSeries(stratKey, metric === 'roas' ? C.purple : C.green, false, 2.5);

    drawTitle(ctx, W, title);
    drawLegend(ctx, { px, py, pw }, [
      { label: '과거 실제 집행 실적 (Actual)', color: 'rgba(148, 163, 184, 0.7)', dashed: true },
      { label: '전략 룰 적용 시뮬레이션 (Strategy)', color: metric === 'roas' ? C.purple : C.green, dashed: false },
    ]);
  }

  /* ── Public API ─────────────────────────────────────────────────── */
  return {
    COLORS: C,
    fmt,
    drawLineChart,
    drawHistogram,
    drawBacktestChart,
    drawOptimizationChart,
    drawTimelineChart,
    drawStrategyTimelineChart,
  };

})();
