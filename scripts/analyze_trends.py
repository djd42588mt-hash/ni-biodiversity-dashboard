#!/usr/bin/env python3
"""
Reads data/occurrences.json and data/sequences.json (written by the two
fetch_*.py scripts) and computes, per species, plain-language trend
classifications the frontend can display without doing any maths itself.

Key design decisions, spelled out because they affect what the dashboard is
allowed to claim:

1. Only COMPLETE calendar years are used to flag a rise/decline. The current
   in-progress year is shown on charts (clearly labelled "year to date") but
   is excluded from every % change calculation below.

2. Two trend horizons are computed, following the same short-term/long-term
   split used in the UK Biodiversity Indicators (JNCC/Defra): a SHORT-TERM
   trend (latest complete year vs the preceding ~5-year average) and a
   LONG-TERM trend (average of the earliest 3 complete years on record vs
   average of the most recent 3), classified as Improving / Declining /
   No clear change / Insufficient data - the same four-way vocabulary
   official UK biodiversity statistics use, rather than home-grown wording.

3. Occurrence-record changes are reported as changes in RECORDED observations,
   not population size. A drop can mean fewer organisms, fewer surveyors, or
   both - the dashboard says so explicitly rather than implying a population
   claim the data can't support.

4. Sequence counts are cumulative and (almost) never fall, so they get a
   different vocabulary: "stalled" / "growing" rather than "declined".

5. Species flagged invasiveAlert in species-config.json get a distinct
   biosecurity-style alert the moment ANY record appears, rather than
   needing a percent change (a move from 0 to 1 is the whole story here).

Thresholds are named constants below - tune them in one place.
"""
import json
import os
import time

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(SCRIPT_DIR)
CONFIG_PATH = os.path.join(ROOT_DIR, "species-config.json")
OCC_PATH = os.path.join(ROOT_DIR, "data", "occurrences.json")
SEQ_PATH = os.path.join(ROOT_DIR, "data", "sequences.json")
OUTPUT_PATH = os.path.join(ROOT_DIR, "data", "summary.json")

DECLINE_SIGNIFICANT = -50   # % vs baseline, short-term
DECLINE_MODERATE = -25
INCREASE_NOTABLE = 50
MIN_BASELINE_YEARS = 2
BASELINE_WINDOW = 5
SEQUENCE_STALL_YEARS = 3

LONG_TERM_MIN_YEARS = 4          # need at least this many complete years to attempt a long-term trend (lowered from 6 - too strict a threshold was silently emptying this panel)
LONG_TERM_ENDPOINT_YEARS = 2     # average this many years at each end of the record (lowered from 3 to match)
LONG_TERM_DECLINE_THRESHOLD = -25
LONG_TERM_IMPROVE_THRESHOLD = 25


def complete_years_only(by_year: dict, current_year: int):
    out = {}
    for y, c in by_year.items():
        if c is None:
            continue
        if not str(y).isdigit():
            continue
        if int(y) >= current_year:
            continue
        out[y] = c
    return out


