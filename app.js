(function () {
  "use strict";

  const state = {
    config: null,
    summary: null,
    occData: null,
    seqData: null,
    activeChart1: null,
    activeChart2: null,
  };

  const css = getComputedStyle(document.documentElement);
  const COLORS = {
    green: css.getPropertyValue("--green").trim() || "#3B6B4F",
    greenDeep: css.getPropertyValue("--green-deep").trim() || "#24463A",
    amber: css.getPropertyValue("--amber").trim() || "#D9932E",
    amberDeep: css.getPropertyValue("--amber-deep").trim() || "#A9691B",
    brick: css.getPropertyValue("--brick").trim() || "#9C3F2C",
    ink: css.getPropertyValue("--ink").trim() || "#2A2420",
    inkSoft: css.getPropertyValue("--ink-soft").trim() || "#5B5148",
  };

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
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
      <span class="card-status">${escapeHtml(statusLineFor(sp.scientificName))}</span>
    `;
    card.addEventListener("click", () => showSpeciesDetail(sp.scientificName));
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
      renderCategoryBrowser((sp) =>
        sp.commonName.toLowerCase().includes(q) || sp.scientificName.toLowerCase().includes(q)
      );
    });
  }

  function yearsAndValues(byYear, backYears) {
    const years = Object.keys(byYear || {}).sort();
    const trimmed = backYears ? years.slice(-backYears) : years;
    return { labels: trimmed, values: trimmed.map((y) => byYear[y] ?? 0) };
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

  function showSpeciesDetail(scientificName) {
    const sp = state.config.species.find((s) => s.scientificName === scientificName);
    if (!sp) return;
    const rec = (state.summary.species && state.summary.species[scientificName]) || {};
    const occTrend = rec.occurrenceTrend;
    const seqTrend = rec.sequenceTrend;

    document.querySelector(".alerts-section").hidden = true;
    document.querySelector(".search-section").hidden = true;
    document.getElementById("categoryBrowser").hidden = true;
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

        <p class="note-line">${occTrend ? escapeHtml(occTrend.label) : "No occurrence trend available yet."}${sp.note ? " · " + escapeHtml(sp.note) : ""}</p>

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
    document.querySelector(".alerts-section").hidden = false;
    document.querySelector(".search-section").hidden = false;
    document.getElementById("categoryBrowser").hidden = false;
    destroyCharts();
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

    renderAlerts();
    renderCategoryBrowser();
    setupSearch();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
