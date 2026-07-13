#!/usr/bin/env python3
"""
Fligence-style OD aggregation pipeline (v2 - multi-airport)
-------------------------------------------------------------
Ingests raw device-ping extracts (one polygon set = one airport facility)
and aggregates them into small, static JSON files suitable for GitHub Pages.

WHY YOUR HISTORY IS SAFE ACROSS RUNS
-------------------------------------
history.json is keyed by (airport, quarter, county FIPS). A new extract only
ever touches the keys present in that extract. If your vendor gives you a
rolling 24-month window, quarters older than that window simply aren't in
the new file, so merge_history() never sees those keys and never removes
them from history.json. The only failure mode is pointing --history at the
wrong (or a fresh/empty) file -- so this script always makes a timestamped
backup of history.json before writing, and refuses to run if it can't.

USAGE
-----
Single airport, single file (original mode):
    python aggregate.py raw/EPIA_2022.tsv --airport ELP \
        --history data/history.json --out data/

Multiple airports in one run, via manifest (recommended going forward):
    python aggregate.py --manifest manifest.json \
        --history data/history.json --out data/

manifest.json format:
[
  {"airport": "ELP", "path": "raw/EPIA_2022.tsv"},
  {"airport": "AUS", "path": "raw/AUS_2022.tsv"},
  {"airport": "DFW", "path": "raw/DFW_2022.tsv"}
]

Each run:
  1. Loads existing history.json (if present)
  2. Backs it up to history.backup.<timestamp>.json
  3. Aggregates each new extract to (airport, quarter, fips)
  4. Merges into history -- only overwrites keys present in the new data
  5. Rewrites summary.json from the FULL merged history (safe to regenerate
     every time since it's a rollup, not the source of truth)
"""
import argparse
import csv
import json
import shutil
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

FIPS_STATE_LOOKUP = "Common Evening Province"
FIPS_FIELD = "Common Evening Census"
COUNTY_FIELD = "Common Evening Municipality"
COUNTRY_FIELD = "Common Evening Country"
LAT_FIELD = "Common Evening Lat"
LON_FIELD = "Common Evening Long"
DIST_FIELD = "Common Evening Distance Mi"
DEVICE_FIELD = "Hashed Ubermedia Id"
DATE_FIELD = "Visit Date"

# Full US county FIPS -> "County Name, ST" lookup, used instead of the
# vendor's "Common Evening Municipality" field. That field is actually a
# metro/CBSA label (e.g. "Dallas-Ft. Worth, TX" for Dallas, Tarrant, Collin,
# AND Denton counties alike), so four distinct counties all render with the
# identical label -- which is the "duplicate-looking" origin city problem.
# Ship county_names.json alongside this script (built once from Census
# county boundaries; see build_county_names.py).
_COUNTY_NAMES_PATH = Path(__file__).parent / "county_names.json"
COUNTY_NAMES = json.loads(_COUNTY_NAMES_PATH.read_text()) if _COUNTY_NAMES_PATH.exists() else {}

# Airport registry -- used only for display metadata in the dashboard.
# Add to this as you onboard new airports. Not required for aggregation itself.
AIRPORT_REGISTRY = {
    "ELP": {"name": "El Paso International", "state": "TX", "lat": 31.8072, "lon": -106.3781},
    "ABQ": {"name": "Albuquerque International Sunport", "state": "NM", "lat": 35.0402, "lon": -106.6091},
    "AUS": {"name": "Austin-Bergstrom International", "state": "TX", "lat": 30.1975, "lon": -97.6664},
    "AMA": {"name": "Rick Husband Amarillo International", "state": "TX", "lat": 35.2194, "lon": -101.7059},
    "DFW": {"name": "Dallas/Fort Worth International", "state": "TX", "lat": 32.8998, "lon": -97.0403},
    "DAL": {"name": "Dallas Love Field", "state": "TX", "lat": 32.8471, "lon": -96.8518},
    "IAH": {"name": "Houston George Bush Intercontinental", "state": "TX", "lat": 29.9902, "lon": -95.3368},
    "HOU": {"name": "Houston William P. Hobby", "state": "TX", "lat": 29.6454, "lon": -95.2789},
    "HRL": {"name": "Valley International (Harlingen)", "state": "TX", "lat": 26.2285, "lon": -97.6544},
    "SAT": {"name": "San Antonio International", "state": "TX", "lat": 29.5312, "lon": -98.4696},
    "LBB": {"name": "Lubbock Preston Smith International", "state": "TX", "lat": 33.6636, "lon": -101.8228},
    "MAF": {"name": "Midland International Air & Space Port", "state": "TX", "lat": 31.9425, "lon": -102.2019},
    "CRP": {"name": "Corpus Christi International", "state": "TX", "lat": 27.7704, "lon": -97.5121},
    "MFE": {"name": "McAllen Miller International", "state": "TX", "lat": 26.1758, "lon": -98.2386},
}


