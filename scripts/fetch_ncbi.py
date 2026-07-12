#!/usr/bin/env python3
"""
Fetches GenBank (nuccore) sequence counts per species from NCBI E-utilities.
"""
import json
import os
import time
import urllib.parse
import urllib.request
import urllib.error
import datetime

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(SCRIPT_DIR)
CONFIG_PATH = os.path.join(ROOT_DIR, "species-config.json")
OUTPUT_PATH = os.path.join(ROOT_DIR, "data", "sequences.json")

ESEARCH_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi"
REQUEST_DELAY_SECONDS = 0.4
YEARS_OF_HISTORY = 10
CONTACT_EMAIL = "set-your-email-here@example.com"
USER_AGENT = "NI-Biodiversity-Dashboard/1.0"


def parse_count(response_json):
    try:
        return int(response_json["esearchresult"]["count"])
    except (KeyError, ValueError, TypeError):
        return 0


def build_esearch_url(term, mindate=None, maxdate=None):
    params = {
        "db": "nuccore",
        "term": term,
        "retmode": "json",
        "retmax": 0,
        "tool": "NI_Biodiversity_Dashboard",
        "email": CONTACT_EMAIL,
    }
    if mindate and maxdate:
        params["datetype"] = "pdat"
        params["mindate"] = mindate
        params["maxdate"] = maxdate
    return f"{ESEARCH_BASE}?{urllib.parse.urlencode(params)}"


def real_http_get(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8")


def fetch_count(term, session_get, mindate=None, maxdate=None):
    url = build_esearch_url(term, mindate, maxdate)
    try:
        raw = session_get(url)
        data = json.loads(raw)
        return parse_count(data), None
    except urllib.error.HTTPError as e:
        return 0, f"HTTP {e.code}: {e.reason}"
    except Exception as e:  # noqa: BLE001
        return 0, str(e)


def fetch_species_sequences(scientific_name, current_year, session_get):
    organism_term = f'"{scientific_name}"[Organism]'

    total, err = fetch_count(organism_term, session_get)
    if err:
        return None, err
    time.sleep(REQUEST_DELAY_SECONDS)

    by_year = {}
    for year in range(current_year - YEARS_OF_HISTORY, current_year + 1):
        count, err = fetch_count(organism_term, session_get, f"{year}", f"{year}")
        by_year[str(year)] = count if not err else None
        time.sleep(REQUEST_DELAY_SECONDS)

    ni_term = f'{organism_term} AND ("Northern Ireland"[All Fields])'
    ni_total, ni_err = fetch_count(ni_term, session_get)
    time.sleep(REQUEST_DELAY_SECONDS)

    return {
        "totalSequences": total,
        "byYear": by_year,
        "niOriginTotal": ni_total if not ni_err else None,
    }, None


def main():
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        config = json.load(f)

    current_year = datetime.datetime.utcnow().year
    species_list = [s for s in config["species"] if s.get("trackSequences", True)]
    print(f"Fetching NCBI sequence data for {len(species_list)} species...")

    results = {}
    for i, sp in enumerate(species_list):
        name = sp["scientificName"]
        print(f"  [{i+1}/{len(species_list)}] {name} ...", end=" ", flush=True)
        record, error = fetch_species_sequences(name, current_year, real_http_get)
        if error:
            print(f"FAILED ({error})")
            results[name] = {"byYear": {}, "totalSequences": 0, "niOriginTotal": None, "error": error}
        else:
            print(f"ok ({record['totalSequences']} total sequences)")
            record["error"] = None
            results[name] = record

    output = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
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
