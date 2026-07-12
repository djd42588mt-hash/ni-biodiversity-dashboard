#!/usr/bin/env python3
"""
Reads data/occurrences.json and data/sequences.json and computes, per
species, a plain-language trend classification the frontend can display.
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

DECLINE_SIGNIFICANT = -50
DECLINE_MODERATE = -25
INCREASE_NOTABLE = 50
MIN_BASELINE_YEARS = 2
BASELINE_WINDOW = 5
SEQUENCE_STALL_YEARS = 3


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


def classify_occurrence_trend(by_year: dict, current_year: int, invasive_alert: bool):
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
        "significant_decline": f"Recorded observations down {abs(pct_change)}% vs the {len(baseline_years)}-year average",
        "moderate_decline": f"Recorded observations down {abs(pct_change)}% vs the {len(baseline_years)}-year average",
        "notable_increase": f"Recorded observations up {pct_change}% vs the {len(baseline_years)}-year average",
        "stable": "Recorded observations broadly stable",
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
        return {
            "status": "stalled",
            "label": f"No new GenBank sequences in the last {SEQUENCE_STALL_YEARS} complete years",
        }
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

    current_year = time.gmtime().tm_year
    species_summary = {}
    alerts = []

    for sp in config["species"]:
        name = sp["scientificName"]
        invasive_alert = sp.get("invasiveAlert", False)

        occ_record = occ_data.get("species", {}).get(name)
        seq_record = seq_data.get("species", {}).get(name)

        occ_trend = None
        if occ_record and not occ_record.get("error"):
            occ_trend = classify_occurrence_trend(occ_record.get("byYear", {}), current_year, invasive_alert)

        seq_trend = None
        if seq_record and not seq_record.get("error"):
            seq_trend = classify_sequence_trend(seq_record.get("byYear", {}), current_year)

        species_summary[name] = {
            "commonName": sp.get("commonName", name),
            "category": sp.get("category", "Other"),
            "occurrenceTrend": occ_trend,
            "sequenceTrend": seq_trend,
            "totalRecords": (occ_record or {}).get("totalRecords"),
            "totalSequences": (seq_record or {}).get("totalSequences"),
            "niOriginSequences": (seq_record or {}).get("niOriginTotal"),
        }

        if occ_trend and occ_trend["status"] in (
            "significant_decline", "moderate_decline", "biosecurity_alert"
        ):
            alerts.append({
                "scientificName": name,
                "commonName": sp.get("commonName", name),
                "severity": "high" if occ_trend["status"] in ("significant_decline", "biosecurity_alert") else "moderate",
                "message": occ_trend["label"],
            })

    severity_rank = {"high": 0, "moderate": 1}
    alerts.sort(key=lambda a: severity_rank.get(a["severity"], 2))

    output = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "currentYear": current_year,
        "speciesCount": len(species_summary),
        "alerts": alerts,
        "species": species_summary,
    }

    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    print(f"Analysis complete: {len(species_summary)} species, {len(alerts)} alerts.")


if __name__ == "__main__":
    main()