def quarter_of(date_str: str) -> str:
    dt = datetime.strptime(date_str, "%Y-%m-%d")
    q = (dt.month - 1) // 3 + 1
    return f"{dt.year}-Q{q}"


def county_fips5(census_block: str) -> str:
    digits = "".join(ch for ch in census_block if ch.isdigit())
    return digits[:5] if len(digits) >= 5 else ""


def county_key(row: dict) -> tuple[str, str]:
    """Returns (key, display_label). USA rows key on real 5-digit county FIPS
    (namespaced 'US:' so it can never collide with anything else). Non-USA
    rows have no reliable FIPS in this feed -- e.g. Mexican municipio codes
    happen to truncate to the same 5 digits as unrelated US counties (a real
    collision found in this data: MEX 'Juarez' and US FIPS 08037 / Eagle
    County, CO both truncate to '08037'). Those are keyed on country+city
    instead so they never share a bucket with a US county."""
    country = (row.get(COUNTRY_FIELD) or "").strip()
    if country == "USA":
        fips = county_fips5(row.get(FIPS_FIELD, ""))
        if not fips:
            return None, None
        label = COUNTY_NAMES.get(fips, row.get(COUNTY_FIELD, "") or fips)
        return f"US:{fips}", label
    city = (row.get(COUNTY_FIELD, "") or "unknown").strip()
    if not country:
        return None, None
    return f"INTL:{country}:{city}", f"{city}, {country}"


def aggregate_extract(path: Path):
    agg = defaultdict(lambda: {
        "devices": set(), "pings": 0, "dist_sum": 0.0, "dist_n": 0,
        "state": "", "lat_sum": 0.0, "lon_sum": 0.0, "geo_n": 0,
        "county_label": ""
    })
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f, delimiter="\t")
        for row in reader:
            try:
                q = quarter_of(row[DATE_FIELD])
            except (ValueError, KeyError):
                continue
            key_id, label = county_key(row)
            if not key_id:
                continue
            key = (q, key_id)
            bucket = agg[key]
            bucket["devices"].add(row.get(DEVICE_FIELD, ""))
            bucket["pings"] += 1
            bucket["state"] = row.get(FIPS_STATE_LOOKUP, "")
            bucket["county_label"] = label
            try:
                bucket["dist_sum"] += float(row.get(DIST_FIELD, 0) or 0)
                bucket["dist_n"] += 1
            except ValueError:
                pass
            try:
                bucket["lat_sum"] += float(row[LAT_FIELD])
                bucket["lon_sum"] += float(row[LON_FIELD])
                bucket["geo_n"] += 1
            except (ValueError, KeyError):
                pass
    return agg


def to_serializable(agg, airport_code):
    out = {airport_code: {}}
    for (q, key_id), b in agg.items():
        out[airport_code].setdefault(q, {})[key_id] = {
            "devices": len(b["devices"]),
            "pings": b["pings"],
            "avg_distance_mi": round(b["dist_sum"] / b["dist_n"], 1) if b["dist_n"] else None,
            "state": b["state"],
            "county_label": b["county_label"],
            "lat": round(b["lat_sum"] / b["geo_n"], 4) if b["geo_n"] else None,
            "lon": round(b["lon_sum"] / b["geo_n"], 4) if b["geo_n"] else None,
        }
    return out


