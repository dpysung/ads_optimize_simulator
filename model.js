/**
 * model.js — Statistical modeling engine
 *
 * Models:
 *   1. Weighted log-log regression  (diminishing returns)
 *   2. Monte Carlo simulation       (uncertainty quantification)
 *   3. Budget What-if analysis      (multi-budget comparison)
 *   4. Budget Optimization          (grid search)
 *   5. Temporal Backtest            (train-on-first, test-on-last)
 */

const ModelModule = (() => {

  /* ══════════════════════════════════════════════════════════════════
   * 1. PRIMITIVES
   * ══════════════════════════════════════════════════════════════════ */

  /** Box–Muller transform → standard normal sample */
  function randn() {
    let u1, u2;
    do { u1 = Math.random(); } while (u1 === 0);
    u2 = Math.random();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  /**
   * Exponential time-decay weights.
   * `rows` must be sorted ascending by date.
   * w_i = exp(−λ · (N−1−i))  → newest row gets w = 1.
   */
  function computeWeights(n, lambda) {
    return Array.from({ length: n }, (_, i) => Math.exp(-lambda * (n - 1 - i)));
  }

  /**
   * Weighted OLS in log-log space:
   *   log(y) = α + β·log(x)
   *
   * @returns {Object|null} { alpha, beta, sigma, r2 } or null if data insufficient
   */
  function fitLogLog(xs, ys, weights) {
    const n = xs.length;
    if (n < 5) return null;

    const EPSILON = 1e-4; // Safety threshold against log(0) -> -Infinity
    const lx = xs.map(x => Math.log(Math.max(x, EPSILON)));
    const ly = ys.map(y => Math.log(Math.max(y, EPSILON)));

    let sumW = 0, sumWX = 0, sumWY = 0;
    for (let i = 0; i < n; i++) {
      sumW  += weights[i];
      sumWX += weights[i] * lx[i];
      sumWY += weights[i] * ly[i];
    }
    const mx = sumWX / sumW;
    const my = sumWY / sumW;

    let covXY = 0, varX = 0, sst = 0;
    for (let i = 0; i < n; i++) {
      const dx = lx[i] - mx;
      const dy = ly[i] - my;
      covXY += weights[i] * dx * dy;
      varX  += weights[i] * dx * dx;
      sst   += weights[i] * dy * dy;
    }

    if (varX < 1e-12) return null; // no cost variation → can't fit

    const beta  = covXY / varX;
    const alpha = my - beta * mx;

    // Weighted residual standard deviation in log space
    let sse = 0;
    for (let i = 0; i < n; i++) {
      const res = ly[i] - (alpha + beta * lx[i]);
      sse += weights[i] * res * res;
    }
    const sigma = Math.sqrt(sse / Math.max(n - 2, 1));
    const r2    = sst > 0 ? Math.max(0, 1 - sse / sst) : 0;

    return { alpha, beta, sigma, r2 };
  }

  /**
   * Point estimate from log-log model with Log-Normal mean bias correction (exp(sigma^2 / 2)).
   * If useMean is true (default), returns expected arithmetic mean E[Y].
   * If useMean is false, returns geometric median exp(alpha + beta * log(x)).
   */
  function predict(model, budget, useMean = true) {
    const EPSILON = 1e-4;
    const safeBudget = Math.max(budget, EPSILON);
    const logMu = model.alpha + model.beta * Math.log(safeBudget);
    const smearingFactor = useMean ? Math.exp(0.5 * model.sigma * model.sigma) : 1;
    return Math.exp(logMu) * smearingFactor;
  }

  /* ══════════════════════════════════════════════════════════════════
   * 2. MODEL BUILDING
   * ══════════════════════════════════════════════════════════════════ */

  /**
   * Build purchase & revenue models from processed campaign rows.
   * Applies time-decay weighting; uses `analysisWeeks` most-recent data
   * (falls back to all data with doubled decay if insufficient).
   *
   * @param {Array}  rows          processedRows for one campaign
   * @param {number} lambda        decay rate (0.01–0.5)
   * @param {number} analysisWeeks recent window (default 4)
   * @returns {Object|null}
   */
  function buildModels(rows, lambda, analysisWeeks) {
    if (!rows || rows.length < 7) return null;

    // Sort ascending by date
    const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));

    // Determine recent window
    const latestDate = new Date(sorted[sorted.length - 1].date);
    const cutoff     = new Date(latestDate);
    cutoff.setDate(cutoff.getDate() - analysisWeeks * 7);
    const cutoffStr  = cutoff.toISOString().slice(0, 10);

    let data = sorted.filter(r => r.date >= cutoffStr);
    let lam  = lambda;
    if (data.length < 7) {
      data = sorted;    // fallback: all data
      lam  = lambda * 2;
    }

    const w  = computeWeights(data.length, lam);
    const xs = data.map(r => r.cost);
    const ps = data.map(r => r.purchase);
    const rs = data.map(r => r.revenue);

    const purchaseModel = fitLogLog(xs, ps, w);
    const revenueModel  = fitLogLog(xs, rs, w);

    if (!purchaseModel || !revenueModel) return null;

    // Historical weighted averages (for "current budget" context)
    let swCost = 0, swPurch = 0, swRev = 0, sw = 0;
    data.forEach((r, i) => {
      sw     += w[i];
      swCost += w[i] * r.cost;
      swPurch += w[i] * r.purchase;
      swRev  += w[i] * r.revenue;
    });

    return {
      purchase:    purchaseModel,
      revenue:     revenueModel,
      dataPoints:  data.length,
      dateRange:   { from: data[0].date, to: data[data.length - 1].date },
      historicalAvg: {
        cost:     swCost  / sw,
        purchase: swPurch / sw,
        revenue:  swRev   / sw,
        roas:     (swRev  / sw) / (swCost / sw) * 100,
      },
    };
  }

  /* ══════════════════════════════════════════════════════════════════
   * 3. MONTE CARLO SIMULATION
   * ══════════════════════════════════════════════════════════════════ */

  /**
   * Simulate `runs` samples for a given budget.
   * Noise is log-normal with σ from model fit.
   *
   * @returns {Object} { mean, median, p05, p95, samples (sorted) }
   */
  function monteCarlo(model, budget, runs) {
    const EPSILON = 1e-4;
    const safeBudget = Math.max(budget, EPSILON);
    const logMu = model.alpha + model.beta * Math.log(safeBudget);
    const sigma  = model.sigma;
    const arr    = new Float64Array(runs);

    for (let i = 0; i < runs; i++) {
      arr[i] = Math.exp(logMu + sigma * randn());
    }
    const rawSamples = Array.from(arr); // Keep UNSORTED trial realizations for paired win-rate sampling!

    arr.sort();   // typed array sort is numeric by default

    const sum = arr.reduce((s, v) => s + v, 0);
    return {
      mean:   sum / runs,
      median: arr[runs >> 1],
      p05:    arr[Math.floor(runs * 0.05)],
      p95:    arr[Math.floor(runs * 0.95)],
      samples: Array.from(arr),
      rawSamples,
    };
  }

  /**
   * Like monteCarlo(), but uses a pre-generated z[] array instead of sampling new noise.
   * This enables Common Random Numbers (CRN): both budgets experience the identical
   * market-noise scenarios, so win-rate comparisons are statistically valid.
   *
   * @param {Object}             model  { alpha, beta, sigma }
   * @param {number}             budget
   * @param {Float64Array|Array} zArr   pre-sampled standard-normal values
   * @returns {Object} same shape as monteCarlo()
   */
  function monteCarloWithZ(model, budget, zArr) {
    const EPSILON = 1e-4;
    const safeBudget = Math.max(budget, EPSILON);
    const logMu = model.alpha + model.beta * Math.log(safeBudget);
    const sigma  = model.sigma;
    const runs   = zArr.length;
    const arr    = new Float64Array(runs);

    for (let i = 0; i < runs; i++) {
      arr[i] = Math.exp(logMu + sigma * zArr[i]);
    }
    const rawSamples = Array.from(arr); // unsorted — paired scenario order preserved

    arr.sort();

    const sum = arr.reduce((s, v) => s + v, 0);
    return {
      mean:   sum / runs,
      median: arr[runs >> 1],
      p05:    arr[Math.floor(runs * 0.05)],
      p95:    arr[Math.floor(runs * 0.95)],
      samples: Array.from(arr),
      rawSamples,
    };
  }

  /* ══════════════════════════════════════════════════════════════════
   * 4. SIMULATION — CURRENT vs NEW BUDGET
   * ══════════════════════════════════════════════════════════════════ */

  /**
   * Compute executive decision verdict and win rates (confidence).
   * Calculates true Break-even Profit Win Rate using unsorted stochastic realizations.
   */
  function computeVerdictAndConfidence(curR, simR, curP, simP, currentBudget, simBudget, periodDays = 1) {
    const runs = curR.samples.length;
    const marginalCost  = (simBudget - currentBudget) * periodDays;
    const dailyCostDiff = simBudget - currentBudget;

    let profitWinCount = 0;   // Net Profit Lift >= 0 (본전 이상 흑자 달성)
    let revLiftCount   = 0;   // Revenue Lift > 0 (단순 매출 증가)
    let purchWinCount  = 0;   // Purchase Lift > 0 (전환수 증가)

    const curRRaw = curR.rawSamples || curR.samples;
    const simRRaw = simR.rawSamples || simR.samples;
    const curPRaw = curP.rawSamples || curP.samples;
    const simPRaw = simP.rawSamples || simP.samples;

    for (let i = 0; i < runs; i++) {
      const deltaRevDaily = simRRaw[i] - curRRaw[i];
      const deltaProfitDaily = deltaRevDaily - dailyCostDiff;

      // True break-even win: additional revenue >= additional cost
      if (deltaProfitDaily >= 0) profitWinCount++;
      if (deltaRevDaily > 0) revLiftCount++;
      if (simPRaw[i] > curPRaw[i]) purchWinCount++;
    }

    const revenueWinRate  = (profitWinCount / runs) * 100;    // 본전 이상(흑자) 달성 승률 %
    const revenueLiftRate = (revLiftCount / runs) * 100;     // 단순 매출 증가 승률 %
    const purchaseWinRate = (purchWinCount / runs) * 100;

    const marginalRevenue = (simR.mean - curR.mean) * periodDays;
    const marginalROAS    = marginalCost !== 0 ? (marginalRevenue / marginalCost * 100) : 0;
    const netContribution = marginalRevenue - marginalCost;

    let verdict = 'NEUTRAL';
    let verdictClass = 'verdict-neutral';
    let verdictIcon = '⚖️';
    let verdictTitle = '예산 유지 권장';
    let verdictReason = '예산 변경폭이 없거나 실적 변화가 미미합니다.';

    if (simBudget > currentBudget) {
      if (marginalROAS >= 150 && revenueWinRate >= 80) {
        verdict = 'STRONG_RECOMMEND';
        verdictClass = 'verdict-strong';
        verdictIcon = '🚀';
        verdictTitle = '예산 증액 적극 추천 (Scale-up)';
        verdictReason = `추가 투입 광고비 대비 한계 ROAS가 ${marginalROAS.toFixed(0)}%로 높고, 본전 이상(흑자) 달성 확률이 ${revenueWinRate.toFixed(1)}%로 매우 우수합니다.`;
      } else if (marginalROAS >= 100) {
        verdict = 'CONDITIONAL_RECOMMEND';
        verdictClass = 'verdict-conditional';
        verdictIcon = '📈';
        verdictTitle = '조건부 추천 (외형/볼륨 성장 목적)';
        verdictReason = `매출 상승 확률은 ${revenueLiftRate.toFixed(1)}%로 높으나, 본전 달성 확률이 ${revenueWinRate.toFixed(1)}% (한계 ROAS ${marginalROAS.toFixed(0)}%)로 수익 체감이 진행 중입니다. 볼륨 확장 목적에 적합합니다.`;
      } else {
        verdict = 'NOT_RECOMMEND';
        verdictClass = 'verdict-danger';
        verdictIcon = '⚠️';
        verdictTitle = '예산 증액 비추천 (비효율 경고)';
        verdictReason = `수익 체감 구간 진입으로 본전 달성 확률이 ${revenueWinRate.toFixed(1)}%에 불과합니다. 추가 지출(+$${Math.round(marginalCost).toLocaleString()}) 대비 추가 매출(+$${Math.round(marginalRevenue).toLocaleString()})이 부족하여 순이익이 감소할 위험이 큽니다.`;
      }
    } else if (simBudget < currentBudget) {
      verdict = 'STRONG_RECOMMEND';
      verdictClass = 'verdict-strong';
      verdictIcon = '🛡️';
      verdictTitle = '예산 감액 / 효율 극대화 추천';
      verdictReason = `일예산을 줄여 비효율 지출을 제거하고 전반적인 ROAS 효율 및 순이익 기여를 높입니다. (본전/개선 달성 확률 ${revenueWinRate.toFixed(1)}%)`;
    }

    return {
      revenueWinRate,   // Break-even profit win rate
      revenueLiftRate,  // Simple revenue lift rate
      purchaseWinRate,
      marginalCost,
      marginalRevenue,
      marginalROAS,
      netContribution,
      verdict,
      verdictClass,
      verdictIcon,
      verdictTitle,
      verdictReason,
    };
  }

  /**
   * Run full KPI simulation comparing `currentBudget` with `simBudget` or multiple period schedules.
   *
   * @param {Array}  rows           processedRows for one campaign
   * @param {Object} settings       { lambda, simRuns, analysisWeeks }
   * @param {number} currentBudget
   * @param {number} simBudget
   * @param {Object} [dateRange]    { startDate, endDate } or { schedules: [...] }
   * @returns {Object|null}
   */
  function runSimulation(rows, settings, currentBudget, simBudget, dateRange = null) {
    const { lambda, simRuns, analysisWeeks } = settings;
    const models = buildModels(rows, lambda, analysisWeeks);
    if (!models) return { error: 'Insufficient data — need at least 7 rows.' };

    // ── Common Random Numbers (CRN) ──────────────────────────────────
    // Generate shared noise vectors ONCE, then apply to BOTH budgets.
    // This ensures curP[i] and simP[i] represent the SAME market scenario,
    // making the paired win-rate comparison statistically meaningful.
    // Without CRN, the win-rate is always ~100% when simBudget > currentBudget.
    const zPurch = Array.from({ length: simRuns }, () => randn());
    const zRev   = Array.from({ length: simRuns }, () => randn());

    const curP = monteCarloWithZ(models.purchase, currentBudget, zPurch);
    const simP = monteCarloWithZ(models.purchase, simBudget,     zPurch);
    const curR = monteCarloWithZ(models.revenue,  currentBudget, zRev);
    const simR = monteCarloWithZ(models.revenue,  simBudget,     zRev);


    // ROAS = revenue / cost (expressed as %)
    const roasStats = (rev, cost) => ({
      mean:   rev.mean   / cost * 100,
      median: rev.median / cost * 100,
      p05:    rev.p05    / cost * 100,
      p95:    rev.p95    / cost * 100,
    });

    const dailyROAS = {
      current: roasStats(curR, currentBudget),
      sim:     roasStats(simR, simBudget),
    };

    const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
    const minDate = sorted[0].date;
    const maxDate = sorted[sorted.length - 1].date;

    // Check if multi-period schedules are supplied
    const schedules = (dateRange && dateRange.schedules && dateRange.schedules.length)
      ? dateRange.schedules
      : null;

    let startDate = dateRange && dateRange.startDate ? dateRange.startDate : minDate;
    let endDate   = dateRange && dateRange.endDate   ? dateRange.endDate   : maxDate;
    if (startDate > endDate) {
      const tmp = startDate; startDate = endDate; endDate = tmp;
    }

    const msDiff = Math.abs(new Date(endDate) - new Date(startDate));
    const periodDays = Math.max(1, Math.round(msDiff / (1000 * 60 * 60 * 24)) + 1);

    const scaleMC = (mc, factor) => ({
      mean:   mc.mean   * factor,
      median: mc.median * factor,
      p05:    mc.p05    * factor,
      p95:    mc.p95    * factor,
    });

    // Executive verdict & win rate
    const verdictInfo = computeVerdictAndConfidence(curR, simR, curP, simP, currentBudget, simBudget, periodDays);

    // Actual historical metrics within selected period
    const periodRows = sorted.filter(r => r.date >= startDate && r.date <= endDate);
    const actualCostTotal  = periodRows.reduce((s, r) => s + r.cost, 0);
    const actualPurchTotal = periodRows.reduce((s, r) => s + r.purchase, 0);
    const actualRevTotal   = periodRows.reduce((s, r) => s + r.revenue, 0);
    const actualROASVal    = actualCostTotal > 0 ? (actualRevTotal / actualCostTotal * 100) : 0;
    const actualAvgDailyCost = periodRows.length > 0 ? actualCostTotal / periodRows.length : currentBudget;

    const periodTotal = {
      days: periodDays,
      startDate,
      endDate,
      actual: {
        cost: actualCostTotal,
        purchase: actualPurchTotal,
        revenue: actualRevTotal,
        roas: actualROASVal,
        avgDailyCost: actualAvgDailyCost,
      },
      cost: {
        current: currentBudget * periodDays,
        sim:     simBudget * periodDays,
        diff:    (simBudget * periodDays) - actualCostTotal,
      },
      purchase: {
        current: scaleMC(curP, periodDays),
        sim:     scaleMC(simP, periodDays),
        diffVsActual: simP.mean * periodDays - actualPurchTotal,
      },
      revenue: {
        current: scaleMC(curR, periodDays),
        sim:     scaleMC(simR, periodDays),
        diffVsActual: simR.mean * periodDays - actualRevTotal,
      },
      roas: {
        current: dailyROAS.current,
        sim:     dailyROAS.sim,
        actual:  actualROASVal,
      },
    };

    // Timeline series: historical actuals vs simulated budget
    const timeline = sorted.map(r => {
      let targetBudget = currentBudget;
      let inPeriod = false;
      let periodLabel = '';

      if (schedules && schedules.length > 0) {
        // Multi-period schedule lookup
        const matched = schedules.find(sc => r.date >= sc.startDate && r.date <= sc.endDate);
        if (matched) {
          targetBudget = matched.budget;
          inPeriod = true;
          periodLabel = matched.label || `Period (${matched.startDate.slice(5)}~${matched.endDate.slice(5)})`;
        }
      } else {
        // Single period
        inPeriod = r.date >= startDate && r.date <= endDate;
        if (inPeriod) targetBudget = simBudget;
      }

      const baselineCost = currentBudget > 0 ? currentBudget : r.cost;
      const baselineRev  = predict(models.revenue, baselineCost);
      const baselinePurch = predict(models.purchase, baselineCost);

      const modifiedCost  = inPeriod ? targetBudget : baselineCost;
      const modifiedRev   = inPeriod ? predict(models.revenue, targetBudget) : baselineRev;
      const modifiedPurch = inPeriod ? predict(models.purchase, targetBudget) : baselinePurch;

      return {
        date: r.date,
        inPeriod,
        periodLabel,
        actualCost: r.cost,
        actualRevenue: r.revenue,
        actualPurchase: r.purchase,
        actualROAS: r.cost > 0 ? (r.revenue / r.cost * 100) : 0,

        baselineCost,
        baselineRevenue: baselineRev,
        baselinePurchase: baselinePurch,
        baselineROAS: baselineCost > 0 ? (baselineRev / baselineCost * 100) : 0,

        modifiedCost,
        modifiedRevenue: modifiedRev,
        modifiedPurchase: modifiedPurch,
        modifiedROAS: modifiedCost > 0 ? (modifiedRev / modifiedCost * 100) : 0,
      };
    });

    return {
      models,
      currentBudget,
      simBudget,
      periodDays,
      startDate,
      endDate,
      minDate,
      maxDate,
      purchase: { current: curP, sim: simP },
      revenue:  { current: curR, sim: simR },
      roas:     dailyROAS,
      periodTotal,
      timeline,
      verdictInfo,
      schedules,
    };
  }

  /* ══════════════════════════════════════════════════════════════════
   * 4-B. RULE-BASED DYNAMIC STRATEGY SIMULATION (Strategy Lab)
   * ══════════════════════════════════════════════════════════════════ */

  /**
   * Simulate a conditional rule-based budget strategy over time.
   * e.g., "If WoW Purchase increases by >= 30%, increase budget by 30% next week"
   *
   * @param {Array}  rows
   * @param {Object} settings
   * @param {Object} strategyConfig
   * @returns {Object}
   */
  function runStrategySimulation(rows, settings, strategyConfig) {
    const { lambda, analysisWeeks = 4 } = settings;
    const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
    if (sorted.length < 21) {
      return { error: '전략 시뮬레이션을 위해서는 최소 3주(21일) 이상의 데이터가 필요합니다.' };
    }

    const models = buildModels(sorted, lambda, analysisWeeks);
    if (!models) return { error: '모델 생성에 실패했습니다.' };

    const {
      metric = 'purchase',          // 'purchase' | 'revenue' | 'roas'
      threshold = 30,               // WoW % threshold (e.g. +30%)
      actionValue = 30,             // Budget change % (e.g. +30%)
      hasNegativeRule = true,
      negThreshold = -20,           // WoW % fall threshold (e.g. -20%)
      negActionValue = -10,         // Budget change % (e.g. -10%)
      minBudget = 100,
      maxBudget = 10000,
      baseBudget = 0,
    } = strategyConfig;

    // Group sorted days into 7-day weeks
    const weeks = [];
    const nDays = sorted.length;
    for (let i = 0; i < nDays; i += 7) {
      const chunk = sorted.slice(i, i + 7);
      if (chunk.length >= 4) { // Only keep if at least 4 days
        const sumCost   = chunk.reduce((s, r) => s + r.cost, 0);
        const sumPurch  = chunk.reduce((s, r) => s + r.purchase, 0);
        const sumRev    = chunk.reduce((s, r) => s + r.revenue, 0);
        weeks.push({
          weekIdx: weeks.length + 1,
          startDate: chunk[0].date,
          endDate: chunk[chunk.length - 1].date,
          days: chunk,
          actualCost: sumCost,
          actualPurchase: sumPurch,
          actualRevenue: sumRev,
          actualROAS: sumCost > 0 ? (sumRev / sumCost * 100) : 0,
          avgDailyCost: sumCost / chunk.length,
        });
      }
    }

    if (weeks.length < 3) {
      return { error: '주간 단위 평가를 위해 최소 3주 이상의 온전한 기간이 필요합니다.' };
    }

    const initialDailyBudget = baseBudget > 0 ? baseBudget : weeks[0].avgDailyCost;
    let currentStrategyDailyBudget = initialDailyBudget;

    const weeklyLogs = [];
    let totalActualCost = 0, totalActualRev = 0, totalActualPurch = 0;
    let totalStratCost  = 0, totalStratRev  = 0, totalStratPurch  = 0;

    const timeline = [];

    // Simulate week by week
    for (let w = 0; w < weeks.length; w++) {
      const curWeek = weeks[w];
      let ruleApplied = 'BASELINE_HOLD';
      let ruleDesc = '기본 예산 유지';
      let wowGrowth = 0;

      if (w === 0) {
        // First week: initialize baseline
        currentStrategyDailyBudget = initialDailyBudget;
        ruleDesc = '초기 기준 예산 집행';
      } else {
        const prevWeek = weeks[w - 1];
        // Calculate WoW growth of trigger metric based on actual performance of prevWeek
        let prevMetricVal = 0, priorMetricVal = 0;

        if (w >= 2) {
          const twoWeeksAgo = weeks[w - 2];
          prevMetricVal  = prevWeek['actual' + capitalize(metric)];
          priorMetricVal = twoWeeksAgo['actual' + capitalize(metric)];
        } else {
          prevMetricVal  = prevWeek['actual' + capitalize(metric)];
          priorMetricVal = prevMetricVal; // first comparison baseline
        }

        if (priorMetricVal > 0) {
          wowGrowth = ((prevMetricVal - priorMetricVal) / priorMetricVal) * 100;
        }

        const oldBudget = currentStrategyDailyBudget;

        // Apply rules
        if (wowGrowth >= threshold) {
          const factor = 1 + (actionValue / 100);
          currentStrategyDailyBudget = Math.max(minBudget, Math.min(maxBudget, oldBudget * factor));
          ruleApplied = 'SCALE_UP';
          ruleDesc = `전주 실적 +${wowGrowth.toFixed(1)}% 달성 → 일예산 +${actionValue}% 증액 ($${Math.round(oldBudget)} → $${Math.round(currentStrategyDailyBudget)})`;
        } else if (hasNegativeRule && wowGrowth <= negThreshold) {
          const factor = 1 + (negActionValue / 100);
          currentStrategyDailyBudget = Math.max(minBudget, Math.min(maxBudget, oldBudget * factor));
          ruleApplied = 'SCALE_DOWN';
          ruleDesc = `전주 실적 ${wowGrowth.toFixed(1)}% 하락 → 일예산 ${negActionValue}% 감액 ($${Math.round(oldBudget)} → $${Math.round(currentStrategyDailyBudget)})`;
        } else {
          ruleApplied = 'HOLD';
          ruleDesc = `전주 실적 변동(${wowGrowth >= 0 ? '+' : ''}${wowGrowth.toFixed(1)}%)이 기준치 미만 → 예산 유지 ($${Math.round(currentStrategyDailyBudget)})`;
        }
      }

      // Simulate current week with currentStrategyDailyBudget
      const nDaysInWeek = curWeek.days.length;
      const weekStratDailyCost = currentStrategyDailyBudget;
      const weekStratTotalCost = weekStratDailyCost * nDaysInWeek;
      const weekStratDailyPurch = predict(models.purchase, weekStratDailyCost);
      const weekStratDailyRev   = predict(models.revenue,  weekStratDailyCost);
      const weekStratTotalPurch = weekStratDailyPurch * nDaysInWeek;
      const weekStratTotalRev   = weekStratDailyRev * nDaysInWeek;
      const weekStratROAS       = weekStratTotalCost > 0 ? (weekStratTotalRev / weekStratTotalCost * 100) : 0;

      // Accumulate totals
      totalActualCost  += curWeek.actualCost;
      totalActualRev   += curWeek.actualRevenue;
      totalActualPurch += curWeek.actualPurchase;

      totalStratCost   += weekStratTotalCost;
      totalStratRev    += weekStratTotalRev;
      totalStratPurch  += weekStratTotalPurch;

      weeklyLogs.push({
        weekIdx: curWeek.weekIdx,
        startDate: curWeek.startDate,
        endDate: curWeek.endDate,
        wowGrowth,
        ruleApplied,
        ruleDesc,
        strategyDailyBudget: weekStratDailyCost,
        actualCost: curWeek.actualCost,
        strategyCost: weekStratTotalCost,
        actualRevenue: curWeek.actualRevenue,
        strategyRevenue: weekStratTotalRev,
        actualPurchase: curWeek.actualPurchase,
        strategyPurchase: weekStratTotalPurch,
        actualROAS: curWeek.actualROAS,
        strategyROAS: weekStratROAS,
      });

      // Daily timeline
      curWeek.days.forEach(d => {
        const stratPurch = predict(models.purchase, currentStrategyDailyBudget);
        const stratRev   = predict(models.revenue,  currentStrategyDailyBudget);
        timeline.push({
          date: d.date,
          actualCost: d.cost,
          actualRevenue: d.revenue,
          actualPurchase: d.purchase,
          actualROAS: d.cost > 0 ? (d.revenue / d.cost * 100) : 0,

          strategyCost: currentStrategyDailyBudget,
          strategyRevenue: stratRev,
          strategyPurchase: stratPurch,
          strategyROAS: currentStrategyDailyBudget > 0 ? (stratRev / currentStrategyDailyBudget * 100) : 0,
        });
      });
    }

    const totalActualROAS = totalActualCost > 0 ? (totalActualRev / totalActualCost * 100) : 0;
    const totalStratROAS  = totalStratCost > 0  ? (totalStratRev / totalStratCost * 100) : 0;

    const revLiftPct  = totalActualRev > 0  ? ((totalStratRev - totalActualRev) / totalActualRev * 100) : 0;
    const costLiftPct = totalActualCost > 0 ? ((totalStratCost - totalActualCost) / totalActualCost * 100) : 0;
    const roasLiftP   = totalStratROAS - totalActualROAS;
    const netProfitContribution = (totalStratRev - totalActualRev) - (totalStratCost - totalActualCost);

    // Strategy Verdict
    let verdictTitle = '전략 검증 완료';
    let verdictClass = 'verdict-strong';
    let verdictDesc  = '';
    if (netProfitContribution > 0 && revLiftPct > 0) {
      verdictClass = 'verdict-strong';
      verdictTitle = '🚀 전략 적용 강력 추천 (실적 대폭 개선)';
      verdictDesc = `이 룰대로 운영했을 경우 실제 대비 매출이 +${revLiftPct.toFixed(1)}% 늘어나고, 순이익 기여도가 +$${Math.round(netProfitContribution).toLocaleString()} 개선되었을 것으로 분석됩니다.`;
    } else if (revLiftPct > 0) {
      verdictClass = 'verdict-conditional';
      verdictTitle = '📈 조건부 유효 (매출 확대용)';
      verdictDesc = `매출은 +${revLiftPct.toFixed(1)}% 증가했으나, 광고비 증가폭(+${costLiftPct.toFixed(1)}%)이 커서 ROAS 효율이 ${roasLiftP.toFixed(1)}%p 변동되었습니다.`;
    } else {
      verdictClass = 'verdict-danger';
      verdictTitle = '⚠️ 전략 비추천 (성과 미흡)';
      verdictDesc = `해당 조건 룰을 적용했을 때 실제 과거 집행보다 매출 또는 효율이 개선되지 않았습니다. 조건 기준치 조정을 권장합니다.`;
    }

    return {
      models,
      strategyConfig,
      summary: {
        actual: {
          cost: totalActualCost,
          revenue: totalActualRev,
          purchase: totalActualPurch,
          roas: totalActualROAS,
        },
        strategy: {
          cost: totalStratCost,
          revenue: totalStratRev,
          purchase: totalStratPurch,
          roas: totalStratROAS,
        },
        diff: {
          costDiff: totalStratCost - totalActualCost,
          revDiff: totalStratRev - totalActualRev,
          purchDiff: totalStratPurch - totalActualPurch,
          costLiftPct,
          revLiftPct,
          roasLiftP,
          netProfitContribution,
        },
        verdictTitle,
        verdictClass,
        verdictDesc,
      },
      weeklyLogs,
      timeline,
    };
  }

  function capitalize(s) {
    if (!s) return '';
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  /* ══════════════════════════════════════════════════════════════════
   * 5. WHAT-IF — MULTIPLE BUDGETS
   * ══════════════════════════════════════════════════════════════════ */

  /**
   * Simulate KPIs for an arbitrary list of budgets.
   *
   * @param {Array}  budgets  array of budget values (USD)
   * @returns {Object} { models, results[] }
   */
  function runWhatIf(rows, settings, budgets) {
    const { lambda, simRuns, analysisWeeks } = settings;
    if (!budgets || budgets.length === 0) return { error: 'No budgets specified.' };

    const models = buildModels(rows, lambda, analysisWeeks);
    if (!models) return { error: 'Insufficient data.' };

    const results = budgets.map(budget => {
      const p = monteCarlo(models.purchase, budget, simRuns);
      const r = monteCarlo(models.revenue,  budget, simRuns);
      return {
        budget,
        purchase: p,
        revenue:  r,
        roas: {
          mean:   r.mean   / budget * 100,
          median: r.median / budget * 100,
          p05:    r.p05    / budget * 100,
          p95:    r.p95    / budget * 100,
        },
      };
    });

    return { models, results };
  }

  /* ══════════════════════════════════════════════════════════════════
   * 6. BUDGET OPTIMIZATION
   * ══════════════════════════════════════════════════════════════════ */

  /**
   * Grid-search for the "optimal" budget given an objective.
   *
   * • 'roas'     → maximize Revenue/Cost (will favour lower budgets due to diminishing returns)
   * • 'purchase' → maximize Purchase
   * • 'revenue'  → maximize Revenue
   *
   * Uses analytical predictions (no MC) for speed over the grid,
   * then runs MC for the winner to report uncertainty.
   *
   * @param {string} objective  'roas' | 'purchase' | 'revenue'
   * @param {number} minBudget
   * @param {number} maxBudget
   * @param {number} nPoints    grid resolution (default 600)
   */
  function optimizeBudget(rows, settings, objective, minBudget, maxBudget, nPoints = 600) {
    const { lambda, simRuns, analysisWeeks } = settings;
    const models = buildModels(rows, lambda, analysisWeeks);
    if (!models) return { error: 'Insufficient data.' };

    // Build efficiency curve (analytical, fast)
    const curve = [];
    for (let i = 0; i <= nPoints; i++) {
      const b   = minBudget + (maxBudget - minBudget) * (i / nPoints);
      const p   = predict(models.purchase, b);
      const r   = predict(models.revenue,  b);
      const roa = r / b * 100;
      curve.push({ budget: b, purchase: p, revenue: r, roas: roa });
    }

    // Find best index
    let bestIdx = 0;
    for (let i = 1; i < curve.length; i++) {
      const cur  = curve[i];
      const best = curve[bestIdx];
      const better =
        objective === 'roas'     ? cur.roas     > best.roas     :
        objective === 'purchase' ? cur.purchase  > best.purchase :
                                   cur.revenue   > best.revenue;
      if (better) bestIdx = i;
    }

    const opt = curve[bestIdx];

    // Run MC for optimal budget
    const optP = monteCarlo(models.purchase, opt.budget, simRuns);
    const optR = monteCarlo(models.revenue,  opt.budget, simRuns);

    return {
      models,
      curve,
      objective,
      optimal: {
        budget:   opt.budget,
        purchase: optP,
        revenue:  optR,
        roas: {
          mean:   optR.mean   / opt.budget * 100,
          median: optR.median / opt.budget * 100,
          p05:    optR.p05    / opt.budget * 100,
          p95:    optR.p95    / opt.budget * 100,
        },
      },
    };
  }

  /* ══════════════════════════════════════════════════════════════════
   * 7. TEMPORAL BACKTEST
   * ══════════════════════════════════════════════════════════════════ */

  /**
   * Train on the first `trainRatio` of time-ordered data,
   * evaluate on the remaining portion.
   *
   * @param {number} trainRatio  default 0.70
   * @returns {Object} { trainPeriod, testPeriod, purchaseModel, revenueModel,
   *                     trainResults, testResults, metrics }
   */
  function runBacktest(rows, settings, trainRatio = 0.70) {
    const { lambda } = settings;
    const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));

    if (sorted.length < 20) {
      return { error: 'Need ≥ 20 data points for backtest.' };
    }

    const splitIdx  = Math.max(10, Math.floor(sorted.length * trainRatio));
    const trainRows = sorted.slice(0, splitIdx);
    const testRows  = sorted.slice(splitIdx);

    if (testRows.length < 5) {
      return { error: 'Too few test-period rows. Try a lower train ratio.' };
    }

    // Fit on train
    const w       = computeWeights(trainRows.length, lambda);
    const tCosts  = trainRows.map(r => r.cost);
    const tPurch  = trainRows.map(r => r.purchase);
    const tRev    = trainRows.map(r => r.revenue);

    const pModel = fitLogLog(tCosts, tPurch, w);
    const rModel = fitLogLog(tCosts, tRev,   w);

    if (!pModel || !rModel) return { error: 'Model fitting failed on training data.' };

    // Helper to compute result rows
    const buildResultRows = (dataRows) => dataRows.map(r => {
      const predP = predict(pModel, r.cost);
      const predR = predict(rModel, r.cost);
      return {
        date:              r.date,
        cost:              r.cost,
        actualPurchase:    r.purchase,
        predictedPurchase: predP,
        actualRevenue:     r.revenue,
        predictedRevenue:  predR,
        actualROAS:        r.cost > 0 ? (r.revenue / r.cost * 100) : 0,
        predictedROAS:     r.cost > 0 ? (predR / r.cost * 100) : 0,
      };
    });

    const trainResults = buildResultRows(trainRows);
    const testResults  = buildResultRows(testRows);

    // Error metrics on test set
    const mape = (actuals, preds) =>
      preds.reduce((s, p, i) => s + (actuals[i] > 0 ? Math.abs(actuals[i] - p) / actuals[i] : 0), 0) / preds.length * 100;
    const rmse = (actuals, preds) =>
      Math.sqrt(preds.reduce((s, p, i) => s + (actuals[i] - p) ** 2, 0) / preds.length);

    const testActP  = testResults.map(r => r.actualPurchase);
    const testPredP = testResults.map(r => r.predictedPurchase);
    const testActR  = testResults.map(r => r.actualRevenue);
    const testPredR = testResults.map(r => r.predictedRevenue);
    const testActROAS  = testResults.map(r => r.actualROAS);
    const testPredROAS = testResults.map(r => r.predictedROAS);

    return {
      trainPeriod: { from: trainRows[0].date, to: trainRows[trainRows.length - 1].date, n: trainRows.length },
      testPeriod:  { from: testRows[0].date,  to: testRows[testRows.length  - 1].date,  n: testRows.length  },
      purchaseModel: { alpha: pModel.alpha, beta: pModel.beta, sigma: pModel.sigma, r2: pModel.r2 },
      revenueModel:  { alpha: rModel.alpha, beta: rModel.beta, sigma: rModel.sigma, r2: rModel.r2 },
      trainResults,
      testResults,
      metrics: {
        purchaseMAPE: mape(testActP,  testPredP),
        revenueMAPE:  mape(testActR,  testPredR),
        purchaseRMSE: rmse(testActP,  testPredP),
        revenueRMSE:  rmse(testActR,  testPredR),
        roasMAPE:     mape(testActROAS, testPredROAS),
        roasRMSE:     rmse(testActROAS, testPredROAS),
      },
    };
  }

  /* ── Public API ─────────────────────────────────────────────────── */
  return {
    buildModels,
    predict,
    monteCarlo,
    runSimulation,
    runStrategySimulation,
    computeVerdictAndConfidence,
    runWhatIf,
    optimizeBudget,
    runBacktest,
  };

})();
