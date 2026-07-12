(function () {
  "use strict";

  const state = {
    config: null,
    summary: null,
    occData: null,
    seqData: null,
    activeChart1: null,
    activeChart2: null,
    groupCharts: [],
    sparklineCharts: [],
    compareGroup: null,
    compareSelected: new Set(),
    compareChart: null,
  };

  const GROUP_PALETTE = {
    Invertebrates: "#3B6B4F",
    Mammals: "#A9691B",
    Fungi: "#7A5C3E",
    Birds: "#2E6E8E",
    Bacteria: "#8E4A5A",
    Fish: "#2E7D7B",
    Amphibians: "#5B7A2E",
  };
  const DEFAULT_GROUP_COLOR = "#5B5148";
  const COMPARE_PALETTE = ["#3B6B4F", "#A9691B", "#2E6E8E", "#9C3F2C", "#7A5C3E", "#5B7A2E", "#8E4A5A", "#D9932E", "#24463A", "#5B5148"];

  const css = getComputedStyle(document.documentElement);
  const COLORS = {
    green: css.getPropertyValue("--green").trim() || "#3B6B4F",
    amber: css.getPropertyValue("--amber").trim() || "#D9932E",
    ink: css.getPropertyValue("--ink").trim() || "#2A2420",
    inkSoft: css.getPropertyValue("--ink-soft").trim() || "#5B5148",
  };

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function slug(name) {
    return String(name).replace(/[^a-zA-Z0-9]/g, "_");
  }

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
      case "significant_decline":
      case "biosecurity_alert":
        return "tone-decline";
      case "moderate_decline":
        return "tone-moderate";
      case "notable_increase":
      case "increase_from_zero":
        return "tone-increase";
      default:
        return "tone-neutral";
    }
  }

  function severityToneClass(severity) {
    return severity === "high" ? "tone-decline" : "tone-moderate";
  }

  function formatUpdated(iso) {
    if (!iso) return "Awaiting first automated update.";
    try {
      const d = new Date(iso);
      return `Record last updated ${d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })} (${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} UTC)`;
    } catch {
      return `Record last updated ${iso}`;
    }
  }

  function yearsAndValues(byYear, backYears) {
    const years = Object.keys(byYear || {}).sort();
    const trimmed = backYears ? years.slice(-backYears) : years;
    return { labels: trimmed, values: trimmed.map((y) => byYear[y] ?? 0) };
  }

  function renderKPIs() {
    const kpi = document.getElementById("kpiStrip");
    const species = state.config.species || [];
    const groupsCount = new Set(species.map((s) => s.category)).size;
    const alertsCount = (state.summary.alerts || []).length;
    const totalRecords = Object.values((state.occData && state.occData.species) || {}).reduce(
      (sum, r) => sum + (r.totalRecords || 0), 0
    );
    kpi.innerHTML = `
      <div class="kpi-box"><div class="kpi-value">${species.length}</div><div class="kpi-label">species tracked</div></div>
      <div class="kpi-box"><div class="kpi-value">${groupsCount}</div><div class="kpi-label">taxonomic groups</div></div>
      <div class="kpi-box"><div class="kpi-value">${totalRecords.toLocaleString()}</div><div class="kpi-label">NI records logged</div></div>
      <div class="kpi-box"><div class="kpi-value">${alertsCount}</div><div class="kpi-label">active alerts</div></div>
    `;
  }

  function renderAlerts() {
    const rail = document.getElementById("alertsRail");
    const emptyNote = document.getElementById("alertsEmptyNote");
    const alerts = (state.summary && state.summary.alerts) || [];

    rail.querySelectorAll(".alert-card").forEach((n) => n.remove());

    if (!alerts.length) {
      emptyNote.textContent = state.summary.generatedAt
        ? "No significant changes flagged in the current dataset."
        : "Alerts will appear here once the first automated survey has run.";
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

  function buildGroupAggregates() {
    const groups = {};
    (state.config.species || []).forEach((sp) => {
      const cat = sp.category || "Other";
      if (!groups[cat]) groups[cat] = { byYear: {}, totalRecords: 0, speciesCount: 0 };
      groups[cat].speciesCount += 1;
      const occ = state.occData.species && state.occData.species[sp.scientificName];
      if (occ) {
        groups[cat].totalRecords += occ.totalRecords || 0;
        Object.entries(occ.byYear || {}).forEach(([y, c]) => {
          groups[cat].byYear[y] = (groups[cat].byYear[y] || 0) + (c || 0);
        });
      }
    });
    return groups;
  }

  function classifyGroupTrend(byYear, currentYear) {
    const complete = {};
    Object.entries(byYear).forEach(([y, c]) => {
      if (c != null && /^\d+$/.test(y) && Number(y) < currentYear) complete[y] = c;
    });
    const years = Object.keys(complete).sort();
    if (years.length < 2) return { label: "Not enough complete years yet", pctChange: null };

    const latestYear = years[years.length - 1];
    const latestCount = complete[latestYear];
    const baselineYears = years.slice(Math.max(0, years.length - 6), years.length - 1);
    const baselineAvg = baselineYears.reduce((s, y) => s + complete[y], 0) / (baselineYears.length || 1);

    if (!baselineAvg) {
      return latestCount > 0 ? { label: "New records after a baseline of none", pctChange: null } : { label: "No records yet", pctChange: null };
    }
    const pct = Math.round(((latestCount - baselineAvg) / baselineAvg) * 100);
    let label;
    if (pct <= -25) label = `Down ${Math.abs(pct)}% vs the ${baselineYears.length}-year average`;
    else if (pct >= 50) label = `Up ${pct}% vs the ${baselineYears.length}-year average`;
    else label = "Broadly stable";
    return { label, pctChange: pct };
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
    state.groupCharts.forEach((c) => c.destroy());
    state.groupCharts = [];

    Object.keys(groups).sort().forEach((groupName, idx) => {
      const g = groups[groupName];
      const trend = classifyGroupTrend(g.byYear, currentYear);
      const color = GROUP_PALETTE[groupName] || DEFAULT_GROUP_COLOR;

      const card = document.createElement("div");
      card.className = "specimen-card group-card";
      const canvasId = `groupChart_${idx}`;
      card.innerHTML = `
        <h3>${escapeHtml(groupName)}</h3>
        <span class="group-meta">${g.speciesCount} species tracked &middot; ${g.totalRecords.toLocaleString()} NI records</span>
        <div class="group-chart-wrap"><canvas id="${canvasId}"></canvas></div>
        <p class="group-trend-label">${escapeHtml(trend.label)}</p>
      `;
      grid.appendChild(card);

      const series = yearsAndValues(g.byYear, 15);
      const cyStr = String(currentYear);
      if (window.Chart) {
        const chart = new Chart(document.getElementById(canvasId), {
          type: "bar",
          data: {
            labels: series.labels,
            datasets: [{
              data: series.values,
              backgroundColor: series.labels.map((y) => (y === cyStr ? color + "59" : color)),
              borderRadius: 2,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false }, tooltip: { titleFont: { family: "IBM Plex Mono" }, bodyFont: { family: "IBM Plex Mono" } } },
            scales: {
              x: { ticks: { font: { family: "IBM Plex Mono", size: 9 }, color: COLORS.inkSoft, maxRotation: 0, autoSkip: true, maxTicksLimit: 6 }, grid: { display: false } },
              y: { beginAtZero: true, ticks: { font: { family: "IBM Plex Mono", size: 9 }, color: COLORS.inkSoft, maxTicksLimit: 4 }, grid: { color: "rgba(42,36,32,0.08)" } },
            },
          },
        });
        state.groupCharts.push(chart);
      }
    });
  }

  function renderRiskWatch() {
    const grid = document.getElementById("riskGrid");
    grid.innerHTML = "";
    const riskSpecies = (state.config.species || []).filter((sp) => sp.riskStatus);
    if (!riskSpecies.length) {
      grid.innerHTML = `<p class="no-results">No pest or pathogen entries configured yet.</p>`;
      return;
    }
    riskSpecies.forEach((sp) => {
      const rec = (state.summary.species && state.summary.species[sp.scientificName]) || {};
      const occTrend = rec.occurrenceTrend;
      const isWatch = !!sp.invasiveAlert;
      const card = document.createElement("button");
      card.type = "button";
      card.className = `specimen-card risk-card ${isWatch ? "watch-species tone-alert" : "tone-neutral"}`;
      card.innerHTML = `
        <h3>${escapeHtml(sp.commonName)}</h3>
        <span class="sci-name">${escapeHtml(sp.scientificName)}</span>
        <span class="risk-status">${escapeHtml(sp.riskStatus)}</span>
        <p class="risk-detect-line">${occTrend ? escapeHtml(occTrend.label) : "No occurrence data yet"}</p>
      `;
      card.addEventListener("click", () => showSpeciesDetail(sp.scientificName));
      grid.appendChild(card);
    });
  }

  function statusLineFor(name) {
    const rec = state.summary && state.summary.species && state.summary.species[name];
    if (!rec) return "No data yet";
    if (rec.occurrenceTrend) return rec.occurrenceTrend.label;
    if (rec.sequenceTrend) return rec.sequenceTrend.label;
    return "No data yet";
  }

  function toneForCard(name) {
    const rec = state.summary && state.summary.species && state.summary.species[name];
    if (!rec || !rec.occurrenceTrend) return "tone-neutral";
    return toneClass(rec.occurrenceTrend.status);
  }

  function buildSpeciesCard(sp) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = `specimen-card species-card ${toneForCard(sp.scientificName)}`;
    card.dataset.name = sp.scientificName;
    card.innerHTML = `
      <h3>${escapeHtml(sp.commonName)}</h3>
      <span class="sci-name">${escapeHtml(sp.scientificName)}</span>
      <div class="card-sparkline"><canvas id="spark_${slug(sp.scientificName)}"></canvas></div>
      <span class="card-status">${escapeHtml(statusLineFor(sp.scientificName))}</span>
    `;
    card.addEventListener("click", () => showSpeciesDetail(sp.scientificName));
    return card;
  }

  function createSparkline(sp) {
    const canvas = document.getElementById(`spark_${slug(sp.scientificName)}`);
    if (!canvas || !window.Chart) return;
    const occ = state.occData.species && state.occData.species[sp.scientificName];
    const series = yearsAndValues((occ && occ.byYear) || {}, 10);
    if (!series.values.some((v) => v > 0)) return;
    const color = GROUP_PALETTE[sp.category] || DEFAULT_GROUP_COLOR;
    const chart = new Chart(canvas, {
      type: "line",
      data: { labels: series.labels, datasets: [{ data: series.values, borderColor: color, backgroundColor: "transparent", borderWidth: 1.5, pointRadius: 0, tension: 0.3 }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: { x: { display: false }, y: { display: false } },
      },
    });
    state.sparklineCharts.push(chart);
  }

  function renderCategoryBrowser(filterFn) {
    const container = document.getElementById("categoryBrowser");
    container.innerHTML = "";
    state.sparklineCharts.forEach((c) => c.destroy());
    state.sparklineCharts = [];
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

    categories.forEach((cat) => bucket[cat].forEach((sp) => createSparkline(sp)));
  }

  function setupSearch() {
    const input = document.getElementById("speciesSearch");
    input.addEventListener("input", () => {
      const q = input.value.trim().toLowerCase();
      if (!q) { renderCategoryBrowser(); return; }
      renderCategoryBrowser((sp) =>
        sp.commonName.toLowerCase().includes(q) || sp.scientificName.toLowerCase().includes(q)
      );
    });
  }

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
    const withTotals = speciesInGroup.map((s) => ({
      sp: s,
      total: ((state.occData.species && state.occData.species[s.scientificName]) || {}).totalRecords || 0,
    }));
    withTotals.sort((a, b) => b.total - a.total);
    state.compareSelected = new Set(withTotals.slice(0, 3).map((x) => x.sp.scientificName));
    renderCompareTabs();
    renderCompareChips();
    renderCompareChart();
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
        renderCompareChart();
      });
      container.appendChild(chip);
    });
  }

  function renderCompareChart() {
    const emptyNote = document.getElementById("compareEmptyNote");
    const canvas = document.getElementById("compareChart");
    if (state.compareChart) { state.compareChart.destroy(); state.compareChart = null; }
    if (!state.compareSelected.size) {
      emptyNote.hidden = false;
      canvas.style.display = "none";
      return;
    }
    emptyNote.hidden = true;
    canvas.style.display = "block";

    const speciesInGroup = state.config.species.filter((s) => s.category === state.compareGroup);
    const allYears = new Set();
    speciesInGroup.forEach((sp) => {
      if (!state.compareSelected.has(sp.scientificName)) return;
      const occ = state.occData.species && state.occData.species[sp.scientificName];
      Object.keys((occ && occ.byYear) || {}).forEach((y) => allYears.add(y));
    });
    const years = [...allYears].sort().slice(-15);

    const datasets = [];
    speciesInGroup.forEach((sp, i) => {
      if (!state.compareSelected.has(sp.scientificName)) return;
      const occ = state.occData.species && state.occData.species[sp.scientificName];
      const byYear = (occ && occ.byYear) || {};
      const color = COMPARE_PALETTE[i % COMPARE_PALETTE.length];
      datasets.push({
        label: sp.commonName,
        data: years.map((y) => (byYear[y] != null ? byYear[y] : null)),
        borderColor: color,
        backgroundColor: color,
        spanGaps: true,
        tension: 0.25,
        pointRadius: 2,
      });
    });

    if (window.Chart) {
      state.compareChart = new Chart(canvas, {
        type: "line",
        data: { labels: years, datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { position: "bottom", labels: { color: COLORS.ink, font: { family: "Public Sans", size: 12 } } },
            tooltip: { titleFont: { family: "IBM Plex Mono" }, bodyFont: { family: "IBM Plex Mono" } },
          },
          scales: {
            x: { ticks: { font: { family: "IBM Plex Mono", size: 11 }, color: COLORS.inkSoft }, grid: { display: false } },
            y: { beginAtZero: true, ticks: { font: { family: "IBM Plex Mono", size: 11 }, color: COLORS.inkSoft }, grid: { color: "rgba(42,36,32,0.08)" } },
          },
        },
      });
    }
  }

  function destroyCharts() {
    if (state.activeChart1) { state.activeChart1.destroy(); state.activeChart1 = null; }
    if (state.activeChart2) { state.activeChart2.destroy(); state.activeChart2 = null; }
  }

  function statValueClass(status) {
    if (status === "significant_decline" || status === "biosecurity_alert") return "tone-decline";
    if (status === "moderate_decline") return "tone-moderate";
    if (status === "notable_increase" || status === "increase_from_zero") return "tone-increase";
    return "";
  }

  function setBrowseVisible(visible) {
    document.querySelector(".groups-section").hidden = !visible;
    document.querySelector(".compare-section").hidden = !visible;
    document.querySelector(".risk-section").hidden = !visible;
    document.querySelector(".alerts-section").hidden = !visible;
    document.querySelector(".search-section").hidden = !visible;
    document.getElementById("categoryBrowser").hidden = !visible;
  }

  function showSpeciesDetail(scientificName) {
    const sp = state.config.species.find((s) => s.scientificName === scientificName);
    if (!sp) return;
    const rec = (state.summary.species && state.summary.species[scientificName]) || {};
    const occTrend = rec.occurrenceTrend;
    const seqTrend = rec.sequenceTrend;

    setBrowseVisible(false);
    const detail = document.getElementById("speciesDetail");
    detail.hidden = false;
    destroyCharts();

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
          <div class="stat-box">
            <div class="stat-label">Total NI records (GBIF)</div>
            <div class="stat-value">${rec.totalRecords != null ? rec.totalRecords.toLocaleString() : "—"}</div>
          </div>
          <div class="stat-box">
            <div class="stat-label">Total GenBank sequences</div>
            <div class="stat-value">${rec.totalSequences != null ? rec.totalSequences.toLocaleString() : "—"}</div>
          </div>
          <div class="stat-box">
            <div class="stat-label">Latest complete year vs baseline</div>
            <div class="stat-value ${occTrend ? statValueClass(occTrend.status) : ""}">${occTrend && occTrend.pctChange != null ? (occTrend.pctChange > 0 ? "+" : "") + occTrend.pctChange + "%" : "—"}</div>
          </div>
        </div>

        <p class="note-line">${occTrend ? escapeHtml(occTrend.label) : "No occurrence trend available yet."}${sp.note ? " · " + escapeHtml(sp.note) : ""}${sp.riskStatus ? " · " + escapeHtml(sp.riskStatus) : ""}</p>

        <div class="chart-block">
          <h3>Recorded observations per year</h3>
          <p class="chart-caption">Northern Ireland, GBIF. The final bar is the current year to date.</p>
          <div class="chart-wrap"><canvas id="occChart"></canvas></div>
        </div>

        <div class="chart-block">
          <h3>GenBank sequences added per year</h3>
          <p class="chart-caption">${seqTrend ? escapeHtml(seqTrend.label) : "No sequence trend available yet."}${rec.niOriginSequences != null ? ` · ~${rec.niOriginSequences} sequence(s) with Northern Ireland in their metadata (approximate)` : ""}</p>
          <div class="chart-wrap"><canvas id="seqChart"></canvas></div>
        </div>
      </div>
    `;

    const occSeries = yearsAndValues(occByYear, 15);
    const seqSeries = yearsAndValues(seqByYear, 15);
    const currentYear = String(state.summary.currentYear || new Date().getFullYear());

    if (window.Chart) {
      const occCtx = document.getElementById("occChart");
      state.activeChart1 = new Chart(occCtx, {
        type: "bar",
        data: {
          labels: occSeries.labels,
          datasets: [{
            data: occSeries.values,
            backgroundColor: occSeries.labels.map((y) => (y === currentYear ? "rgba(59,107,79,0.35)" : COLORS.green)),
            borderRadius: 2,
          }],
        },
        options: chartOptions(),
      });

      const seqCtx = document.getElementById("seqChart");
      state.activeChart2 = new Chart(seqCtx, {
        type: "bar",
        data: {
          labels: seqSeries.labels,
          datasets: [{
            data: seqSeries.values,
            backgroundColor: seqSeries.labels.map((y) => (y === currentYear ? "rgba(217,147,46,0.35)" : COLORS.amber)),
            borderRadius: 2,
          }],
        },
        options: chartOptions(),
      });
    }

    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function chartOptions() {
    return {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { titleFont: { family: "IBM Plex Mono" }, bodyFont: { family: "IBM Plex Mono" } } },
      scales: {
        x: { ticks: { font: { family: "IBM Plex Mono", size: 11 }, color: COLORS.inkSoft }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { font: { family: "IBM Plex Mono", size: 11 }, color: COLORS.inkSoft }, grid: { color: "rgba(42,36,32,0.08)" } },
      },
    };
  }

  function backToBrowse() {
    document.getElementById("speciesDetail").hidden = true;
    setBrowseVisible(true);
    destroyCharts();
  }

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
      fetchJson("data/summary.json", { generatedAt: null, speciesCount: 0, alerts: [], species: {} }),
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
      document.getElementById("compareChart").style.display = "none";
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
