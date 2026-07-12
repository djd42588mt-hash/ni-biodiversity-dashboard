# Northern Ireland Biodiversity Watch

A free, self-updating website tracking recorded wildlife observations (GBIF) and GenBank reference sequences (NCBI) for a curated list of species relevant to AFBI/DAERA.

An automated GitHub Action re-queries GBIF and NCBI on a schedule, computes trends, and commits the results as JSON. GitHub Pages serves the static site that reads that JSON.

## Customising species
Edit `species-config.json`. Each entry has `scientificName`, `commonName`, `category`, `trackOccurrences`, `trackSequences`, and optionally `invasiveAlert: true` (flags any NI detection at all as high-priority, for species that are currently absent/newly-arrived).

## Changing the refresh schedule
Edit the `cron:` line in `.github/workflows/update-data.yml`.

## Notes
- The Northern Ireland boundary is approximated with a bounding box + `country=GB` filter (see `scripts/fetch_gbif.py` comments).
- Observation counts reflect recording effort as well as species presence — a decline can mean fewer organisms, fewer recorders, or both.
- GenBank sequence counts almost never fall, so they're described as steady/accelerating/stalled rather than rising/declining.
- Only complete calendar years feed alert thresholds; the current year is shown on charts but excluded from the maths.