def classify_short_term_trend(by_year: dict, current_year: int, invasive_alert: bool):
    complete = complete_years_only(by_year, current_year)
    years_sorted = sorted(complete.keys(), key=int)
    current_year_count = by_year.get(str(current_year))

    if invasive_alert:
        any_ever = sum(complete.values()) + (current_year_count or 0)
        if any_ever > 0:
            first_years = [y for y in sorted(by_year.keys(), key=int) if (by_year.get(y) or 0) > 0]
            return {
                "status": "biosecurity_alert",
                "label": f"Detected in NI records (first appearance: {first_years[0] if first_years else 'unknown'})",
                "pctChange": None,
                "latestCompleteYear": years_sorted[-1] if years_sorted else None,
                "latestCompleteYearCount": complete.get(years_sorted[-1]) if years_sorted else None,
                "currentYearToDateCount": current_year_count,
            }
        return {
            "status": "watch_no_detection",
            "label": "No NI records to date - remains on the biosecurity watch list",
            "pctChange": None,
            "latestCompleteYear": years_sorted[-1] if years_sorted else None,
            "latestCompleteYearCount": 0,
            "currentYearToDateCount": current_year_count,
        }

    if len(years_sorted) < MIN_BASELINE_YEARS:
        return {
            "status": "insufficient_data",
            "label": "Not enough complete years of data yet to assess a trend",
            "pctChange": None,
            "latestCompleteYear": years_sorted[-1] if years_sorted else None,
            "latestCompleteYearCount": complete.get(years_sorted[-1]) if years_sorted else None,
            "currentYearToDateCount": current_year_count,
        }

    latest_year = years_sorted[-1]
    latest_count = complete[latest_year]
    baseline_years = years_sorted[-(BASELINE_WINDOW + 1):-1] or years_sorted[:-1]
    baseline_values = [complete[y] for y in baseline_years]
    baseline_avg = sum(baseline_values) / len(baseline_values) if baseline_values else None

    if not baseline_avg:
        status = "increase_from_zero" if latest_count > 0 else "no_change"
        pct_change = None
    else:
        pct_change = round(((latest_count - baseline_avg) / baseline_avg) * 100)
        if pct_change <= DECLINE_SIGNIFICANT:
            status = "significant_decline"
        elif pct_change <= DECLINE_MODERATE:
            status = "moderate_decline"
        elif pct_change >= INCREASE_NOTABLE:
            status = "notable_increase"
        else:
            status = "stable"

    labels = {
        "significant_decline": f"Down {abs(pct_change)}% vs the {len(baseline_years)}-year average",
        "moderate_decline": f"Down {abs(pct_change)}% vs the {len(baseline_years)}-year average",
        "notable_increase": f"Up {pct_change}% vs the {len(baseline_years)}-year average",
        "stable": "Broadly stable vs recent years",
        "increase_from_zero": "New records after a baseline of none",
        "no_change": "No records in the baseline or latest complete year",
    }

    return {
        "status": status,
        "label": labels[status],
        "pctChange": pct_change,
        "latestCompleteYear": latest_year,
        "latestCompleteYearCount": latest_count,
        "currentYearToDateCount": current_year_count,
    }


def classify_long_term_trend(by_year: dict, current_year: int):
    """
    Compares the average of the earliest N complete years on record against
    the average of the most recent N complete years - the same idea as the
    long-term arrow in the UK Biodiversity Indicators. Uses whatever history
    GBIF actually returns, so "long-term" here means "since this dataset's
    earliest available record", not any fixed calendar baseline.
    """
    complete = complete_years_only(by_year, current_year)
    years_sorted = sorted(complete.keys(), key=int)
    if len(years_sorted) < LONG_TERM_MIN_YEARS:
        return {"status": "insufficient_data", "label": "Not enough years of history for a long-term trend", "pctChange": None, "spanYears": None}

    n = LONG_TERM_ENDPOINT_YEARS
    earliest = years_sorted[:n]
    latest = years_sorted[-n:]
    earliest_avg = sum(complete[y] for y in earliest) / len(earliest)
    latest_avg = sum(complete[y] for y in latest) / len(latest)
    span = f"{years_sorted[0]}-{years_sorted[-1]}"

    if not earliest_avg:
        status = "improving" if latest_avg > 0 else "no_clear_change"
        pct_change = None
    else:
        pct_change = round(((latest_avg - earliest_avg) / earliest_avg) * 100)
        if pct_change <= LONG_TERM_DECLINE_THRESHOLD:
            status = "declining"
        elif pct_change >= LONG_TERM_IMPROVE_THRESHOLD:
            status = "improving"
        else:
            status = "no_clear_change"

    labels = {
        "declining": f"Declining since {span} ({pct_change}%)",
        "improving": f"Improving since {span} ({'+' if pct_change and pct_change > 0 else ''}{pct_change}%)" if pct_change is not None else f"Improving since {span}",
        "no_clear_change": f"No clear change since {span}",
    }
    return {"status": status, "label": labels[status], "pctChange": pct_change, "spanYears": span}


def classify_sequence_trend(by_year: dict, current_year: int):
    complete = complete_years_only(by_year, current_year)
    years_sorted = sorted(complete.keys(), key=int)
    if len(years_sorted) < SEQUENCE_STALL_YEARS:
        return {"status": "insufficient_data", "label": "Not enough history yet"}

    recent = years_sorted[-SEQUENCE_STALL_YEARS:]
    recent_sum = sum(complete[y] for y in recent)
    earlier = years_sorted[:-SEQUENCE_STALL_YEARS]
    earlier_avg_per_year = (sum(complete[y] for y in earlier) / len(earlier)) if earlier else None

    if recent_sum == 0:
        return {"status": "stalled", "label": f"No new GenBank sequences in the last {SEQUENCE_STALL_YEARS} complete years"}
    if earlier_avg_per_year and (recent_sum / SEQUENCE_STALL_YEARS) >= earlier_avg_per_year * 2:
        return {"status": "accelerating", "label": "Sequencing activity has notably picked up recently"}
    return {"status": "steady", "label": "Sequencing activity continuing at a steady pace"}


