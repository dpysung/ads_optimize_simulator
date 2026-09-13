/**
 * app.js — Main application controller
 *
 * Depends on: DataModule, ModelModule, ChartsModule (loaded before this file)
 */

/* ══════════════════════════════════════════════════════════════════
 * STATE
 * ══════════════════════════════════════════════════════════════════ */
const App = (() => {

  const state = {
    rawRows:       [],     // all processed rows from all campaigns
    campaigns:     [],
    colMap:        { ...DataModule.DEFAULT_COL_MAP },

    settings: {
      lambda:       0.10,  // decay rate for time-weighting
      simRuns:      10000, // Monte Carlo iterations
      analysisWeeks: 4,    // default recent window
    },

    // per-tab cache
    simResult:      null,
    whatifResult:   null,
    optResult:      null,
    backtestResult: null,

    whatifBudgets:  [],    // user-specified budget list for What-if tab
    timelineMetric: 'revenue', // metric for simulation timeline chart: 'revenue' | 'roas' | 'cost'

    // Multi-period scheduling
    simMode:        'single',  // 'single' | 'multi'
    simSchedules:   [],        // array of { id, startDate, endDate, budget, label }

    // Strategy lab cache
    stratResult:    null,
  };

  /* ──────────────────────────────────────────────────────────────── */
  /* HELPERS                                                          */
  /* ──────────────────────────────────────────────────────────────── */

  const $ = id => document.getElementById(id);
  const fmt = (v, type = 'num') => ChartsModule.fmt(v, type);

  /** Show toast notification */
  function toast(msg, type = 'info') {
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = msg;
    document.getElementById('toast-container').appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 300);
    }, 3200);
  }

  /** Populate campaign selects across all tabs */
  function populateCampaignSelects() {
    const selects = document.querySelectorAll('.campaign-select');
    selects.forEach(sel => {
      const prev = sel.value;
      sel.innerHTML = state.campaigns.map(c =>
        `<option value="${c}">${c}</option>`
      ).join('');
      if (prev && state.campaigns.includes(prev)) sel.value = prev;
    });

    // Auto sync date range and budget hints for simulation tab
    syncSimCampaignDefaults();
  }

  /** Sync date pickers and budget placeholders based on selected campaign */
  function syncSimCampaignDefaults() {
    const rows = getCampaignRows('sim-campaign');
    if (!rows.length) return;

    const summary = DataModule.summarise(rows);
    if (!summary) return;

    const startDateEl = $('sim-start-date');
    const endDateEl   = $('sim-end-date');
    if (startDateEl && endDateEl) {
      startDateEl.min = summary.dateFrom;
      startDateEl.max = summary.dateTo;
      endDateEl.min   = summary.dateFrom;
      endDateEl.max   = summary.dateTo;

      // Set values if empty or outside range
      if (!startDateEl.value || startDateEl.value < summary.dateFrom || startDateEl.value > summary.dateTo) {
        startDateEl.value = summary.dateFrom;
      }
      if (!endDateEl.value || endDateEl.value < summary.dateFrom || endDateEl.value > summary.dateTo) {
        endDateEl.value = summary.dateTo;
      }
    }

    // Pre-fill budget suggestions if empty
    const curBudEl = $('sim-current-budget');
    const newBudEl = $('sim-new-budget');
    if (curBudEl && (!curBudEl.value || curBudEl.value === '0')) {
      curBudEl.value = Math.round(summary.avgCost);
    }
    if (newBudEl && (!newBudEl.value || newBudEl.value === '0')) {
      newBudEl.value = Math.round(summary.avgCost * 1.5);
    }

    updateSimPeriodBadge();
  }

  /** Update the badge showing selected days count */
  function updateSimPeriodBadge() {
    const badge = $('sim-period-badge');
    const sDate = $('sim-start-date')?.value;
    const eDate = $('sim-end-date')?.value;
    if (!badge || !sDate || !eDate) return;

    const d1 = new Date(sDate);
    const d2 = new Date(eDate);
    if (isNaN(d1.getTime()) || isNaN(d2.getTime())) {
      badge.textContent = '날짜 선택';
      return;
    }

    const days = Math.max(1, Math.round(Math.abs(d2 - d1) / (1000 * 60 * 60 * 24)) + 1);
    badge.textContent = `📅 ${days}일간 적용`;
  }

  /** Get processed rows for a specific campaign select */
  function getCampaignRows(selectId) {
    const campaign = $(selectId)?.value;
    if (!campaign) return [];
    return DataModule.filterByCampaign(state.rawRows, campaign);
  }

  /** Delta badge HTML: green if positive, red if negative */
  function deltaBadge(curr, sim, type = 'num', invertColor = false) {
    if (curr == null || sim == null) return '<span class="muted">—</span>';
    const diff = sim - curr;
    const pct  = curr !== 0 ? (diff / Math.abs(curr)) * 100 : 0;
    const positive = diff >= 0;
    const good     = invertColor ? !positive : positive;
    const sign     = diff >= 0 ? '+' : '';
    const cls      = good ? 'badge-up' : 'badge-down';
    const arrow    = good ? '▲' : '▼';
    return `<span class="badge ${cls}">${arrow} ${sign}${fmt(diff, type)} (${sign}${pct.toFixed(1)}%)</span>`;
  }

  /** Resize a canvas to its container width, redraw last chart */
  function resizeCanvas(canvas, drawFn) {
    if (!canvas || !drawFn) return;
    canvas.style.width  = '100%';
    if (drawFn._lastConfig) drawFn(canvas, drawFn._lastConfig);
  }

  /** Wrap a draw call and cache config on the canvas for resize support */
  function draw(fn, canvas, config) {
    if (!canvas) return;
    canvas._drawFn     = fn;
    canvas._drawConfig = config;
    fn(canvas, config);
  }

  /* ──────────────────────────────────────────────────────────────── */
  /* TAB SWITCHING                                                    */
  /* ──────────────────────────────────────────────────────────────── */

  function initTabs() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        $('tab-' + btn.dataset.tab).classList.add('active');
      });
    });
  }

  /* ══════════════════════════════════════════════════════════════════
   * TAB 1: DATA
   * ══════════════════════════════════════════════════════════════════ */

  function initDataTab() {
    // Drag & Drop
    const zone = $('drop-zone');
    zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('dragover'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
    zone.addEventListener('drop', e => {
      e.preventDefault();
      zone.classList.remove('dragover');
      const file = e.dataTransfer.files[0];
      if (file) loadCSVFile(file);
    });

    $('file-input').addEventListener('change', e => {
      const file = e.target.files[0];
      if (file) loadCSVFile(file);
    });

    $('btn-sample').addEventListener('click', loadSampleData);
    $('btn-apply-cols').addEventListener('click', applyColMapping);
  }

  function loadCSVFile(file) {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const { headers, rows } = DataModule.parseCSV(e.target.result);
        ingestData(rows, headers);
        toast(`Loaded ${rows.length} rows from "${file.name}"`, 'success');
      } catch (err) {
        toast('CSV parse error: ' + err.message, 'error');
      }
    };
    reader.readAsText(file);
  }

  function loadSampleData() {
    const raw     = DataModule.generateSampleData();
    const headers = Object.keys(raw[0]);
    ingestData(raw, headers);
    toast('Sample data loaded: 3 campaigns × 90 days', 'success');
  }

  function ingestData(rawRows, headers) {
    // Auto-detect or use current colMap
    const processed = DataModule.processRows(rawRows, state.colMap);
    if (!processed.length) {
      toast('No valid rows found — check column mapping.', 'error');
      return;
    }
    state.rawRows   = processed;
    state.campaigns = DataModule.getCampaigns(processed);

    renderColMappingOptions(headers.length ? headers : Object.keys(rawRows[0]));
    populateCampaignSelects();
    renderDataSummary();
    renderDataPreview(rawRows.slice(0, 25), Object.keys(rawRows[0]));
  }

  function renderColMappingOptions(headers) {
    ['col-date','col-campaign','col-cost','col-purchase','col-revenue'].forEach(selId => {
      const sel = $(selId);
      if (!sel) return;
      const prev = sel.value;
      sel.innerHTML = headers.map(h => `<option value="${h}">${h}</option>`).join('');
      if (prev && headers.includes(prev)) sel.value = prev;
    });
    // Set defaults from colMap
    const cm = state.colMap;
    if ($('col-date'))     $('col-date').value     = cm.date;
    if ($('col-campaign')) $('col-campaign').value = cm.campaign;
    if ($('col-cost'))     $('col-cost').value     = cm.cost;
    if ($('col-purchase')) $('col-purchase').value = cm.purchase;
    if ($('col-revenue'))  $('col-revenue').value  = cm.revenue;
  }

  function applyColMapping() {
    state.colMap = {
      date:     $('col-date')?.value     || state.colMap.date,
      campaign: $('col-campaign')?.value || state.colMap.campaign,
      cost:     $('col-cost')?.value     || state.colMap.cost,
      purchase: $('col-purchase')?.value || state.colMap.purchase,
      revenue:  $('col-revenue')?.value  || state.colMap.revenue,
    };
    // Reprocess with new mapping
    if (state.rawRows.length) {
      toast('Column mapping updated. Reload data to apply.', 'info');
    }
  }

  function renderDataSummary() {
    const el = $('data-summary');
    if (!el) return;
    const rows = state.rawRows;
    if (!rows.length) { el.textContent = 'No data loaded.'; return; }

    const dates   = rows.map(r => r.date).sort();
    const nDays   = new Set(rows.map(r => r.date)).size;
    const summary = DataModule.summarise(rows);
    const roasMultiplier = (summary.avgROAS / 100).toFixed(2);

    el.innerHTML = `
      <div class="stat-grid">
        <div class="stat-card">
          <div class="stat-val" style="color:var(--purple);">${summary.avgROAS.toFixed(1)}% <small style="color:var(--purple);font-size:12px;">(${roasMultiplier}x)</small></div>
          <div class="stat-lbl">📊 Total ROAS (Rev/Cost)</div>
        </div>
        <div class="stat-card">
          <div class="stat-val">${fmt(summary.totalRevenue, 'usd')}</div>
          <div class="stat-lbl">💰 Total Revenue</div>
        </div>
        <div class="stat-card">
          <div class="stat-val">${fmt(summary.totalCost, 'usd')}</div>
          <div class="stat-lbl">💳 Total Cost</div>
        </div>
        <div class="stat-card">
          <div class="stat-val">${fmt(summary.totalPurchase, 'num')}</div>
          <div class="stat-lbl">🛒 Total Purchase</div>
        </div>
        <div class="stat-card">
          <div class="stat-val">${fmt(summary.avgCost, 'usd')}/day</div>
          <div class="stat-lbl">Avg Daily Cost</div>
        </div>
        <div class="stat-card">
          <div class="stat-val">${state.campaigns.length}</div>
          <div class="stat-lbl">Campaigns</div>
        </div>
        <div class="stat-card">
          <div class="stat-val">${nDays} days</div>
          <div class="stat-lbl">Duration (${dates[0].slice(5)} ~ ${dates[dates.length-1].slice(5)})</div>
        </div>
        <div class="stat-card">
          <div class="stat-val">${rows.length}</div>
          <div class="stat-lbl">Total Records</div>
        </div>
      </div>
    `;
  }

  function renderDataPreview(rows, headers) {
    const tbl = $('data-preview');
    if (!tbl) return;
    const h = headers.slice(0, 8);
    tbl.innerHTML = `
      <table class="preview-table">
        <thead><tr>${h.map(c => `<th>${c}</th>`).join('')}</tr></thead>
        <tbody>${rows.map(r => `<tr>${h.map(c => `<td>${r[c] ?? ''}</td>`).join('')}</tr>`).join('')}</tbody>
      </table>`;
  }

  /* ══════════════════════════════════════════════════════════════════
   * TAB 2: SIMULATION (다중 기간 스케줄 & 의사결정 판정 엔진)
   * ══════════════════════════════════════════════════════════════════ */

  function initSimTab() {
    $('btn-run-sim').addEventListener('click', runSimulation);
    $('sim-campaign')?.addEventListener('change', syncSimCampaignDefaults);

    $('sim-weeks').addEventListener('input', e => {
      $('sim-weeks-val').textContent = e.target.value;
    });

    // Mode selection (single vs multi)
    document.querySelectorAll('input[name="sim-mode"]').forEach(r => {
      r.addEventListener('change', () => {
        state.simMode = r.value;
        const singleP = $('sim-single-panel');
        const multiP  = $('sim-multi-panel');
        if (state.simMode === 'single') {
          if (singleP) singleP.style.display = 'block';
          if (multiP)  multiP.style.display  = 'none';
        } else {
          if (singleP) singleP.style.display = 'none';
          if (multiP)  multiP.style.display  = 'block';
          if (!state.simSchedules.length) {
            initDefaultSchedules();
          }
        }
      });
    });

    // Date inputs listener (single mode)
    $('sim-start-date')?.addEventListener('input', () => {
      updateSimPeriodBadge();
      setPresetActive('custom');
    });
    $('sim-end-date')?.addEventListener('input', () => {
      updateSimPeriodBadge();
      setPresetActive('custom');
    });

    // Preset buttons
    document.querySelectorAll('.btn-preset').forEach(btn => {
      btn.addEventListener('click', () => {
        applySimPeriodPreset(btn.dataset.preset);
      });
    });

    // Multi-period schedule add button
    $('btn-add-schedule')?.addEventListener('click', () => {
      addSimSchedule();
    });
  }

  function initDefaultSchedules() {
    const rows = getCampaignRows('sim-campaign');
    if (!rows.length) return;
    const summary = DataModule.summarise(rows);
    if (!summary) return;

    const baseCost = Math.round(summary.avgCost);
    const d1 = new Date(summary.dateFrom);
    const d2 = new Date(summary.dateTo);
    const mid = new Date((d1.getTime() + d2.getTime()) / 2);

    const s1 = summary.dateFrom;
    const e1 = mid.toISOString().slice(0, 10);
    const s2 = new Date(mid.getTime() + 86400000).toISOString().slice(0, 10);
    const e2 = summary.dateTo;

    state.simSchedules = [
      { id: 1, startDate: s1, endDate: e1, budget: Math.round(baseCost * 1.3), label: '구간 1: 프로모션 부스팅' },
      { id: 2, startDate: s2, endDate: e2, budget: Math.round(baseCost * 0.9), label: '구간 2: 상시 최적화' },
    ];
    renderSimScheduleList();
  }

  function addSimSchedule(startDate = '', endDate = '', budget = 0, label = '') {
    const rows = getCampaignRows('sim-campaign');
    const summary = rows.length ? DataModule.summarise(rows) : null;
    const defaultBud = summary ? Math.round(summary.avgCost * 1.2) : 1000;
    const sDate = startDate || (summary ? summary.dateFrom : '2026-07-01');
    const eDate = endDate   || (summary ? summary.dateTo   : '2026-07-15');

    const newId = Date.now();
    state.simSchedules.push({
      id: newId,
      startDate: sDate,
      endDate: eDate,
      budget: budget > 0 ? budget : defaultBud,
      label: label || `구간 #${state.simSchedules.length + 1}`,
    });
    renderSimScheduleList();
  }

  function removeSimSchedule(id) {
    state.simSchedules = state.simSchedules.filter(s => s.id !== id);
    renderSimScheduleList();
  }

  function renderSimScheduleList() {
    const el = $('sim-schedule-list');
    if (!el) return;
    if (!state.simSchedules.length) {
      el.innerHTML = '<div class="muted" style="font-size:12px;padding:8px 0;">등록된 구간이 없습니다. "+ 구간 추가"를 누르세요.</div>';
      return;
    }

    el.innerHTML = state.simSchedules.map((sc, idx) => `
      <div class="schedule-card">
        <div class="schedule-header">
          <span class="schedule-tag">${sc.label || `구간 #${idx + 1}`}</span>
          <button type="button" class="schedule-del-btn" onclick="App._removeSimSchedule(${sc.id})">✕</button>
        </div>
        <div class="schedule-dates">
          <input type="date" value="${sc.startDate}" onchange="App._updateSimSchedule(${sc.id}, 'startDate', this.value)" />
          <span>~</span>
          <input type="date" value="${sc.endDate}" onchange="App._updateSimSchedule(${sc.id}, 'endDate', this.value)" />
        </div>
        <div style="display:flex;align-items:center;gap:6px;margin-top:2px;">
          <span class="sub-label" style="margin-bottom:0;width:55px;">일예산:</span>
          <input type="number" value="${sc.budget}" min="1" step="10" style="padding:4px 8px;font-size:12px;"
                 onchange="App._updateSimSchedule(${sc.id}, 'budget', parseFloat(this.value))" />
          <span style="font-size:11px;color:var(--muted);">$</span>
        </div>
      </div>
    `).join('');
  }

  function updateSimSchedule(id, key, val) {
    const item = state.simSchedules.find(s => s.id === id);
    if (item) {
      item[key] = val;
    }
  }

  function setPresetActive(preset) {
    document.querySelectorAll('.btn-preset').forEach(b => {
      b.classList.toggle('active', b.dataset.preset === preset);
    });
  }

  function applySimPeriodPreset(preset) {
    setPresetActive(preset);
    const rows = getCampaignRows('sim-campaign');
    if (!rows.length) return;
    const summary = DataModule.summarise(rows);
    if (!summary) return;

    const startEl = $('sim-start-date');
    const endEl   = $('sim-end-date');
    if (!startEl || !endEl) return;

    endEl.value = summary.dateTo;

    if (preset === 'all') {
      startEl.value = summary.dateFrom;
    } else if (preset === '4w') {
      const d = new Date(summary.dateTo);
      d.setDate(d.getDate() - 28);
      const str = d.toISOString().slice(0, 10);
      startEl.value = str >= summary.dateFrom ? str : summary.dateFrom;
    } else if (preset === '2w') {
      const d = new Date(summary.dateTo);
      d.setDate(d.getDate() - 14);
      const str = d.toISOString().slice(0, 10);
      startEl.value = str >= summary.dateFrom ? str : summary.dateFrom;
    }
    updateSimPeriodBadge();
  }

  function runSimulation() {
    const rows = getCampaignRows('sim-campaign');
    if (!rows.length) { toast('No data. Load a dataset first.', 'error'); return; }

    const curBud = parseFloat($('sim-current-budget').value) || 0;
    const weeks  = parseInt($('sim-weeks').value) || 4;
    const s      = { ...state.settings, analysisWeeks: weeks };

    let simBud = 0;
    let dateRange = null;

    if (state.simMode === 'single') {
      simBud = parseFloat($('sim-new-budget').value);
      if (!curBud || !simBud || curBud <= 0 || simBud <= 0) {
        toast('현재 일예산과 변경 일예산을 올바르게 입력하세요.', 'error'); return;
      }
      const startDate = $('sim-start-date')?.value || '';
      const endDate   = $('sim-end-date')?.value || '';
      dateRange = (startDate && endDate) ? { startDate, endDate } : null;
    } else {
      // Multi-period schedule
      if (!state.simSchedules.length) {
        toast('최소 1개 이상의 변경 구간을 추가하세요.', 'error'); return;
      }
      simBud = state.simSchedules[0].budget;
      dateRange = { schedules: state.simSchedules };
    }

    $('sim-results').innerHTML = '<div class="loading">⏳ Running Monte Carlo simulation & confidence analysis…</div>';

    setTimeout(() => {
      try {
        const result = ModelModule.runSimulation(rows, s, curBud, simBud, dateRange);
        if (result.error) { toast(result.error, 'error'); $('sim-results').innerHTML = ''; return; }

        state.simResult = result;
        renderSimResults(result);
      } catch (err) {
        console.error(err);
        toast('Simulation execution error: ' + err.message, 'error');
        $('sim-results').innerHTML = `<div class="card error" style="color:var(--danger);padding:16px;">⚠️ 시뮬레이션 계산 중 오류가 발생했습니다: ${err.message}</div>`;
      }
    }, 30);
  }

  function renderSimResults(res) {
    const container = $('sim-results');
    const pt = res.periodTotal;
    const vi = res.verdictInfo;

    // 1. Executive Verdict Card
    const verdictHTML = `
      <div class="verdict-card ${vi.verdictClass}">
        <div class="verdict-header">
          <span class="verdict-icon">${vi.verdictIcon}</span>
          <span class="verdict-title">${vi.verdictTitle}</span>
        </div>
        <div class="verdict-reason">${vi.verdictReason}</div>

        <!-- 4 Key Confidence Metrics -->
        <div class="conf-grid">
          <div class="conf-card">
            <div class="conf-val" style="color:var(--success);">${vi.revenueWinRate.toFixed(1)}%</div>
            <div class="conf-lbl">본전 이상(흑자) 달성 확률</div>
            <div class="conf-sub">추가 매출 ≥ 추가 광고비 (10,000회)</div>
          </div>
          <div class="conf-card">
            <div class="conf-val" style="color:var(--accent);">${vi.purchaseWinRate.toFixed(1)}%</div>
            <div class="conf-lbl">구매수 증대 성공 확률</div>
            <div class="conf-sub">기존 대비 실적 개선 확률</div>
          </div>
          <div class="conf-card">
            <div class="conf-val" style="color:${vi.marginalROAS >= 150 ? 'var(--success)' : vi.marginalROAS >= 100 ? 'var(--warning)' : 'var(--danger)'};">
              ${vi.marginalROAS.toFixed(0)}%
            </div>
            <div class="conf-lbl">한계 ROAS (추가 효율)</div>
            <div class="conf-sub">추가 투입비 대비 추가 매출</div>
          </div>
          <div class="conf-card">
            <div class="conf-val" style="color:${vi.netContribution >= 0 ? 'var(--success)' : 'var(--danger)'};">
              ${vi.netContribution >= 0 ? '+' : ''}$${fmt(vi.netContribution, 'num')}
            </div>
            <div class="conf-lbl">순매출 기여액 (Net Lift)</div>
            <div class="conf-sub">추가 매출 - 추가 광고비</div>
          </div>
        </div>
      </div>`;

    // 2. Period Total Banner
    const isMulti = res.schedules && res.schedules.length > 0;
    const periodDesc = isMulti 
      ? `다중 스케줄 ${res.schedules.length}개 구간 적용 (${res.minDate} ~ ${res.maxDate})`
      : `${pt.startDate} ~ ${pt.endDate} (총 ${pt.days}일간)`;

    const actualNetProfit = pt.actual.revenue - pt.actual.cost;
    const simNetProfit = pt.revenue.sim.mean - pt.cost.sim;
    const netProfitDiffVsActual = simNetProfit - actualNetProfit;

    const periodBannerHTML = `
      <div class="period-total-banner">
        <div class="period-total-header">
          <div class="period-total-title">
            📅 지정 기간 누적 성과 요약 <small style="font-size:12px;color:var(--muted);font-weight:normal;">[ ${periodDesc} ]</small>
          </div>
          <div class="period-badge">과거 실제 평균 일예산 $${fmt(pt.actual.avgDailyCost,'num')}/day</div>
        </div>
        <div class="period-total-grid">
          <div class="pt-card">
            <div class="pt-lbl">총 광고 집행비 (Cost)</div>
            <div class="pt-val">$${fmt(pt.cost.sim, 'num')}</div>
            <div class="pt-sub">과거 실제: $${fmt(pt.actual.cost, 'num')} (${pt.cost.diff >= 0 ? '+' : ''}$${fmt(pt.cost.diff, 'num')})</div>
          </div>
          <div class="pt-card">
            <div class="pt-lbl">예상 총 매출 (Revenue)</div>
            <div class="pt-val" style="color:var(--success);">$${fmt(pt.revenue.sim.mean, 'usd')}</div>
            <div class="pt-sub">과거 실제: $${fmt(pt.actual.revenue, 'usd')} (${pt.revenue.diffVsActual >= 0 ? '+' : ''}$${fmt(pt.revenue.diffVsActual, 'usd')})</div>
          </div>
          <div class="pt-card">
            <div class="pt-lbl">예상 총 순이익 (Net Profit)</div>
            <div class="pt-val" style="color:${simNetProfit >= actualNetProfit ? 'var(--success)' : 'var(--danger)'};">$${fmt(simNetProfit, 'usd')}</div>
            <div class="pt-sub">과거 실제: $${fmt(actualNetProfit, 'usd')} (${netProfitDiffVsActual >= 0 ? '+' : ''}$${fmt(netProfitDiffVsActual, 'usd')})</div>
          </div>
          <div class="pt-card">
            <div class="pt-lbl">기간 전체 ROAS (Rev/Cost)</div>
            <div class="pt-val" style="color:var(--purple);">${pt.roas.sim.mean.toFixed(1)}% <small style="font-size:12px;">(${(pt.roas.sim.mean / 100).toFixed(2)}x)</small></div>
            <div class="pt-sub">과거 실제: ${pt.actual.roas.toFixed(1)}% (${(pt.actual.roas / 100).toFixed(2)}x)</div>
          </div>
        </div>
      </div>`;

    // 3. Daily KPI table
    const curNetMean = res.revenue.current.mean - res.currentBudget;
    const simNetMean = res.revenue.sim.mean - res.simBudget;

    const curNetP05  = res.revenue.current.p05 - res.currentBudget;
    const simNetP05  = res.revenue.sim.p05 - res.simBudget;

    const curNetP95  = res.revenue.current.p95 - res.currentBudget;
    const simNetP95  = res.revenue.sim.p95 - res.simBudget;

    const tableRows = [
      {
        kpi: 'Purchase (구매/전환수)',
        cur:  res.purchase.current,
        sim:  res.purchase.sim,
        type: 'num',
        isROAS: false,
      },
      {
        kpi: 'Revenue (총 매출액)',
        cur:  res.revenue.current,
        sim:  res.revenue.sim,
        type: 'usd',
        isROAS: false,
      },
      {
        kpi: 'Net Profit (일평균 순이익: Rev - Cost)',
        cur: { mean: curNetMean, p05: curNetP05, p95: curNetP95 },
        sim: { mean: simNetMean, p05: simNetP05, p95: simNetP95 },
        type: 'usd',
        isROAS: false,
      },
      {
        kpi: 'ROAS (광고수익률: Rev/Cost)',
        cur:  res.roas.current,
        sim:  res.roas.sim,
        type: 'pct',
        isROAS: true,
      },
    ];

    const tblHTML = `
      <div class="section-title">📊 일평균 성과 비교 (Daily Rate)</div>
      <table class="kpi-table">
        <thead>
          <tr>
            <th>KPI</th>
            <th>Current Baseline <small>$${fmt(res.currentBudget,'num')}/day</small></th>
            <th>Simulated Modified <small>$${fmt(res.simBudget,'num')}/day</small></th>
            <th>Change</th>
          </tr>
        </thead>
        <tbody>
          ${tableRows.map(r => {
            const cMean = r.cur.mean, sMean = r.sim.mean;
            const cValStr = r.isROAS 
              ? `${cMean.toFixed(1)}% <small class="muted">(${(cMean/100).toFixed(2)}x)</small>`
              : fmt(cMean, r.type);
            const sValStr = r.isROAS
              ? `${sMean.toFixed(1)}% <small class="muted">(${(sMean/100).toFixed(2)}x)</small>`
              : fmt(sMean, r.type);
            const cSubStr = r.isROAS
              ? `P05: ${r.cur.p05.toFixed(0)}% · P95: ${r.cur.p95.toFixed(0)}%`
              : `P05: ${fmt(r.cur.p05,r.type)} · P95: ${fmt(r.cur.p95,r.type)}`;
            const sSubStr = r.isROAS
              ? `P05: ${r.sim.p05.toFixed(0)}% · P95: ${r.sim.p95.toFixed(0)}%`
              : `P05: ${fmt(r.sim.p05,r.type)} · P95: ${fmt(r.sim.p95,r.type)}`;

            return `<tr>
              <td><strong>${r.kpi}</strong></td>
              <td>
                <div class="kpi-main">${cValStr}</div>
                <div class="kpi-sub">${cSubStr}</div>
              </td>
              <td>
                <div class="kpi-main">${sValStr}</div>
                <div class="kpi-sub">${sSubStr}</div>
              </td>
              <td>${deltaBadge(cMean, sMean, r.type)}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;

    // Model info
    const m = res.models;
    const infoHTML = `
      <div class="model-info">
        <span>📅 Data window: ${m.dateRange.from} → ${m.dateRange.to} (${m.dataPoints} days)</span>
        <span>β<sub>purchase</sub> = ${m.purchase.beta.toFixed(3)}</span>
        <span>β<sub>revenue</sub>  = ${m.revenue.beta.toFixed(3)}</span>
        <span>R²<sub>purchase</sub> = ${(m.purchase.r2*100).toFixed(1)}%</span>
        <span>R²<sub>revenue</sub>  = ${(m.revenue.r2*100).toFixed(1)}%</span>
      </div>`;

    // Timeline view HTML
    const timelineHTML = `
      <div class="section-title mt" style="justify-content:space-between;">
        <span>📈 시계열 타임라인 비교 (예산 변경 구간 하이라이트)</span>
        <div class="timeline-toggle-row">
          <button type="button" class="timeline-btn ${state.timelineMetric === 'revenue' ? 'active' : ''}" data-metric="revenue">Revenue</button>
          <button type="button" class="timeline-btn ${state.timelineMetric === 'roas' ? 'active' : ''}" data-metric="roas">ROAS</button>
          <button type="button" class="timeline-btn ${state.timelineMetric === 'cost' ? 'active' : ''}" data-metric="cost">Cost</button>
        </div>
      </div>
      <div class="chart-wrap tall"><canvas id="sim-timeline-chart"></canvas></div>`;

    container.innerHTML = verdictHTML + periodBannerHTML + tblHTML + infoHTML + timelineHTML + `
      <div class="section-title mt">🎲 몬테카를로 확률 분포 (${state.settings.simRuns.toLocaleString()} runs)</div>
      <div class="charts-row">
        <div class="chart-wrap"><canvas id="hist-purchase"></canvas></div>
        <div class="chart-wrap"><canvas id="hist-revenue"></canvas></div>
        <div class="chart-wrap"><canvas id="hist-roas"></canvas></div>
      </div>`;

    // Attach timeline toggle events
    container.querySelectorAll('.timeline-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        container.querySelectorAll('.timeline-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.timelineMetric = btn.dataset.metric;
        drawTimeline();
      });
    });

    function drawTimeline() {
      const metric = state.timelineMetric || 'revenue';
      const titles = {
        revenue: 'Timeline: Daily Revenue (Modified Periods Highlighted)',
        roas:    'Timeline: Daily ROAS % (Modified Periods Highlighted)',
        cost:    'Timeline: Daily Cost (Modified Periods Highlighted)',
      };
      const fmts = {
        revenue: v => ChartsModule.fmt(v, 'usd'),
        roas:    v => v.toFixed(0) + '%',
        cost:    v => '$' + ChartsModule.fmt(v, 'num'),
      };

      draw(ChartsModule.drawTimelineChart, $('sim-timeline-chart'), {
        timeline: res.timeline,
        metric,
        title: titles[metric],
        yFmt: fmts[metric],
      });
    }

    requestAnimationFrame(() => {
      drawTimeline();

      const mkMarkers = (stats) => [
        { value: stats.p05,    label: `P05`, color: '#ef4444' },
        { value: stats.median, label: `Median`, color: '#22c55e' },
        { value: stats.mean,   label: `Mean`, color: '#f97316' },
        { value: stats.p95,    label: `P95`, color: '#eab308' },
      ];

      const simROASSamples = res.revenue.sim.samples.map(v => v / res.simBudget * 100);
      simROASSamples.sort((a,b) => a - b);
      const roasSimStats = {
        mean:   simROASSamples.reduce((s,v) => s + v, 0) / simROASSamples.length,
        median: simROASSamples[simROASSamples.length >> 1],
        p05:    simROASSamples[Math.floor(simROASSamples.length * 0.05)],
        p95:    simROASSamples[Math.floor(simROASSamples.length * 0.95)],
        samples: simROASSamples,
      };

      draw(ChartsModule.drawHistogram, $('hist-purchase'), {
        values:  res.purchase.sim.samples,
        markers: mkMarkers(res.purchase.sim),
        title:   'Purchase Distribution (Simulated Budget)',
        xLabel:  'Purchases',
        color:   '#3b82f6',
      });
      draw(ChartsModule.drawHistogram, $('hist-revenue'), {
        values:  res.revenue.sim.samples,
        markers: mkMarkers(res.revenue.sim),
        title:   'Revenue Distribution (Simulated Budget)',
        xLabel:  'Revenue (USD)',
        color:   '#22c55e',
      });
      draw(ChartsModule.drawHistogram, $('hist-roas'), {
        values:  roasSimStats.samples,
        markers: mkMarkers(roasSimStats),
        title:   'ROAS Distribution (Simulated Budget)',
        xLabel:  'ROAS (%)',
        color:   '#a855f7',
      });
    });
  }

  /* ══════════════════════════════════════════════════════════════════
   * TAB 2-B: STRATEGY LAB (규칙 기반 동적 전략 실험실)
   * ══════════════════════════════════════════════════════════════════ */

  function initStrategyTab() {
    $('btn-run-strategy')?.addEventListener('click', runStrategySimulation);

    // Presets
    document.querySelectorAll('.btn-strat-preset').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.btn-strat-preset').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        applyStrategyPreset(btn.dataset.preset);
      });
    });

    $('strat-has-neg')?.addEventListener('change', e => {
      const g = $('strat-neg-group');
      if (g) g.style.display = e.target.checked ? 'grid' : 'none';
    });
  }

  function applyStrategyPreset(preset) {
    if (preset === 'momentum') {
      $('strat-metric').value = 'purchase';
      $('strat-threshold').value = '30';
      $('strat-action-val').value = '30';
      $('strat-has-neg').checked = true;
      $('strat-neg-threshold').value = '-20';
      $('strat-neg-action-val').value = '-10';
    } else if (preset === 'roas_guard') {
      $('strat-metric').value = 'roas';
      $('strat-threshold').value = '15';
      $('strat-action-val').value = '15';
      $('strat-has-neg').checked = true;
      $('strat-neg-threshold').value = '-15';
      $('strat-neg-action-val').value = '-20';
    } else if (preset === 'revenue_scale') {
      $('strat-metric').value = 'revenue';
      $('strat-threshold').value = '20';
      $('strat-action-val').value = '20';
      $('strat-has-neg').checked = true;
      $('strat-neg-threshold').value = '-15';
      $('strat-neg-action-val').value = '-15';
    }
  }

  function runStrategySimulation() {
    const rows = getCampaignRows('strat-campaign');
    if (!rows.length) { toast('데이터가 없습니다. 먼저 데이터를 로드하세요.', 'error'); return; }

    const config = {
      metric:          $('strat-metric').value,
      threshold:       parseFloat($('strat-threshold').value) || 30,
      actionValue:     parseFloat($('strat-action-val').value) || 30,
      hasNegativeRule: $('strat-has-neg').checked,
      negThreshold:    parseFloat($('strat-neg-threshold').value) || -20,
      negActionValue:  parseFloat($('strat-neg-action-val').value) || -10,
      minBudget:       parseFloat($('strat-min-budget').value) || 50,
      maxBudget:       parseFloat($('strat-max-budget').value) || 5000,
    };

    $('strat-results').innerHTML = '<div class="loading">⏳ 과거 시계열 롤링 전략 시뮬레이션 계산 중…</div>';

    setTimeout(() => {
      const result = ModelModule.runStrategySimulation(rows, state.settings, config);
      if (result.error) { toast(result.error, 'error'); $('strat-results').innerHTML = ''; return; }
      state.stratResult = result;
      renderStrategyResults(result);
    }, 30);
  }

  function renderStrategyResults(res) {
    const container = $('strat-results');
    const { summary, weeklyLogs, timeline } = res;
    const { actual, strategy, diff } = summary;

    const verdictCardHTML = `
      <div class="verdict-card ${summary.verdictClass}">
        <div class="verdict-header">
          <span class="verdict-icon">🧠</span>
          <span class="verdict-title">${summary.verdictTitle}</span>
        </div>
        <div class="verdict-reason">${summary.verdictDesc}</div>

        <div class="strat-summary-grid">
          <div class="pt-card">
            <div class="pt-lbl">총 광고 집행비</div>
            <div class="pt-val">$${fmt(strategy.cost, 'num')}</div>
            <div class="pt-sub">실제: $${fmt(actual.cost, 'num')} (${diff.costDiff >= 0 ? '+' : ''}$${fmt(diff.costDiff, 'num')})</div>
          </div>
          <div class="pt-card">
            <div class="pt-lbl">총 창출 매출액</div>
            <div class="pt-val" style="color:var(--success);">$${fmt(strategy.revenue, 'usd')}</div>
            <div class="pt-sub">실제: $${fmt(actual.revenue, 'usd')} (${diff.revDiff >= 0 ? '+' : ''}${diff.revLiftPct.toFixed(1)}%)</div>
          </div>
          <div class="pt-card">
            <div class="pt-lbl">종합 ROAS (Rev/Cost)</div>
            <div class="pt-val" style="color:var(--purple);">${strategy.roas.toFixed(1)}% <small style="font-size:12px;">(${(strategy.roas/100).toFixed(2)}x)</small></div>
            <div class="pt-sub">실제: ${actual.roas.toFixed(1)}% (${diff.roasLiftP >= 0 ? '+' : ''}${diff.roasLiftP.toFixed(1)}%p)</div>
          </div>
          <div class="pt-card">
            <div class="pt-lbl">순이익 기여액 (Net Impact)</div>
            <div class="pt-val" style="color:${diff.netProfitContribution >= 0 ? 'var(--success)' : 'var(--danger)'};">
              ${diff.netProfitContribution >= 0 ? '+' : ''}$${fmt(diff.netProfitContribution, 'num')}
            </div>
            <div class="pt-sub">추가 매출 - 추가 비용</div>
          </div>
        </div>
      </div>`;

    // Strategy Timeline Chart
    const chartHTML = `
      <div class="section-title mt">📈 실제 실적 vs 전략 룰 적용 실적 시계열 비교</div>
      <div class="chart-wrap tall"><canvas id="strat-timeline-chart"></canvas></div>`;

    // Weekly Action Logs Table
    const logsHTML = `
      <div class="section-title mt">📋 주차별 룰 발동 및 예산 변경 히스토리 (${weeklyLogs.length}주간)</div>
      <div class="table-scroll">
        <table class="weekly-log-table">
          <thead>
            <tr>
              <th>주차</th>
              <th>평가 기간</th>
              <th>전주 실적 증감</th>
              <th>룰 발동 및 액션</th>
              <th>적용 일예산</th>
              <th>주간 전략 매출</th>
              <th>주간 전략 ROAS</th>
            </tr>
          </thead>
          <tbody>
            ${weeklyLogs.map(log => {
              const badgeCls = log.ruleApplied === 'SCALE_UP' ? 'badge-scaleup' : log.ruleApplied === 'SCALE_DOWN' ? 'badge-scaledown' : 'badge-hold';
              return `<tr>
                <td><strong>Week ${log.weekIdx}</strong></td>
                <td>${log.startDate.slice(5)} ~ ${log.endDate.slice(5)}</td>
                <td>${log.weekIdx > 1 ? `${log.wowGrowth >= 0 ? '+' : ''}${log.wowGrowth.toFixed(1)}%` : '—'}</td>
                <td><span class="${badgeCls}">${log.ruleDesc}</span></td>
                <td><strong>$${Math.round(log.strategyDailyBudget).toLocaleString()}</strong>/day</td>
                <td style="color:var(--success);">$${fmt(log.strategyRevenue, 'usd')}</td>
                <td style="color:var(--purple);">${log.strategyROAS.toFixed(1)}%</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;

    container.innerHTML = verdictCardHTML + chartHTML + logsHTML;

    requestAnimationFrame(() => {
      draw(ChartsModule.drawStrategyTimelineChart, $('strat-timeline-chart'), {
        timeline,
        metric: 'revenue',
        title: 'Strategy Lab: Actual Revenue vs Dynamic Rule Strategy Revenue',
        yFmt: v => ChartsModule.fmt(v, 'usd'),
      });
    });
  }

  /* ══════════════════════════════════════════════════════════════════
   * TAB 3: BUDGET WHAT-IF
   * ══════════════════════════════════════════════════════════════════ */

  function initWhatifTab() {
    $('btn-add-budget').addEventListener('click', addWhatifBudget);
    $('btn-gen-range').addEventListener('click', generateBudgetRange);
    $('btn-run-whatif').addEventListener('click', runWhatIf);
    // Allow Enter key in budget input
    $('whatif-new-budget').addEventListener('keydown', e => {
      if (e.key === 'Enter') addWhatifBudget();
    });
  }

  function addWhatifBudget() {
    const v = parseFloat($('whatif-new-budget').value);
    if (!v || v <= 0) { toast('Enter a positive budget value.', 'error'); return; }
    if (state.whatifBudgets.includes(v)) { toast('Already in list.', 'info'); return; }
    state.whatifBudgets.push(v);
    state.whatifBudgets.sort((a,b) => a - b);
    $('whatif-new-budget').value = '';
    renderWhatifBudgetList();
  }

  function generateBudgetRange() {
    const minB  = parseFloat($('range-min').value);
    const maxB  = parseFloat($('range-max').value);
    const cnt   = parseInt($('range-count').value) || 8;
    if (!minB || !maxB || minB <= 0 || maxB <= minB) {
      toast('Enter valid min/max for range generator.', 'error'); return;
    }
    const step = (maxB - minB) / (cnt - 1);
    state.whatifBudgets = Array.from({ length: cnt }, (_, i) =>
      parseFloat((minB + step * i).toFixed(2))
    );
    renderWhatifBudgetList();
  }

  function renderWhatifBudgetList() {
    const el = $('whatif-budget-list');
    if (!el) return;
    el.innerHTML = state.whatifBudgets.map((b, i) => `
      <div class="budget-tag">
        <span>$${fmt(b,'num')}</span>
        <button class="tag-remove" onclick="App._removeWhatifBudget(${i})">✕</button>
      </div>`).join('');
  }

  function removeWhatifBudget(idx) {
    state.whatifBudgets.splice(idx, 1);
    renderWhatifBudgetList();
  }

  function runWhatIf() {
    const rows = getCampaignRows('whatif-campaign');
    if (!rows.length) { toast('No data loaded.', 'error'); return; }
    if (!state.whatifBudgets.length) { toast('Add at least one budget.', 'error'); return; }

    const weeks = parseInt($('whatif-weeks').value) || 4;
    const s     = { ...state.settings, analysisWeeks: weeks };

    $('whatif-results').innerHTML = '<div class="loading">⏳ Running What-if…</div>';

    setTimeout(() => {
      const result = ModelModule.runWhatIf(rows, s, state.whatifBudgets);
      if (result.error) { toast(result.error, 'error'); return; }
      state.whatifResult = result;
      renderWhatifResults(result);
    }, 30);
  }

  function renderWhatifResults(res) {
    const { results } = res;
    const budgets = results.map(r => r.budget);

    // Summary table
    const tblHTML = `
      <div class="section-title">📋 Summary Table</div>
      <div class="table-scroll">
      <table class="kpi-table">
        <thead>
          <tr>
            <th>Budget/day</th>
            <th>Purchase (Mean)</th>
            <th>Purchase P05–P95</th>
            <th>Revenue (Mean)</th>
            <th>Revenue P05–P95</th>
            <th>ROAS (Mean: Rev/Cost)</th>
          </tr>
        </thead>
        <tbody>
          ${results.map(r => `<tr>
            <td><strong>$${fmt(r.budget,'num')}</strong></td>
            <td>${fmt(r.purchase.mean,'num')}</td>
            <td class="muted-cell">${fmt(r.purchase.p05)} – ${fmt(r.purchase.p95)}</td>
            <td>${fmt(r.revenue.mean,'usd')}</td>
            <td class="muted-cell">${fmt(r.revenue.p05,'usd')} – ${fmt(r.revenue.p95,'usd')}</td>
            <td><strong>${fmt(r.roas.mean,'pct')}</strong> <small class="muted">(${(r.roas.mean/100).toFixed(2)}x)</small></td>
          </tr>`).join('')}
        </tbody>
      </table></div>`;

    $('whatif-results').innerHTML = tblHTML + `
      <div class="section-title mt">📈 KPI vs Budget Curves</div>
      <div class="charts-col">
        <div class="chart-wrap tall"><canvas id="wi-purchase-chart"></canvas></div>
        <div class="chart-wrap tall"><canvas id="wi-revenue-chart"></canvas></div>
        <div class="chart-wrap tall"><canvas id="wi-roas-chart"></canvas></div>
      </div>`;

    requestAnimationFrame(() => {
      const commonOpts = {
        xType: 'value',
        xFmt: v => `$${ChartsModule.fmt(v,'num')}`,
        xLabel: 'Daily Budget (USD)',
      };

      draw(ChartsModule.drawLineChart, $('wi-purchase-chart'), {
        ...commonOpts,
        title:   'Purchase vs Budget',
        yLabel:  'Purchases',
        datasets: [{
          label:    'Mean',
          xs:       budgets,
          data:     results.map(r => r.purchase.mean),
          bandLow:  results.map(r => r.purchase.p05),
          bandHigh: results.map(r => r.purchase.p95),
          color:    '#3b82f6',
          noDots:   false,
        }],
      });

      draw(ChartsModule.drawLineChart, $('wi-revenue-chart'), {
        ...commonOpts,
        title:   'Revenue vs Budget',
        yLabel:  'Revenue (USD)',
        yFmt:    v => ChartsModule.fmt(v,'usd'),
        datasets: [{
          label:    'Mean',
          xs:       budgets,
          data:     results.map(r => r.revenue.mean),
          bandLow:  results.map(r => r.revenue.p05),
          bandHigh: results.map(r => r.revenue.p95),
          color:    '#22c55e',
          noDots:   false,
        }],
      });

      draw(ChartsModule.drawLineChart, $('wi-roas-chart'), {
        ...commonOpts,
        title:   'ROAS vs Budget',
        yLabel:  'ROAS (%)',
        yFmt:    v => v.toFixed(0) + '%',
        datasets: [{
          label:    'Mean',
          xs:       budgets,
          data:     results.map(r => r.roas.mean),
          bandLow:  results.map(r => r.roas.p05),
          bandHigh: results.map(r => r.roas.p95),
          color:    '#a855f7',
          noDots:   false,
        }],
      });
    });
  }

  /* ══════════════════════════════════════════════════════════════════
   * TAB 4: OPTIMIZATION
   * ══════════════════════════════════════════════════════════════════ */

  function initOptTab() {
    $('btn-run-opt').addEventListener('click', runOptimization);
  }

  function runOptimization() {
    const rows = getCampaignRows('opt-campaign');
    if (!rows.length) { toast('No data loaded.', 'error'); return; }

    const objective = (document.querySelector('input[name="opt-obj"]:checked') || {}).value || 'revenue';
    const minB      = parseFloat($('opt-min-budget').value);
    const maxB      = parseFloat($('opt-max-budget').value);
    const weeks     = parseInt($('opt-weeks').value) || 4;

    if (!minB || !maxB || minB <= 0 || maxB <= minB) {
      toast('Enter valid budget range (min < max).', 'error'); return;
    }

    $('opt-results').innerHTML = '<div class="loading">⏳ Running optimization…</div>';

    setTimeout(() => {
      const s   = { ...state.settings, analysisWeeks: weeks };
      const result = ModelModule.optimizeBudget(rows, s, objective, minB, maxB);
      if (result.error) { toast(result.error, 'error'); return; }
      state.optResult = result;
      renderOptResults(result);
    }, 30);
  }

  function renderOptResults(res) {
    const { optimal, curve, objective } = res;
    const objLabel = { roas: 'ROAS', purchase: 'Purchase', revenue: 'Revenue' }[objective];

    const cardHTML = `
      <div class="opt-card">
        <div class="opt-header">🏆 Optimal Budget — Maximize ${objLabel}</div>
        <div class="opt-kpis">
          <div class="opt-kpi">
            <div class="opt-kpi-val">$${optimal.budget.toFixed(0)}/day</div>
            <div class="opt-kpi-lbl">Recommended Daily Budget</div>
          </div>
          <div class="opt-kpi">
            <div class="opt-kpi-val">${fmt(optimal.purchase.mean,'num')}</div>
            <div class="opt-kpi-lbl">Expected Purchase</div>
            <div class="opt-kpi-range">P05 ${fmt(optimal.purchase.p05)} – P95 ${fmt(optimal.purchase.p95)}</div>
          </div>
          <div class="opt-kpi">
            <div class="opt-kpi-val">${fmt(optimal.revenue.mean,'usd')}</div>
            <div class="opt-kpi-lbl">Expected Revenue</div>
            <div class="opt-kpi-range">P05 ${fmt(optimal.revenue.p05,'usd')} – P95 ${fmt(optimal.revenue.p95,'usd')}</div>
          </div>
          <div class="opt-kpi">
            <div class="opt-kpi-val">${fmt(optimal.roas.mean,'pct')} <small style="font-size:12px;">(${(optimal.roas.mean/100).toFixed(2)}x)</small></div>
            <div class="opt-kpi-lbl">Expected ROAS (Rev/Cost)</div>
            <div class="opt-kpi-range">P05 ${fmt(optimal.roas.p05,'pct')} – P95 ${fmt(optimal.roas.p95,'pct')}</div>
          </div>
        </div>
        <div class="opt-note">
          ℹ️ <em>ROAS decreases with budget due to diminishing returns (β &lt; 1). 
          For "Maximize ROAS", the optimal is at the lower end of the range.</em>
        </div>
      </div>`;

    $('opt-results').innerHTML = cardHTML + `
      <div class="section-title mt">📈 Efficiency Curves</div>
      <div class="charts-row">
        <div class="chart-wrap"><canvas id="opt-roas-chart"></canvas></div>
        <div class="chart-wrap"><canvas id="opt-rev-chart"></canvas></div>
        <div class="chart-wrap"><canvas id="opt-purch-chart"></canvas></div>
      </div>`;

    requestAnimationFrame(() => {
      const xFmt = v => `$${ChartsModule.fmt(v,'num')}`;

      draw(ChartsModule.drawOptimizationChart, $('opt-roas-chart'), {
        curve, optimalBudget: optimal.budget,
        kpi: 'roas', objective,
        title: 'ROAS vs Budget',
        yFmt: v => v.toFixed(0) + '%',
        xFmt,
      });
      draw(ChartsModule.drawOptimizationChart, $('opt-rev-chart'), {
        curve, optimalBudget: optimal.budget,
        kpi: 'revenue', objective,
        title: 'Revenue vs Budget',
        yFmt: v => ChartsModule.fmt(v,'usd'),
        xFmt,
      });
      draw(ChartsModule.drawOptimizationChart, $('opt-purch-chart'), {
        curve, optimalBudget: optimal.budget,
        kpi: 'purchase', objective,
        title: 'Purchase vs Budget',
        xFmt,
      });
    });
  }

  /* ══════════════════════════════════════════════════════════════════
   * TAB 5: BACKTEST
   * ══════════════════════════════════════════════════════════════════ */

  function initBacktestTab() {
    $('btn-run-backtest').addEventListener('click', runBacktest);
    $('bt-train-ratio').addEventListener('input', e => {
      $('bt-train-ratio-val').textContent = `${Math.round(e.target.value * 100)}%`;
    });
  }

  function runBacktest() {
    const rows = getCampaignRows('bt-campaign');
    if (!rows.length) { toast('No data loaded.', 'error'); return; }

    const trainRatio = parseFloat($('bt-train-ratio').value) || 0.70;
    $('bt-results').innerHTML = '<div class="loading">⏳ Running backtest…</div>';

    setTimeout(() => {
      const result = ModelModule.runBacktest(rows, state.settings, trainRatio);
      if (result.error) { toast(result.error, 'error'); $('bt-results').innerHTML = ''; return; }
      state.backtestResult = result;
      renderBacktestResults(result);
    }, 30);
  }

  function renderBacktestResults(res) {
    const { trainPeriod, testPeriod, purchaseModel, revenueModel, metrics } = res;

    const metricsHTML = `
      <div class="section-title">🔢 Model Parameters & Metrics</div>
      <div class="bt-grid">
        <div class="bt-info-card">
          <div class="bt-info-title">Train Period</div>
          <div>${trainPeriod.from} → ${trainPeriod.to}</div>
          <div class="muted">${trainPeriod.n} days</div>
        </div>
        <div class="bt-info-card">
          <div class="bt-info-title">Test Period</div>
          <div>${testPeriod.from} → ${testPeriod.to}</div>
          <div class="muted">${testPeriod.n} days</div>
        </div>
        <div class="bt-info-card">
          <div class="bt-info-title">Purchase Model</div>
          <div>α = ${purchaseModel.alpha.toFixed(3)}</div>
          <div>β = ${purchaseModel.beta.toFixed(3)}</div>
          <div>R² = ${(purchaseModel.r2*100).toFixed(1)}%</div>
        </div>
        <div class="bt-info-card">
          <div class="bt-info-title">Revenue Model</div>
          <div>α = ${revenueModel.alpha.toFixed(3)}</div>
          <div>β = ${revenueModel.beta.toFixed(3)}</div>
          <div>R² = ${(revenueModel.r2*100).toFixed(1)}%</div>
        </div>
      </div>
      <table class="kpi-table mt">
        <thead><tr><th>KPI</th><th>MAPE (Test)</th><th>RMSE (Test)</th></tr></thead>
        <tbody>
          <tr>
            <td>Purchase</td>
            <td class="${metrics.purchaseMAPE < 20 ? 'good' : metrics.purchaseMAPE < 35 ? 'warn' : 'bad'}">${metrics.purchaseMAPE.toFixed(1)}%</td>
            <td>${metrics.purchaseRMSE.toFixed(1)}</td>
          </tr>
          <tr>
            <td>Revenue (USD)</td>
            <td class="${metrics.revenueMAPE < 20 ? 'good' : metrics.revenueMAPE < 35 ? 'warn' : 'bad'}">${metrics.revenueMAPE.toFixed(1)}%</td>
            <td>$${metrics.revenueRMSE.toFixed(0)}</td>
          </tr>
          <tr>
            <td><strong>ROAS (%)</strong></td>
            <td class="${metrics.roasMAPE < 20 ? 'good' : metrics.roasMAPE < 35 ? 'warn' : 'bad'}">${metrics.roasMAPE.toFixed(1)}%</td>
            <td>${metrics.roasRMSE.toFixed(1)}%</td>
          </tr>
        </tbody>
      </table>`;

    $('bt-results').innerHTML = metricsHTML + `
      <div class="section-title mt">📈 Actual vs Predicted</div>
      <div class="charts-col">
        <div class="chart-wrap tall"><canvas id="bt-purchase-chart"></canvas></div>
        <div class="chart-wrap tall"><canvas id="bt-revenue-chart"></canvas></div>
      </div>`;

    requestAnimationFrame(() => {
      draw(ChartsModule.drawBacktestChart, $('bt-purchase-chart'), {
        trainResults: res.trainResults,
        testResults:  res.testResults,
        kpi: 'purchase',
        title: 'Purchase: Actual vs Predicted',
      });
      draw(ChartsModule.drawBacktestChart, $('bt-revenue-chart'), {
        trainResults: res.trainResults,
        testResults:  res.testResults,
        kpi: 'revenue',
        title: 'Revenue: Actual vs Predicted',
        yFmt: v => ChartsModule.fmt(v,'usd'),
      });
    });
  }

  /* ══════════════════════════════════════════════════════════════════
   * TAB 6: SETTINGS
   * ══════════════════════════════════════════════════════════════════ */

  function initSettingsTab() {
    $('btn-apply-settings').addEventListener('click', applySettings);
    // Populate current values
    $('set-lambda').value   = state.settings.lambda;
    $('set-simruns').value  = state.settings.simRuns;
    $('set-weeks').value    = state.settings.analysisWeeks;
    $('set-purchase-col').value = state.colMap.purchase;
    $('set-revenue-col').value  = state.colMap.revenue;
  }

  function applySettings() {
    const lambda = parseFloat($('set-lambda').value);
    const runs   = parseInt($('set-simruns').value);
    const weeks  = parseInt($('set-weeks').value);

    if (lambda <= 0 || lambda > 1)    { toast('λ must be between 0 and 1.', 'error'); return; }
    if (runs < 500 || runs > 100000)  { toast('Simulation runs must be 500–100,000.', 'error'); return; }
    if (weeks < 1 || weeks > 52)      { toast('Analysis weeks must be 1–52.', 'error'); return; }

    state.settings.lambda        = lambda;
    state.settings.simRuns       = runs;
    state.settings.analysisWeeks = weeks;

    // KPI column overrides
    const newPurchase = $('set-purchase-col').value.trim();
    const newRevenue  = $('set-revenue-col').value.trim();
    if (newPurchase) state.colMap.purchase = newPurchase;
    if (newRevenue)  state.colMap.revenue  = newRevenue;

    toast('Settings applied successfully.', 'success');
  }

  /* ══════════════════════════════════════════════════════════════════
   * INIT
   * ══════════════════════════════════════════════════════════════════ */

  function init() {
    initTabs();
    initDataTab();
    initSimTab();
    initStrategyTab();
    initWhatifTab();
    initOptTab();
    initBacktestTab();
    initSettingsTab();

    // Window resize → redraw all cached charts
    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        document.querySelectorAll('canvas').forEach(c => {
          if (c._drawFn && c._drawConfig) c._drawFn(c, c._drawConfig);
        });
      }, 150);
    });

    console.log('Ad Budget Simulator initialised.');
  }

  /* Public API for inline onclick */
  return {
    init,
    _removeWhatifBudget: removeWhatifBudget,
    _removeSimSchedule: removeSimSchedule,
    _updateSimSchedule: updateSimSchedule,
  };

})();

document.addEventListener('DOMContentLoaded', App.init);
