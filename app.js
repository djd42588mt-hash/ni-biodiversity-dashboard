(function () {
  "use strict";

  /* ============================================================
     Northern Ireland Biodiversity Watch — frontend
     No external dependencies. All charts are hand-built SVG, so
     there is nothing that can fail to load from a CDN - if this
     script runs, the charts render.
     ============================================================ */

  const state = {
    config: null,
    summary: null,
    occData: null,
    seqData: null,
    compareGroup: null,
    compareSelected: new Set(),
  };

  const GROUP_PALETTE = {
    Invertebrates: "#3B6B4F", Mammals: "#A9691B", Fungi: "#7A5C3E", Birds: "#2E6E8E",
    Bacteria: "#8E4A5A", Fish: "#2E7D7B", Amphibians: "#5B7A2E",
  };
  const DEFAULT_COLOR = "#5B5148";
  const COMPARE_PALETTE = ["#3B6B4F", "#A9691B", "#2E6E8E", "#9C3F2C", "#7A5C3E", "#5B7A2E", "#8E4A5A", "#D9932E", "#24463A", "#5B5148"];
  const INK_SOFT = "#5B5148";

  // ---------------- generic helpers ----------------

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function slug(name) { return String(name).replace(/[^a-zA-Z0-9]/g, "_"); }

  async function fetchJson(path, fallback) {
    try {
      const res = await fetch(path, { cache: "no-store" });
      if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      console.warn("Could not load", path, err);
      return fallback;
    }
  }

  function toneClass(status) {
    switch (status) {
      case "significant_decline": case "biosecurity_alert": return "tone-decline";
      case "moderate_decline": return "tone-moderate";
      case "notable_increase": case "increase_from_zero": return "tone-increase";
      default: return "tone-neutral";
    }
  }
  function severityToneClass(severity) { return severity === "high" ? "tone-decline" : "tone-moderate"; }

  function formatUpdated(iso) {
    if (!iso) return "Awaiting first automated update.";
    try {
      const d = new Date(iso);
      return `Record last updated ${d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })} (${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} UTC)`;
    } catch { return `Record last updated ${iso}`; }
  }

  function yearsAndValues(byYear, backYears) {
    const years = Object.keys(byYear || {}).sort();
    const trimmed = backYears ? years.slice(-backYears) : years;
    return { labels: trimmed, values: trimmed.map((y) => byYear[y] ?? 0) };
  }

  // ---------------- SVG chart engine ----------------

  const SVG_NS = "http://www.w3.org/2000/svg";
  function svgEl(tag, attrs) {
    const el = document.createElementNS(SVG_NS, tag);
    Object.entries(attrs || {}).forEach(([k, v]) => el.setAttribute(k, v));
    return el;
  }
  function svgTitle(text) {
    const t = svgEl("title", {});
    t.textContent = text;
    return t;
  }
  function niceMax(v) {
    if (v <= 0) return 1;
    const mag = Math.pow(10, Math.floor(Math.log10(v)));
    const norm = v / mag;
    let step;
    if (norm <= 1) step = 1; else if (norm <= 2) step = 2; else if (norm <= 5) step = 5; else step = 10;
    return step * mag;
  }

  /** Bar chart: years on x, counts on y. Renders into `container` (a DOM element). */
  function renderBarChart(container, years, values, opts) {
    opts = opts || {};
    const color = opts.color || DEFAULT_COLOR;
    const currentYear = opts.currentYear ? String(opts.currentYear) : null;
    const W = 480, H = opts.height || 200;
    const padL = 38, padR = 10, padT = 12, padB = 24;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const maxVal = niceMax(Math.max(1, ...values));
    const n = values.length || 1;
    const gap = Math.max(2, Math.min(6, plotW / n * 0.25));
    const barW = Math.max(1, (plotW - gap * (n - 1)) / n);

    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Bar chart" });

    for (let i = 0; i <= 3; i++) {
      const val = (maxVal * i) / 3;
      const y = padT + plotH - (plotH * i) / 3;
      svg.appendChild(svgEl("line", { x1: padL, x2: W - padR, y1: y, y2: y, stroke: "rgba(42,36,32,0.10)", "stroke-width": 1 }));
      const t = svgEl("text", { x: padL - 6, y: y + 3, "text-anchor": "end", "font-size": 9, fill: INK_SOFT, "font-family": "IBM Plex Mono, monospace" });
      t.textContent = Math.round(val).toLocaleString();
      svg.appendChild(t);
    }

    const labelEvery = Math.max(1, Math.ceil(n / 7));
    years.forEach((yr, i) => {
      const x = padL + i * (barW + gap);
      const barH = maxVal ? (values[i] / maxVal) * plotH : 0;
      const y = padT + plotH - barH;
      const isCurrent = currentYear && yr === currentYear;
      const fill = isCurrent ? color + "55" : color;
      const rect = svgEl("rect", { x: x.toFixed(2), y: y.toFixed(2), width: barW.toFixed(2), height: Math.max(0, barH).toFixed(2), fill, rx: 1.5 });
      rect.appendChild(svgTitle(`${yr}${isCurrent ? " (year to date)" : ""}: ${values[i].toLocaleString()} records`));
      svg.appendChild(rect);
      if (i % labelEvery === 0 || i === n - 1) {
        const lbl = svgEl("text", { x: (x + barW / 2).toFixed(2), y: H - 6, "text-anchor": "middle", "font-size": 8.5, fill: INK_SOFT, "font-family": "IBM Plex Mono, monospace" });
        lbl.textContent = yr;
        svg.appendChild(lbl);
      }
    });

    container.innerHTML = "";
    container.appendChild(svg);
  }

  /** Minimal sparkline: no axes, no labels. */
  function renderSparkline(container, years, values, color) {
    const W = 200, H = 40, pad = 3;
    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, "aria-hidden": "true" });
    if (!values.length || !values.some((v) => v > 0)) { container.innerHTML = ""; return; }
    const maxVal = Math.max(1, ...values);
    const n = values.length;
    const points = values.map((v, i) => {
      const x = pad + (i / Math.max(1, n - 1)) * (W - pad * 2);
      const y = H - pad - (v / maxVal) * (H - pad * 2);
      return [x, y];
    });
    const d = points.map((p, i) => (i === 0 ? `M${p[0].toFixed(1)},${p[1].toFixed(1)}` : `L${p[0].toFixed(1)},${p[1].toFixed(1)}`)).join(" ");
    svg.appendChild(svgEl("path", { d, fill: "none", stroke: color, "stroke-width": 1.6, "stroke-linecap": "round", "stroke-linejoin": "round" }));
    container.innerHTML = "";
    container.appendChild(svg);
  }

  /** Multi-line comparison chart with native tooltips on points. */
  function renderMultiLineChart(container, years, series, opts) {
    opts = opts || {};
    const W = 900, H = opts.height || 340;
    const padL = 46, padR = 16, padT = 16, padB = 28;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const visible = series.filter((s) => s.visible !== false);
    const allValues = visible.flatMap((s) => s.values.filter((v) => v != null));
    const maxVal = niceMax(Math.max(1, ...(allValues.length ? allValues : [1])));
    const n = years.length;

    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Comparison chart" });

    for (let i = 0; i <= 4; i++) {
      const val = (maxVal * i) / 4;
      const y = padT + plotH - (plotH * i) / 4;
      svg.appendChild(svgEl("line", { x1: padL, x2: W - padR, y1: y, y2: y, stroke: "rgba(42,36,32,0.10)", "stroke-width": 1 }));
      const t = svgEl("text", { x: padL - 8, y: y + 3, "text-anchor": "end", "font-size": 10, fill: INK_SOFT, "font-family": "IBM Plex Mono, monospace" });
      t.textContent = Math.round(val).toLocaleString();
      svg.appendChild(t);
    }
    const labelEvery = Math.max(1, Math.ceil(n / 10));
    years.forEach((yr, i) => {
      if (i % labelEvery !== 0 && i !== n - 1) return;
      const x = n > 1 ? padL + (i / (n - 1)) * plotW : padL + plotW / 2;
      const t = svgEl("text", { x: x.toFixed(2), y: H - 8, "text-anchor": "middle", "font-size": 9.5, fill: INK_SOFT, "font-family": "IBM Plex Mono, monospace" });
      t.textContent = yr;
      svg.appendChild(t);
    });

    if (!visible.length) {
      container.innerHTML = "";
      container.appendChild(svg);
      return;
    }

    visible.forEach((s) => {
      const pts = years.map((yr, i) => {
        const v = s.values[i];
        if (v == null) return null;
        const x = n > 1 ? padL + (i / (n - 1)) * plotW : padL + plotW / 2;
        const y = padT + plotH - (maxVal ? (v / maxVal) * plotH : 0);
        return [x, y, v, yr];
      });
      const validPts = pts.filter(Boolean);
      if (validPts.length) {
        const d = validPts.map((p, i) => (i === 0 ? `M${p[0].toFixed(2)},${p[1].toFixed(2)}` : `L${p[0].toFixed(2)},${p[1].toFixed(2)}`)).join(" ");
        svg.appendChild(svgEl("path", { d, fill: "none", stroke: s.color, "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round" }));
      }
      validPts.forEach(([x, y, v, yr]) => {
        const c = svgEl("circle", { cx: x.toFixed(2), cy: y.toFixed(2), r: 3, fill: s.color });
        c.appendChild(svgTitle(`${s.label} — ${yr}: ${v.toLocaleString()}`));
        svg.appendChild(c);
      });
    });

    container.innerHTML = "";
    container.appendChild(svg);
  }

  // ---------------- Headline KPIs ----------------

  function renderKPIs() {
    const kpi = document.getElementById("kpiStrip");
    const species = state.config.species || [];
    const groupsCount = new Set(species.map((s) => s.category)).size;
    const alertsCount = (state.summary.alerts || []).length;
    const totalRecords = Object.values((state.occData && state.occData.species) || {}).reduce((sum, r) => sum + (r.totalRecords || 0), 0);
    kpi.innerHTML = `
      <div class="kpi-box"><div class="kpi-value">${species.length}</div><div class="kpi-label">species tracked</div></div>
      <div class="kpi-box"><div class="kpi-value">${groupsCount}</div><div class="kpi-label">taxonomic groups</div></div>
      <div class="kpi-box"><div class="kpi-value">${totalRecords.toLocaleString()}</div><div class="kpi-label">NI records logged</div></div>
      <div class="kpi-box"><div class="kpi-value">${alertsCount}</div><div class="kpi-label">active alerts</div></div>
    `;
  }

  // ---------------- Long-term signal (executive summary) ----------------

  function renderSignal() {
    const el = document.getElementById("signalBars");
    const ov = state.summary.overview || { improving: 0, declining: 0, stable: 0 };
    const total = ov.improving + ov.declining + ov.stable;
    if (!state.summary.generatedAt || !total) {
      el.innerHTML = `<p class="no-results">The long-term signal will appear once enough survey history has accumulated (needs several years of complete data per species).</p>`;
      return;
    }
    const pct = (n) => (total ? Math.round((n / total) * 100) : 0);
    el.innerHTML = `
      <div class="signal-stat improving"><div class="signal-count">${ov.improving}</div><div class="signal-label">improving long-term</div></div>
      <div class="signal-stat declining"><div class="signal-count">${ov.declining}</div><div class="signal-label">declining long-term</div></div>
      <div class="signal-stat stable"><div class="signal-count">${ov.stable}</div><div class="signal-label">no clear long-term change</div></div>
    `;
    const track = document.createElement("div");
    track.className = "signal-track";
    track.innerHTML = `
      <div class="seg-improving" style="width:${pct(ov.improving)}%"></div>
      <div class="seg-declining" style="width:${pct(ov.declining)}%"></div>
      <div class="seg-stable" style="width:${pct(ov.stable)}%"></div>
    `;
    el.appendChild(track);
  }

  // ---------------- Alerts rail ----------------

  function renderAlerts() {
    const rail = document.getElementById("alertsRail");
    const emptyNote = document.getElementById("alertsEmptyNote");
    const alerts = (state.summary && state.summary.alerts) || [];
    rail.querySelectorAll(".alert-card").forEach((n) => n.remove());
    if (!alerts.length) {
      emptyNote.textContent = state.summary.generatedAt ? "No significant changes flagged in the current dataset." : "Alerts will appear here once the first automated survey has run.";
      emptyNote.hidden = false;
      return;
    }
    emptyNote.hidden = true;
    alerts.forEach((a) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = `specimen-card alert-card ${severityToneClass(a.severity)}`;
      card.innerHTML = `
        <p class="alert-severity">${a.severity === "high" ? "Priority" : "Notable"}</p>
        <h3>${escapeHtml(a.commonName)}</h3>
        <span class="sci-name">${escapeHtml(a.scientificName)}</span>
        <p class="alert-msg">${escapeHtml(a.message)}</p>
      `;
      card.addEventListener("click", () => showSpeciesDetail(a.scientificName));
      rail.appendChild(card);
    });
  }

  // ---------------- Trends by group ----------------

  function buildGroupAggregates() {
    const groups = {};
    (state.config.species || []).forEach((sp) => {
      const cat = sp.category || "Other";
      if (!groups[cat]) groups[cat] = { byYear: {}, totalRecords: 0, speciesCount: 0 };
      groups[cat].speciesCount += 1;
      const occ = state.occData.species && state.occData.species[sp.scientificName];
      if (occ) {
        groups[cat].totalRecords += occ.totalRecords || 0;
        Object.entries(occ.byYear || {}).forEach(([y, c]) => { groups[cat].byYear[y] = (groups[cat].byYear[y] || 0) + (c || 0); });
      }
    });
    return groups;
  }

  function classifyGroupTrend(byYear, currentYear) {
    const complete = {};
    Object.entries(byYear).forEach(([y, c]) => { if (c != null && /^\d+$/.test(y) && Number(y) < currentYear) complete[y] = c; });
    const years = Object.keys(complete).sort();
    if (years.length < 2) return { label: "Not enough complete years yet" };
    const latestYear = years[years.length - 1];
    const latestCount = complete[latestYear];
    const baselineYears = years.slice(Math.max(0, years.length - 6), years.length - 1);
    const baselineAvg = baselineYears.reduce((s, y) => s + complete[y], 0) / (baselineYears.length || 1);
    if (!baselineAvg) return { label: latestCount > 0 ? "New records after a baseline of none" : "No records yet" };
    const pct = Math.round(((latestCount - baselineAvg) / baselineAvg) * 100);
    if (pct <= -25) return { label: `Down ${Math.abs(pct)}% vs the ${baselineYears.length}-year average` };
    if (pct >= 50) return { label: `Up ${pct}% vs the ${baselineYears.length}-year average` };
    return { label: "Broadly stable" };
  }

  function renderGroups() {
    const grid = document.getElementById("groupsGrid");
    grid.innerHTML = "";
    if (!state.occData || !state.occData.generatedAt) {
      grid.innerHTML = `<p class="no-results">Group charts will appear here once the first automated survey has run.</p>`;
      return;
    }
    const groups = buildGroupAggregates();
    const currentYear = state.summary.currentYear || new Date().getFullYear();
    Object.keys(groups).sort().forEach((groupName) => {
      const g = groups[groupName];
      const trend = classifyGroupTrend(g.byYear, currentYear);
      const color = GROUP_PALETTE[groupName] || DEFAULT_COLOR;
      const card = document.createElement("div");
      card.className = "specimen-card group-card";
      card.innerHTML = `
        <h3>${escapeHtml(groupName)}</h3>
        <span class="group-meta">${g.speciesCount} species tracked &middot; ${g.totalRecords.toLocaleString()} NI records</span>
        <div class="group-chart-wrap"></div>
        <p class="group-trend-label">${escapeHtml(trend.label)}</p>
      `;
      grid.appendChild(card);
      const series = yearsAndValues(g.byYear, 15);
      renderBarChart(card.querySelector(".group-chart-wrap"), series.labels, series.values, { color, currentYear, height: 190 });
    });
  }

  // ---------------- Pest & pathogen watch ----------------

  function renderRiskWatch() {
    const grid = document.getElementById("riskGrid");
    grid.innerHTML = "";
    const riskSpecies = (state.config.species || []).filter((sp) => sp.riskStatus);
    if (!riskSpecies.length) { grid.innerHTML = `<p class="no-results">No pest or pathogen entries configured yet.</p>`; return; }
    riskSpecies.forEach((sp) => {
      const rec = (state.summary.species && state.summary.species[sp.scientificName]) || {};
      const trend = rec.shortTermTrend;
      const isWatch = !!sp.invasiveAlert;
      const card = document.createElement("button");
      card.type = "button";
      card.className = `specimen-card risk-card ${isWatch ? "watch-species tone-alert" : "tone-neutral"}`;
      card.innerHTML = `
        <h3>${escapeHtml(sp.commonName)}</h3>
        <span class="sci-name">${escapeHtml(sp.scientificName)}</span>
        <span class="risk-status">${escapeHtml(sp.riskStatus)}</span>
        <p class="risk-detect-line">${trend ? escapeHtml(trend.label) : "No occurrence data yet"}</p>
      `;
      card.addEventListener("click", () => showSpeciesDetail(sp.scientificName));
      grid.appendChild(card);
    });
  }

  // ---------------- Category browser (with sparklines) ----------------

  function statusLineFor(name) {
    const rec = state.summary && state.summary.species && state.summary.species[name];
    if (!rec) return "No data yet";
    if (rec.shortTermTrend) return rec.shortTermTrend.label;
    if (rec.sequenceTrend) return rec.sequenceTrend.label;
    return "No data yet";
  }
  function toneForCard(name) {
    const rec = state.summary && state.summary.species && state.summary.species[name];
    if (!rec || !rec.shortTermTrend) return "tone-neutral";
    return toneClass(rec.shortTermTrend.status);
  }

  function buildSpeciesCard(sp) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = `specimen-card species-card ${toneForCard(sp.scientificName)}`;
    card.dataset.name = sp.scientificName;
    card.innerHTML = `
      <h3>${escapeHtml(sp.commonName)}</h3>
      <span class="sci-name">${escapeHtml(sp.scientificName)}</span>
      <div class="card-sparkline"></div>
      <span class="card-status">${escapeHtml(statusLineFor(sp.scientificName))}</span>
    `;
    card.addEventListener("click", () => showSpeciesDetail(sp.scientificName));
    const occ = state.occData.species && state.occData.species[sp.scientificName];
    const series = yearsAndValues((occ && occ.byYear) || {}, 10);
    renderSparkline(card.querySelector(".card-sparkline"), series.labels, series.values, GROUP_PALETTE[sp.category] || DEFAULT_COLOR);
    return card;
  }

  function renderCategoryBrowser(filterFn) {
    const container = document.getElementById("categoryBrowser");
    container.innerHTML = "";
    if (!state.config) return;
    const bySpeciesFilter = filterFn || (() => true);
    const categories = [];
    const bucket = {};
    state.config.species.forEach((sp) => {
      if (!bySpeciesFilter(sp)) return;
      if (!bucket[sp.category]) { bucket[sp.category] = []; categories.push(sp.category); }
      bucket[sp.category].push(sp);
    });
    if (!categories.length) {
      container.innerHTML = `<p class="no-results">No matches in the record. Try a different name, e.g. &lsquo;hare&rsquo; or &lsquo;Lepus&rsquo;.</p>`;
      return;
    }
    categories.forEach((cat) => {
      const group = document.createElement("div");
      group.className = "category-group";
      const heading = document.createElement("p");
      heading.className = "category-label";
      heading.textContent = cat;
      const grid = document.createElement("div");
      grid.className = "species-grid";
      bucket[cat].forEach((sp) => grid.appendChild(buildSpeciesCard(sp)));
      group.appendChild(heading);
      group.appendChild(grid);
      container.appendChild(group);
    });
  }

  function setupSearch() {
    const input = document.getElementById("speciesSearch");
    input.addEventListener("input", () => {
      const q = input.value.trim().toLowerCase();
      if (!q) { renderCategoryBrowser(); return; }
      renderCategoryBrowser((sp) => sp.commonName.toLowerCase().includes(q) || sp.scientificName.toLowerCase().includes(q));
    });
  }

  // ---------------- Compare species ----------------

  function renderCompareTabs() {
    const tabs = document.getElementById("compareTabs");
    const categories = [...new Set((state.config.species || []).map((s) => s.category))].sort();
    tabs.innerHTML = "";
    categories.forEach((cat) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "compare-tab" + (cat === state.compareGroup ? " active" : "");
      btn.textContent = cat;
      btn.addEventListener("click", () => selectCompareGroup(cat));
      tabs.appendChild(btn);
    });
  }

  function selectCompareGroup(cat) {
    state.compareGroup = cat;
    const speciesInGroup = state.config.species.filter((s) => s.category === cat);
    const withTotals = speciesInGroup.map((s) => ({ sp: s, total: ((state.occData.species && state.occData.species[s.scientificName]) || {}).totalRecords || 0 }));
    withTotals.sort((a, b) => b.total - a.total);
    state.compareSelected = new Set(withTotals.slice(0, 3).map((x) => x.sp.scientificName));
    renderCompareTabs();
    renderCompareChips();
    renderCompareChartAndLegend();
  }

  function renderCompareChips() {
    const container = document.getElementById("compareChips");
    container.innerHTML = "";
    if (!state.compareGroup) return;
    const speciesInGroup = state.config.species.filter((s) => s.category === state.compareGroup);
    speciesInGroup.forEach((sp, i) => {
      const chip = document.createElement("button");
      chip.type = "button";
      const selected = state.compareSelected.has(sp.scientificName);
      const color = COMPARE_PALETTE[i % COMPARE_PALETTE.length];
      chip.className = "compare-chip" + (selected ? " selected" : "");
      if (selected) chip.style.color = color;
      chip.innerHTML = `<span class="swatch" style="background:${selected ? color : "transparent"}"></span>${escapeHtml(sp.commonName)}`;
      chip.addEventListener("click", () => {
        if (state.compareSelected.has(sp.scientificName)) state.compareSelected.delete(sp.scientificName);
        else state.compareSelected.add(sp.scientificName);
        renderCompareChips();
        renderCompareChartAndLegend();
      });
      container.appendChild(chip);
    });
  }

  function renderCompareChartAndLegend() {
    const emptyNote = document.getElementById("compareEmptyNote");
    const wrap = document.getElementById("compareChartWrap");
    const legend = document.getElementById("compareLegend");
    legend.innerHTML = "";

    if (!state.compareSelected.size) {
      emptyNote.hidden = false;
      wrap.innerHTML = "";
      return;
    }
    emptyNote.hidden = true;

    const speciesInGroup = state.config.species.filter((s) => s.category === state.compareGroup);
    const allYears = new Set();
    speciesInGroup.forEach((sp) => {
      if (!state.compareSelected.has(sp.scientificName)) return;
      const occ = state.occData.species && state.occData.species[sp.scientificName];
      Object.keys((occ && occ.byYear) || {}).forEach((y) => allYears.add(y));
    });
    const years = [...allYears].sort().slice(-15);

    const series = [];
    speciesInGroup.forEach((sp, i) => {
      const selected = state.compareSelected.has(sp.scientificName);
      const occ = state.occData.species && state.occData.species[sp.scientificName];
      const byYear = (occ && occ.byYear) || {};
      series.push({
        label: sp.commonName,
        color: COMPARE_PALETTE[i % COMPARE_PALETTE.length],
        values: years.map((y) => (byYear[y] != null ? byYear[y] : null)),
        visible: selected,
      });
    });

    renderMultiLineChart(wrap, years, series, { height: 320 });

    series.forEach((s) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "compare-legend-item" + (s.visible ? "" : " muted");
      item.innerHTML = `<span class="swatch" style="background:${s.color}"></span>${escapeHtml(s.label)}`;
      item.addEventListener("click", () => {
        const sp = speciesInGroup.find((x) => x.commonName === s.label);
        if (!sp) return;
        if (state.compareSelected.has(sp.scientificName)) state.compareSelected.delete(sp.scientificName);
        else state.compareSelected.add(sp.scientificName);
        renderCompareChips();
        renderCompareChartAndLegend();
      });
      legend.appendChild(item);
    });
  }

  // ---------------- Species detail ----------------

  function statValueClass(status) {
    if (status === "significant_decline" || status === "biosecurity_alert" || status === "declining") return "tone-decline";
    if (status === "moderate_decline") return "tone-moderate";
    if (status === "notable_increase" || status === "increase_from_zero" || status === "improving") return "tone-increase";
    return "";
  }

  function setBrowseVisible(visible) {
    [".signal-section", ".groups-section", ".compare-section", ".risk-section", ".alerts-section", ".search-section"].forEach((sel) => {
      document.querySelector(sel).hidden = !visible;
    });
    document.getElementById("categoryBrowser").hidden = !visible;
  }

  function showSpeciesDetail(scientificName) {
    const sp = state.config.species.find((s) => s.scientificName === scientificName);
    if (!sp) return;
    const rec = (state.summary.species && state.summary.species[scientificName]) || {};
    const shortTrend = rec.shortTermTrend;
    const longTrend = rec.longTermTrend;
    const seqTrend = rec.sequenceTrend;

    setBrowseVisible(false);
    const detail = document.getElementById("speciesDetail");
    detail.hidden = false;

    const occByYear = (state.occData && state.occData.species && state.occData.species[scientificName] && state.occData.species[scientificName].byYear) || {};
    const seqByYear = (state.seqData && state.seqData.species && state.seqData.species[scientificName] && state.seqData.species[scientificName].byYear) || {};

    const content = document.getElementById("speciesDetailContent");
    content.innerHTML = `
      <div class="specimen-card detail-card">
        <div class="detail-heading">
          <span class="cat-tag">${escapeHtml(sp.category)}</span>
          <h2>${escapeHtml(sp.commonName)}</h2>
          <span class="sci-name">${escapeHtml(sp.scientificName)}</span>
        </div>

        <div class="stat-row">
          <div class="stat-box"><div class="stat-label">Total NI records (GBIF)</div><div class="stat-value">${rec.totalRecords != null ? rec.totalRecords.toLocaleString() : "—"}</div></div>
          <div class="stat-box"><div class="stat-label">Short-term (vs 5-yr avg)</div><div class="stat-value ${shortTrend ? statValueClass(shortTrend.status) : ""}">${shortTrend && shortTrend.pctChange != null ? (shortTrend.pctChange > 0 ? "+" : "") + shortTrend.pctChange + "%" : "—"}</div></div>
          <div class="stat-box"><div class="stat-label">Long-term signal</div><div class="stat-value ${longTrend ? statValueClass(longTrend.status) : ""}">${longTrend && longTrend.status !== "insufficient_data" ? (longTrend.status === "improving" ? "Improving" : longTrend.status === "declining" ? "Declining" : "No change") : "—"}</div></div>
          <div class="stat-box"><div class="stat-label">Total GenBank sequences</div><div class="stat-value">${rec.totalSequences != null ? rec.totalSequences.toLocaleString() : "—"}</div></div>
        </div>

        <p class="note-line">${shortTrend ? escapeHtml(shortTrend.label) : "No short-term trend yet."}${longTrend && longTrend.status !== "insufficient_data" ? " · " + escapeHtml(longTrend.label) : ""}${sp.note ? " · " + escapeHtml(sp.note) : ""}${sp.riskStatus ? " · " + escapeHtml(sp.riskStatus) : ""}</p>

        <div class="chart-block">
          <h3>Recorded observations per year</h3>
          <p class="chart-caption">Northern Ireland, GBIF. The final bar is the current year to date. Hover any bar for the exact count.</p>
          <div class="chart-wrap" id="occChartWrap"></div>
        </div>

        <div class="chart-block">
          <h3>GenBank sequences added per year</h3>
          <p class="chart-caption">${seqTrend ? escapeHtml(seqTrend.label) : "No sequence trend available yet."}${rec.niOriginSequences != null ? ` · ~${rec.niOriginSequences} sequence(s) with Northern Ireland in their metadata (approximate)` : ""}</p>
          <div class="chart-wrap" id="seqChartWrap"></div>
        </div>
      </div>
    `;

    const currentYear = state.summary.currentYear || new Date().getFullYear();
    const occSeries = yearsAndValues(occByYear, 15);
    const seqSeries = yearsAndValues(seqByYear, 15);
    renderBarChart(document.getElementById("occChartWrap"), occSeries.labels, occSeries.values, { color: GROUP_PALETTE[sp.category] || DEFAULT_COLOR, currentYear, height: 220 });
    renderBarChart(document.getElementById("seqChartWrap"), seqSeries.labels, seqSeries.values, { color: "#D9932E", currentYear, height: 220 });

    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function backToBrowse() {
    document.getElementById("speciesDetail").hidden = true;
    setBrowseVisible(true);
  }

  // ---------------- Boot ----------------

  function bestDefaultCompareGroup() {
    const groups = buildGroupAggregates();
    const names = Object.keys(groups);
    if (!names.length) return null;
    names.sort((a, b) => (groups[b].totalRecords - groups[a].totalRecords) || a.localeCompare(b));
    return names[0];
  }

  async function init() {
    document.getElementById("backToBrowse").addEventListener("click", backToBrowse);

    const [config, summary, occData, seqData] = await Promise.all([
      fetchJson("species-config.json", { species: [], boundary: {} }),
      fetchJson("data/summary.json", { generatedAt: null, speciesCount: 0, overview: { improving: 0, declining: 0, stable: 0 }, alerts: [], species: {} }),
      fetchJson("data/occurrences.json", { generatedAt: null, species: {} }),
      fetchJson("data/sequences.json", { generatedAt: null, species: {} }),
    ]);

    state.config = config;
    state.summary = summary;
    state.occData = occData;
    state.seqData = seqData;

    document.getElementById("lastUpdated").textContent = formatUpdated(summary.generatedAt);
    document.getElementById("pendingBanner").hidden = !!summary.generatedAt && summary.speciesCount > 0;

    renderKPIs();
    renderSignal();
    renderGroups();
    renderRiskWatch();
    renderAlerts();
    renderCategoryBrowser();
    setupSearch();

    if (occData.generatedAt) {
      const defaultGroup = bestDefaultCompareGroup();
      if (defaultGroup) selectCompareGroup(defaultGroup);
    } else {
      renderCompareTabs();
      document.getElementById("compareEmptyNote").hidden = false;
      document.getElementById("compareEmptyNote").textContent = "Compare charts will be available once the first automated survey has run.";
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
