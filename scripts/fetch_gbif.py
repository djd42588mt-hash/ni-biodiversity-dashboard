#!/usr/bin/env python3
"""
Fetches yearly occurrence-record counts from GBIF for each tracked species,
restricted to a Northern Ireland bounding box + country=GB.
"""
import json
import os
import time
import urllib.parse
import urllib.request
import urllib.error

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(SCRIPT_DIR)
CONFIG_PATH = os.path.join(ROOT_DIR, "species-config.json")
OUTPUT_PATH = os.path.join(ROOT_DIR, "data", "occurrences.json")

GBIF_BASE = "https://api.gbif.org/v1/occurrence/search"
REQUEST_DELAY_SECONDS = 0.5
USER_AGENT = "NI-Biodiversity-Dashboard/1.0 (contact: set-your-email-in-scripts/fetch_gbif.py)"


def build_bbox_wkt(min_lat, max_lat, min_lon, max_lon):
    return (
        f"POLYGON(({min_lon} {min_lat}, {max_lon} {min_lat}, "
        f"{max_lon} {max_lat}, {min_lon} {max_lat}, {min_lon} {min_lat}))"
    )


def parse_year_facets(response_json):
    year_counts = {}
    for facet in response_json.get("facets", []):
        if facet.get("field") == "YEAR":
            for entry in facet.get("counts", []):
                year = entry.get("name")
                count = entry.get("count", 0)
                if year and year.isdigit():
                    year_counts[year] = count
    return year_counts


def fetch_species_occurrences(scientific_name, bbox_wkt, session_get):
    params = {
        "scientificName": scientific_name,
        "country": "GB",
        "geometry": bbox_wkt,
        "facet": "year",
        "facetLimit": 300,
        "limit": 0,
    }
    url = f"{GBIF_BASE}?{urllib.parse.urlencode(params)}"
    try:
        raw = session_get(url)
        data = json.loads(raw)
        year_counts = parse_year_facets(data)
        total = data.get("count", sum(year_counts.values()))
        return {"byYear": year_counts, "totalRecords": total}, None
    except urllib.error.HTTPError as e:
        return None, f"HTTP {e.code}: {e.reason}"
    except Exception as e:  # noqa: BLE001
        return None, str(e)


def real_http_get(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8")


def main():
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        config = json.load(f)

    boundary = config["boundary"]
    bbox_wkt = build_bbox_wkt(
        boundary["minLat"], boundary["maxLat"], boundary["minLon"], boundary["maxLon"]
    )

    results = {}
    species_list = [s for s in config["species"] if s.get("trackOccurrences", True)]
    print(f"Fetching GBIF occurrence data for {len(species_list)} species...")

    for i, sp in enumerate(species_list):
        name = sp["scientificName"]
        print(f"  [{i+1}/{len(species_list)}] {name} ...", end=" ", flush=True)
        record, error = fetch_species_occurrences(name, bbox_wkt, real_http_get)
        if error:
            print(f"FAILED ({error})")
            results[name] = {"byYear": {}, "totalRecords": 0, "error": error}
        else:
            print(f"ok ({record['totalRecords']} total records)")
            record["error"] = None
            results[name] = record
        time.sleep(REQUEST_DELAY_SECONDS)

    output = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "boundary": {"type": "bbox+country", "country": "GB", **boundary},
        "species": results,
    }

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    failed = [n for n, r in results.items() if r.get("error")]
    print(f"\nDone. {len(results) - len(failed)}/{len(results)} species fetched cleanly.")
    if failed:
        print(f"Failed: {failed}")


if __name__ == "__main__":
    main()