def merge_history(history: dict, new_data: dict) -> dict:
    """Only overwrites (airport, quarter, fips) keys present in new_data.
    Every other key already in history -- including entire quarters or
    entire airports not touched by this run -- is left exactly as-is."""
    for airport, quarters in new_data.items():
        history.setdefault(airport, {})
        for q, counties in quarters.items():
            history[airport].setdefault(q, {})
            history[airport][q].update(counties)
    return history


def build_summary(history: dict) -> dict:
    summary = {}
    for airport, quarters in history.items():
        summary[airport] = {"meta": AIRPORT_REGISTRY.get(airport, {}), "quarters": {}}
        for q, counties in quarters.items():
            total_devices = sum(c["devices"] for c in counties.values())
            total_pings = sum(c["pings"] for c in counties.values())
            top = sorted(counties.items(), key=lambda kv: -kv[1]["devices"])[:15]
            # Full Texas county breakdown -- key format is "US:48XXX"; strip
            # the "US:" prefix so the map can join directly on 5-digit FIPS.
            # International keys ("INTL:...") never collide with this since
            # they don't start with "US:48".
            tx_counties = {
                key_id[3:]: c["devices"]
                for key_id, c in counties.items()
                if key_id.startswith("US:48")
            }
            summary[airport]["quarters"][q] = {
                "total_devices": total_devices,
                "total_pings": total_pings,
                "county_count": len(counties),
                "top_counties": [
                    {
                        "fips": key_id[3:] if key_id.startswith("US:") else None,
                        "label": c["county_label"],
                        "state": c["state"],
                        "devices": c["devices"],
                        "share": round(c["devices"] / total_devices, 5) if total_devices else 0,
                        "avg_distance_mi": c["avg_distance_mi"],
                        "lat": c["lat"],
                        "lon": c["lon"],
                    }
                    for key_id, c in top
                ],
                "tx_counties": tx_counties,
                "tx_counties_share": {
                    fips: round(devices / total_devices, 5) if total_devices else 0
                    for fips, devices in tx_counties.items()
                },
            }
    return summary


def backup_history(history_path: Path):
    if not history_path.exists():
        return None
    ts = datetime.now(tz=__import__("datetime").timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup_path = history_path.with_name(f"{history_path.stem}.backup.{ts}{history_path.suffix}")
    shutil.copy2(history_path, backup_path)
    return backup_path


def load_manifest(manifest_path: Path):
    entries = json.loads(manifest_path.read_text())
    return [(e["airport"], Path(e["path"])) for e in entries]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("extract", type=Path, nargs="?", help="single raw TSV extract (omit if using --manifest)")
    ap.add_argument("--airport", help="airport code for single-file mode, e.g. AUS")
    ap.add_argument("--manifest", type=Path, help="JSON file listing multiple {airport, path} extracts")
    ap.add_argument("--history", type=Path, default=Path("data/history.json"))
    ap.add_argument("--out", type=Path, default=Path("data/"))
    args = ap.parse_args()

    if not args.manifest and not (args.extract and args.airport):
        sys.exit("Provide either --manifest FILE, or an extract path with --airport CODE")

    args.out.mkdir(parents=True, exist_ok=True)

    history = {}
    if args.history.exists():
        history = json.loads(args.history.read_text())
    backup_path = backup_history(args.history)

    jobs = load_manifest(args.manifest) if args.manifest else [(args.airport, args.extract)]

    for airport_code, extract_path in jobs:
        if not extract_path.exists():
            print(f"  SKIP {airport_code}: file not found at {extract_path}")
            continue
        agg = aggregate_extract(extract_path)
        new_data = to_serializable(agg, airport_code)
        history = merge_history(history, new_data)
        n_devices = sum(
            c["devices"] for quarters in new_data.values() for counties in quarters.values() for c in counties.values()
        )
        print(f"  {airport_code}: processed {extract_path.name} ({n_devices} device-rows across quarters found)")

    args.history.write_text(json.dumps(history))
    summary = build_summary(history)
    (args.out / "summary.json").write_text(json.dumps(summary, indent=2))

    print(f"\nAirports now in history: {sorted(history.keys())}")
    if backup_path:
        print(f"Backup written: {backup_path}")
    print(f"Wrote {args.history} and {args.out / 'summary.json'}")


if __name__ == "__main__":
    main()
