/**
 * data.js — Data handling module
 * Responsibilities: CSV parsing, sample data generation, campaign filtering
 */

const DataModule = (() => {

  /* ── Default column mapping ─────────────────────────────────────── */
  const DEFAULT_COL_MAP = {
    date:     'date',
    campaign: 'campaign',
    cost:     'cost',
    purchase: 'cm360_transaction',
    revenue:  'cm360_revenue_USD',
    // daily_budget: '' — reserved for future use
  };

  /* ── CSV parsing ────────────────────────────────────────────────── */

  /** Parse a single CSV line, handling quoted fields */
  function parseCSVLine(line) {
    const result = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQ = !inQ; }
      else if (ch === ',' && !inQ) { result.push(cur); cur = ''; }
      else { cur += ch; }
    }
    result.push(cur);
    return result;
  }

  /** Parse full CSV text → { headers, rows } */
  function parseCSV(text) {
    const lines = text.trim().split(/\r?\n/);
    if (lines.length < 2) return { headers: [], rows: [] };

    const headers = parseCSVLine(lines[0]).map(h => h.trim().replace(/^"|"$/g, ''));
    const rows = [];

    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      const vals = parseCSVLine(lines[i]);
      const row = {};
      headers.forEach((h, j) => {
        row[h] = (vals[j] !== undefined ? vals[j] : '').trim().replace(/^"|"$/g, '');
      });
      rows.push(row);
    }
    return { headers, rows };
  }

  /* ── Data processing ────────────────────────────────────────────── */

  /**
   * Convert raw string rows → typed rows, dropping invalid records.
   * Returns array of { date, campaign, cost, purchase, revenue }
   */
  function processRows(rows, colMap) {
    return rows.map(r => ({
      date:     r[colMap.date]     || '',
      campaign: r[colMap.campaign] || '',
      cost:     parseFloat(r[colMap.cost])     || 0,
      purchase: parseFloat(r[colMap.purchase]) || 0,
      revenue:  parseFloat(r[colMap.revenue])  || 0,
    })).filter(r =>
      r.date && r.campaign &&
      r.cost > 0 && r.purchase > 0 && r.revenue > 0
    );
  }

  /** Unique sorted campaign list */
  function getCampaigns(processedRows) {
    return [...new Set(processedRows.map(r => r.campaign))].filter(Boolean).sort();
  }

  /** Filter by campaign name */
  function filterByCampaign(processedRows, campaign) {
    return processedRows.filter(r => r.campaign === campaign);
  }

  /**
   * Return data within the last `weeks` weeks relative to
   * the most recent date in the dataset. Falls back to all
   * data if fewer than 7 qualifying rows exist.
   */
  function getRecentData(processedRows, weeks) {
    if (!processedRows.length) return [];
    const sorted = [...processedRows].sort((a, b) => b.date.localeCompare(a.date));
    const latest = new Date(sorted[0].date);
    const cutoff = new Date(latest);
    cutoff.setDate(cutoff.getDate() - weeks * 7);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    const recent = sorted.filter(r => r.date >= cutoffStr);
    return recent.length >= 7 ? recent : sorted;
  }

  /** Get min and max dates from rows */
  function getDateRange(rows) {
    if (!rows || !rows.length) return { minDate: '', maxDate: '' };
    const dates = rows.map(r => r.date).sort();
    return { minDate: dates[0], maxDate: dates[dates.length - 1] };
  }

  /* ── Summary statistics ─────────────────────────────────────────── */

  /** Basic descriptive stats for processed data */
  function summarise(rows) {
    if (!rows.length) return null;
    const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
    const n = rows.length;
    const sumCost = rows.reduce((s, r) => s + r.cost, 0);
    const sumPurch = rows.reduce((s, r) => s + r.purchase, 0);
    const sumRev   = rows.reduce((s, r) => s + r.revenue, 0);
    return {
      n,
      dateFrom: sorted[0].date,
      dateTo:   sorted[n - 1].date,
      totalCost:     sumCost,
      totalPurchase: sumPurch,
      totalRevenue:  sumRev,
      avgCost:       sumCost  / n,
      avgPurchase:   sumPurch / n,
      avgRevenue:    sumRev   / n,
      avgROAS:       sumCost > 0 ? (sumRev / sumCost * 100) : 0,
      minCost: Math.min(...rows.map(r => r.cost)),
      maxCost: Math.max(...rows.map(r => r.cost)),
    };
  }

  /* ── Sample data generator ──────────────────────────────────────── */

  /**
   * Generate 3 campaigns × 90 days of realistic ad performance data.
   * Uses a seeded LCG so results are deterministic on every load.
   *
   * Core assumption embedded in sample data:
   *   kpi ∝ cost^0.75   (diminishing returns, β ≈ 0.75)
   */
  function generateSampleData() {
    /* Seeded LCG for reproducibility */
    let seed = 20240901;
    const rng = () => {
      seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const randn = () => {
      // Box–Muller
      let u1, u2;
      do { u1 = rng(); } while (u1 === 0);
      u2 = rng();
      return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    };

    const configs = [
      {
        name: 'Campaign_Alpha',
        baseCost: 920,  baseTxn: 46,  baseRev: 9800,
        costLo: 580,    costHi: 1450,
        noiseTxn: 0.18, noiseRev: 0.20,
      },
      {
        name: 'Campaign_Beta',
        baseCost: 460,  baseTxn: 23,  baseRev: 4350,
        costLo: 260,    costHi: 740,
        noiseTxn: 0.20, noiseRev: 0.22,
      },
      {
        name: 'Campaign_Gamma',
        baseCost: 215,  baseTxn: 11,  baseRev: 1850,
        costLo: 110,    costHi: 390,
        noiseTxn: 0.22, noiseRev: 0.24,
      },
    ];

    const BETA = 0.75;           // diminishing-returns elasticity
    const start = new Date('2026-06-15');
    const rows = [];

    for (let d = 0; d < 90; d++) {
      const date = new Date(start);
      date.setDate(date.getDate() + d);
      const dow  = date.getDay();                          // 0 Sun … 6 Sat
      const wknd = (dow === 0 || dow === 6) ? 0.72 : 1.0; // weekend dip
      const trend = 1 + (d / 90) * 0.10;                  // 10% growth arc
      const dateStr = date.toISOString().slice(0, 10);

      configs.forEach(cfg => {
        // Vary cost ±30% (simulates pacing & budget changes)
        const costRaw  = cfg.baseCost * wknd * trend * Math.exp(randn() * 0.22);
        const cost     = Math.max(cfg.costLo, Math.min(cfg.costHi, Math.round(costRaw)));

        // Diminishing returns applied to relative cost change
        const rel = cost / cfg.baseCost;
        const perf = Math.pow(rel, BETA) * wknd * trend;

        const purchases = Math.max(1, Math.round(cfg.baseTxn * perf * Math.exp(randn() * cfg.noiseTxn)));
        const revenue   = Math.max(1, Math.round(cfg.baseRev  * perf * Math.exp(randn() * cfg.noiseRev)));
        const impr      = Math.round(cost * (115 + rng() * 45));
        const clicks    = Math.round(cost * (3.2 + rng() * 1.8));

        rows.push({
          date: dateStr,
          campaign: cfg.name,
          cost,
          cm360_transaction: purchases,
          cm360_revenue_USD: revenue,
          impressions: impr,
          clicks,
        });
      });
    }

    return rows;
  }

  /** Serialize sample rows to CSV string (for download) */
  function rowsToCSV(rows) {
    if (!rows.length) return '';
    const headers = Object.keys(rows[0]);
    const lines = [headers.join(',')];
    rows.forEach(r => lines.push(headers.map(h => r[h]).join(',')));
    return lines.join('\n');
  }

  /* ── Public API ─────────────────────────────────────────────────── */
  return {
    DEFAULT_COL_MAP,
    parseCSV,
    processRows,
    getCampaigns,
    filterByCampaign,
    getRecentData,
    getDateRange,
    summarise,
    generateSampleData,
    rowsToCSV,
  };

})();
