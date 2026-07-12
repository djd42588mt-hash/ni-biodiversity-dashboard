#!/usr/bin/env python3
"""
Fetches COMPREHENSIVE, taxon-wide data from GBIF for each of the 7 broad
groups - i.e. every recorded species in that group in Northern Ireland, not
just the curated species list. This is what powers "Trends by group" and the
map, and is the direct answer to "the curated list makes this useless for a
complete picture": these numbers are not limited to the ~31 tracked species.

Two things are fetched per group:
1. Year-by-year occurrence counts (facet=year), for the group trend chart -
   one query gets the complete year history for the WHOLE group at once.
2. A coarse spatial grid (a NI_GRID_COLS x NI_GRID_ROWS grid over the
   bounding box), built from a sample of up to GRID_SAMPLE_SIZE occurrence
   records with coordinates. This is a SAMPLE, not an exhaustive count - it
   is only intended to show relative geographic density, and is described
   as such in the UI. Coordinates are binned into grid cells rather than
   kept as exact points, which also avoids publishing precise locations for
   any sensitive species that might later be added to a group.

Taxonomic filter used per group (GBIF occurrence search accepts these as
plain-text Darwin Core fields, matched against its backbone taxonomy):
  Invertebrates -> phylum=Arthropoda  (the dominant invertebrate phylum in NI
                   records; molluscs/annelids/etc. are not included in this
                   comprehensive count - a known, documented simplification)
  Mammals       -> class=Mammalia
  Birds         -> class=Aves
  Fish          -> class=Actinopterygii (ray-finned fish; covers the large
                   majority of NI freshwater/coastal fish species)
  Amphibians    -> class=Amphibia
  Fungi         -> kingdom=Fungi
  Bacteria      -> kingdom=Bacteria (expect very sparse data - bacteria are
                   rarely logged as field "occurrences" the way macro-
                   organisms are; a near-empty result here is a real data
                   limitation, not a bug)
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
OUTPUT_PATH = os.path.join(ROOT_DIR, "data", "group_totals.json")

GBIF_BASE = "https://api.gbif.org/v1/occurrence/search"
REQUEST_DELAY_SECONDS = 0.6
USER_AGENT = "NI-Biodiversity-Dashboard/1.0"
GRID_SAMPLE_SIZE = 300   # GBIF's per-request page-size cap
NI_GRID_COLS = 10
NI_GRID_ROWS = 8

GROUP_TAXON_FILTERS = {
    "Invertebrates": {"phylum": "Arthropoda"},
    "Mammals": {"class": "Mammalia"},
    "Birds": {"class": "Aves"},
    "Fish": {"class": "Actinopterygii"},
    "Amphibians": {"class": "Amphibia"},
    "Fungi": {"kingdom": "Fungi"},
    "Bacteria": {"kingdom": "Bacteria"},
}


def build_bbox_wkt(min_lat, max_lat, min_lon, max_lon):
    return (
        f"POLYGON(({min_lon} {min_lat}, {max_lon} {min_lat}, "
        f"{max_lon} {max_lat}, {min_lon} {max_lat}, {min_lon} {min_lat}))"
    )


def real_http_get(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8")


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


def fetch_group_year_counts(taxon_filter, bbox_wkt, session_get):
    params = {"country": "GB", "geometry": bbox_wkt, "facet": "year", "facetLimit": 300, "limit": 0, **taxon_filter}
    url = f"{GBIF_BASE}?{urllib.parse.urlencode(params)}"
    try:
        data = json.loads(session_get(url))
        return {"byYear": parse_year_facets(data), "totalRecords": data.get("count", 0)}, None
    except urllib.error.HTTPError as e:
        return None, f"HTTP {e.code}: {e.reason}"
    except Exception as e:  # noqa: BLE001
        return None, str(e)


def bin_into_grid(records, min_lat, max_lat, min_lon, max_lon, cols, rows):
    grid = [[0 for _ in range(cols)] for _ in range(rows)]
    lat_step = (max_lat - min_lat) / rows
    lon_step = (max_lon - min_lon) / cols
    for rec in records:
        lat, lon = rec.get("decimalLatitude"), rec.get("decimalLongitude")
        if lat is None or lon is None:
            continue
        col = min(cols - 1, max(0, int((lon - min_lon) / lon_step)))
        row = min(rows - 1, max(0, int((max_lat - lat) / lat_step)))  # row 0 = northernmost
        grid[row][col] += 1
    return grid


def fetch_group_grid(taxon_filter, boundary, session_get):
    bbox_wkt = build_bbox_wkt(boundary["minLat"], boundary["maxLat"], boundary["minLon"], boundary["maxLon"])
    params = {
        "country": "GB", "geometry": bbox_wkt, "hasCoordinate": "true",
        "limit": GRID_SAMPLE_SIZE, **taxon_filter,
    }
    url = f"{GBIF_BASE}?{urllib.parse.urlencode(params)}"
    try:
        data = json.loads(session_get(url))
        records = data.get("results", [])
        grid = bin_into_grid(records, boundary["minLat"], boundary["maxLat"], boundary["minLon"], boundary["maxLon"], NI_GRID_COLS, NI_GRID_ROWS)
        return {"grid": grid, "sampleSize": len(records)}, None
    except urllib.error.HTTPError as e:
        return None, f"HTTP {e.code}: {e.reason}"
    except Exception as e:  # noqa: BLE001
        return None, str(e)


def main():
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        config = json.load(f)
    boundary = config["boundary"]
    bbox_wkt = build_bbox_wkt(boundary["minLat"], boundary["maxLat"], boundary["minLon"], boundary["maxLon"])

    results = {}
    print(f"Fetching comprehensive (all-species) GBIF totals for {len(GROUP_TAXON_FILTERS)} groups...")
    for group_name, taxon_filter in GROUP_TAXON_FILTERS.items():
        print(f"  {group_name} ({taxon_filter}) ...", end=" ", flush=True)
        year_data, err = fetch_group_year_counts(taxon_filter, bbox_wkt, real_http_get)
        time.sleep(REQUEST_DELAY_SECONDS)
        grid_data, grid_err = fetch_group_grid(taxon_filter, boundary, real_http_get)
        time.sleep(REQUEST_DELAY_SECONDS)

        if err:
            print(f"FAILED ({err})")
            results[group_name] = {"byYear": {}, "totalRecords": 0, "grid": None, "error": err}
        else:
            print(f"ok ({year_data['totalRecords']} total records)")
            results[group_name] = {
                "byYear": year_data["byYear"],
                "totalRecords": year_data["totalRecords"],
                "grid": grid_data["grid"] if grid_data else None,
                "gridSampleSize": grid_data["sampleSize"] if grid_data else 0,
                "taxonFilter": taxon_filter,
                "error": None,
            }

    output = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "gridDimensions": {"cols": NI_GRID_COLS, "rows": NI_GRID_ROWS},
        "boundary": boundary,
        "groups": results,
    }
    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    failed = [g for g, r in results.items() if r.get("error")]
    print(f"\nDone. {len(results) - len(failed)}/{len(results)} groups fetched cleanly.")
    if failed:
        print(f"Failed: {failed}")


if __name__ == "__main__":
    main()