def main():
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        config = json.load(f)
    with open(OCC_PATH, "r", encoding="utf-8") as f:
        occ_data = json.load(f)
    with open(SEQ_PATH, "r", encoding="utf-8") as f:
        seq_data = json.load(f)

    group_totals_path = os.path.join(ROOT_DIR, "data", "group_totals.json")
    group_data = {"groups": {}}
    if os.path.exists(group_totals_path):
        with open(group_totals_path, "r", encoding="utf-8") as f:
            group_data = json.load(f)

    current_year = time.gmtime().tm_year
    species_summary = {}
    alerts = []

    for sp in config["species"]:
        name = sp["scientificName"]
        invasive_alert = sp.get("invasiveAlert", False)

        occ_record = occ_data.get("species", {}).get(name)
        seq_record = seq_data.get("species", {}).get(name)

        short_trend = None
        long_trend = None
        if occ_record and not occ_record.get("error"):
            by_year = occ_record.get("byYear", {})
            short_trend = classify_short_term_trend(by_year, current_year, invasive_alert)
            long_trend = classify_long_term_trend(by_year, current_year)

        seq_trend = None
        if seq_record and not seq_record.get("error"):
            seq_trend = classify_sequence_trend(seq_record.get("byYear", {}), current_year)

        species_summary[name] = {
            "commonName": sp.get("commonName", name),
            "category": sp.get("category", "Other"),
            "shortTermTrend": short_trend,
            "longTermTrend": long_trend,
            "sequenceTrend": seq_trend,
            "totalRecords": (occ_record or {}).get("totalRecords"),
            "totalSequences": (seq_record or {}).get("totalSequences"),
            "niOriginSequences": (seq_record or {}).get("niOriginTotal"),
        }

        if short_trend and short_trend["status"] in ("significant_decline", "moderate_decline", "biosecurity_alert"):
            alerts.append({
                "scientificName": name,
                "commonName": sp.get("commonName", name),
                "severity": "high" if short_trend["status"] in ("significant_decline", "biosecurity_alert") else "moderate",
                "message": short_trend["label"],
            })

    severity_rank = {"high": 0, "moderate": 1}
    alerts.sort(key=lambda a: severity_rank.get(a["severity"], 2))

    improving = sum(1 for s in species_summary.values() if s["longTermTrend"] and s["longTermTrend"]["status"] == "improving")
    declining = sum(1 for s in species_summary.values() if s["longTermTrend"] and s["longTermTrend"]["status"] == "declining")
    stable = sum(1 for s in species_summary.values() if s["longTermTrend"] and s["longTermTrend"]["status"] == "no_clear_change")

    # Comprehensive (all-species-in-group) trends, from fetch_gbif_groups.py's output.
    # This is deliberately separate from the curated-species figures above: it reflects
    # every recorded organism GBIF has for that taxonomic group in NI, not just the
    # ~30 species this dashboard tracks individually.
    group_trends = {}
    group_improving = group_declining = group_stable = 0
    for group_name, g in group_data.get("groups", {}).items():
        if g.get("error"):
            group_trends[group_name] = {"error": g["error"]}
            continue
        by_year = g.get("byYear", {})
        g_short = classify_short_term_trend(by_year, current_year, invasive_alert=False)
        g_long = classify_long_term_trend(by_year, current_year)
        group_trends[group_name] = {
            "shortTermTrend": g_short,
            "longTermTrend": g_long,
            "totalRecords": g.get("totalRecords", 0),
            "taxonFilter": g.get("taxonFilter"),
        }
        if g_long["status"] == "improving":
            group_improving += 1
        elif g_long["status"] == "declining":
            group_declining += 1
        elif g_long["status"] == "no_clear_change":
            group_stable += 1

    output = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "currentYear": current_year,
        "speciesCount": len(species_summary),
        "overview": {"improving": improving, "declining": declining, "stable": stable},
        "groupOverview": {"improving": group_improving, "declining": group_declining, "stable": group_stable, "groupsWithData": len(group_trends)},
        "groupTrends": group_trends,
        "alerts": alerts,
        "species": species_summary,
    }

    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    print(f"Analysis complete: {len(species_summary)} species, {len(alerts)} alerts.")
    print(f"Long-term signal: {improving} improving, {declining} declining, {stable} no clear change.")


if __name__ == "__main__":
    main()
