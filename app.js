import { useMemo, useState, useEffect, useRef } from "react";
import * as d3 from "d3";
import { ScatterChart, Scatter, XAxis, YAxis, ZAxis, Tooltip, CartesianGrid, ResponsiveContainer, LineChart, Line, ReferenceLine, Cell } from "recharts";
import { Plane, Radar, TrendingUp, MapPinned, ArrowRightLeft, Info, Inbox } from "lucide-react";

/* ---------------------------------------------------------------
   Output from aggregate_v2.py's build_summary(). Shape:
   { AIRPORT_CODE: { meta: {name, state}, quarters: { "YYYY-Qn": {...} } } }

   Only ELP has a processed extract so far. The other 12 airports in
   AIRPORT_REGISTRY are wired into the selector now so the UI doesn't
   need another rebuild once their extracts are run through the
   pipeline -- they show an honest "no extract yet" state until then.
   ----------------------------------------------------------------*/

/* Every airport wired into the selector, even before its extract exists.
   Matches AIRPORT_REGISTRY in aggregate_v2.py -- keep these in sync. */
import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
const AIRPORT_REGISTRY = {
  ELP: {
    name: "El Paso International"
  },
  ABQ: {
    name: "Albuquerque International Sunport"
  },
  AUS: {
    name: "Austin-Bergstrom International"
  },
  AMA: {
    name: "Rick Husband Amarillo International"
  },
  DFW: {
    name: "Dallas/Fort Worth International"
  },
  DAL: {
    name: "Dallas Love Field"
  },
  IAH: {
    name: "Houston George Bush Intercontinental"
  },
  HOU: {
    name: "Houston William P. Hobby"
  },
  HRL: {
    name: "Valley International (Harlingen)"
  },
  SAT: {
    name: "San Antonio International"
  },
  LBB: {
    name: "Lubbock Preston Smith International"
  },
  MAF: {
    name: "Midland International Air & Space Port"
  },
  CRP: {
    name: "Corpus Christi International"
  },
  MFE: {
    name: "McAllen Miller International"
  },
  CJS: {
    name: "Abraham González International (Ciudad Juárez)"
  }
};
function sortQuarters(a, b) {
  const [ya, qa] = a.split("-Q").map(Number);
  const [yb, qb] = b.split("-Q").map(Number);
  return ya * 10 + qa - (yb * 10 + qb);
}

// Quarters where 2+ airports actually have processed extracts -- a quarter
// with only ELP data (e.g. 2019-2022, before the other airports were ever
// pulled) isn't meaningful for cross-airport leakage comparison, since
// "ELP has 100% share" there just means nobody else was measured, not that
// ELP genuinely had no competition. This is computed dynamically (not a
// hardcoded cutoff date) so it stays correct as more historical or new
// airport extracts are added later.
function multiAirportQuarters(DATA, airportCodes) {
  if (!DATA) return [];
  const counts = {};
  airportCodes.forEach(code => {
    Object.keys(DATA[code].quarters).forEach(q => {
      counts[q] = (counts[q] || 0) + 1;
    });
  });
  return Object.keys(counts).filter(q => counts[q] >= 2).sort(sortQuarters);
}
function haversineMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

// For every county, finds whichever tracked airport is geographically
// nearest (straight-line distance from the county's true centroid to each
// airport's own coordinates) -- independent of any device data. Comparing
// this to which airport actually DOMINATES that county's device sample is
// what surfaces genuine geographic leakage: people bypassing their closest
// airport for a farther one.
function computeNearestAirports(geometry, DATA, airportCodes) {
  const result = {};
  for (const c of geometry) {
    const feature = {
      type: "Feature",
      geometry: {
        type: c.type,
        coordinates: c.coordinates
      }
    };
    const [lon, lat] = d3.geoCentroid(feature);
    let best = null;
    for (const code of airportCodes) {
      const meta = DATA[code]?.meta;
      if (!meta || meta.lat == null || meta.lon == null) continue;
      const dist = haversineMiles(lat, lon, meta.lat, meta.lon);
      if (!best || dist < best.dist) best = {
        code,
        dist
      };
    }
    if (best) result[c.fips] = best;
  }
  return result;
}
function distanceBucket(mi) {
  if (mi == null) return {
    key: "unknown",
    label: "Unknown",
    color: "#64748b"
  };
  if (mi <= 60) return {
    key: "core",
    label: "Core catchment (≤60 mi)",
    color: "#2dd4bf"
  };
  if (mi <= 300) return {
    key: "extended",
    label: "Extended catchment (60–300 mi)",
    color: "#facc15"
  };
  return {
    key: "flyover",
    label: "Long-haul / potential leakage risk (300+ mi)",
    color: "#fb7185"
  };
}
function countyColor(share) {
  // share is a fraction (0-1) of that quarter's total device sample
  if (!share) return "#1e293b"; // slate-800, no data
  if (share < 0.0005) return "#0f766e"; // teal-700 -- <0.05%
  if (share < 0.002) return "#2dd4bf"; // teal-400 -- 0.05-0.2%
  if (share < 0.01) return "#facc15"; // amber-400 -- 0.2-1%
  if (share < 0.05) return "#f59e0b"; // amber-500 -- 1-5%
  return "#fb7185"; // rose-400 -- 5%+, usually the airport's own county
}
function fmt(n) {
  if (n == null) return "—";
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}
function fmtPct(share) {
  if (share == null) return "—";
  if (share < 0.001) return "<0.1%";
  return `${(share * 100).toFixed(1)}%`;
}
export default function CatchmentDashboard() {
  const [DATA, setDATA] = useState(null);
  const [TX_COUNTY_GEOMETRY, setGeometry] = useState(null);
  const [REGIONS, setREGIONS] = useState(null);
  const [DESTINATIONS, setDESTINATIONS] = useState(null);
  const [loadError, setLoadError] = useState(null);
  useEffect(() => {
    Promise.all([fetch("./data/summary.json").then(r => {
      if (!r.ok) throw new Error(`summary.json: ${r.status}`);
      return r.json();
    }), fetch("./data/tx_counties.geo.json").then(r => {
      if (!r.ok) throw new Error(`tx_counties.geo.json: ${r.status}`);
      return r.json();
    }), fetch("./data/regions.json").then(r => r.ok ? r.json() : {}).catch(() => ({})),
    // Destinations data is optional -- the tab shows a "not available yet"
    // state instead of erroring if this file isn't present.
    fetch("./data/destinations_summary.json").then(r => r.ok ? r.json() : null).catch(() => null)]).then(([summary, geometry, regions, destinations]) => {
      setDATA(summary);
      setGeometry(geometry);
      setREGIONS(regions);
      setDESTINATIONS(destinations);
    }).catch(err => setLoadError(err.message));
  }, []);
  const airportCodes = useMemo(() => Object.keys(AIRPORT_REGISTRY), []);
  const [airport, setAirport] = useState("ELP");
  const [tab, setTab] = useState("catchment");
  const hasData = Boolean(DATA && DATA[airport]);
  const quarters = useMemo(() => hasData ? Object.keys(DATA[airport].quarters).sort(sortQuarters) : [], [airport, hasData]);
  // -1 is a sentinel meaning "not set yet" -- this happens on first mount,
  // before the fetch() in the top-level useEffect has resolved, when
  // quarters is still []. The effect below snaps it to the latest quarter
  // as soon as real data shows up, so this never stays -1 once loaded.
  const [qIdx, setQIdx] = useState(-1);
  useEffect(() => {
    if (quarters.length && qIdx === -1) {
      setQIdx(quarters.length - 1);
    }
  }, [quarters, qIdx]);

  // clamp qIdx into range; if quarters is empty (still loading, or genuinely
  // no data), fall back to 0 rather than a negative index.
  const safeQIdx = quarters.length ? Math.min(Math.max(qIdx, 0), quarters.length - 1) : 0;
  const quarter = quarters[safeQIdx];
  const snap = hasData && quarter ? DATA[airport].quarters[quarter] : null;
  const prevQuarter = safeQIdx > 0 ? quarters[safeQIdx - 1] : null;
  const prevSnap = prevQuarter && hasData ? DATA[airport].quarters[prevQuarter] : null;
  const qoq = snap && prevSnap ? (snap.total_devices - prevSnap.total_devices) / prevSnap.total_devices * 100 : null;
  const years = useMemo(() => {
    const set = new Set(quarters.map(q => q.split("-")[0]));
    return Array.from(set).sort();
  }, [quarters]);
  function jumpToYear(year) {
    // land on the latest quarter available within that year
    const candidates = quarters.filter(q => q && q.startsWith(String(year)));
    if (candidates.length) setQIdx(quarters.indexOf(candidates[candidates.length - 1]));
  }
  const [trendMode, setTrendMode] = useState("indexed"); // "raw" | "indexed"
  const trend = useMemo(() => {
    if (!hasData) return [];
    const raw = quarters.map(q => ({
      quarter: q,
      devices: DATA[airport].quarters[q].total_devices
    }));
    if (trendMode === "raw") return raw;
    const base = raw[0]?.devices || 1;
    return raw.map(r => ({
      quarter: r.quarter,
      devices: Math.round(r.devices / base * 100)
    }));
  }, [quarters, airport, hasData, trendMode]);
  const scatterData = useMemo(() => snap ? snap.top_counties.filter(c => c.lat && c.lon).map(c => ({
    ...c,
    bucket: distanceBucket(c.avg_distance_mi)
  })) : [], [snap]);
  const localShare = useMemo(() => {
    if (!snap) return null;
    const core = snap.top_counties.filter(c => c.avg_distance_mi != null && c.avg_distance_mi <= 60).reduce((s, c) => s + c.share, 0);
    return Math.round(core * 1000) / 10;
  }, [snap]);
  function handleAirportChange(code) {
    setAirport(code);
    const q = DATA && DATA[code] ? Object.keys(DATA[code].quarters).sort(sortQuarters) : [];
    setQIdx(Math.max(q.length - 1, 0));
  }
  if (loadError) {
    return /*#__PURE__*/_jsx("div", {
      className: "min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6",
      children: /*#__PURE__*/_jsxs("div", {
        className: "max-w-md text-center",
        children: [/*#__PURE__*/_jsx("div", {
          className: "text-sm font-semibold text-rose-400 mb-2",
          children: "Couldn't load dashboard data"
        }), /*#__PURE__*/_jsx("p", {
          className: "text-xs text-slate-500",
          children: loadError
        }), /*#__PURE__*/_jsxs("p", {
          className: "text-xs text-slate-600 mt-3",
          children: ["Check that ", /*#__PURE__*/_jsx("code", {
            className: "text-amber-400",
            children: "data/summary.json"
          }), " and", " ", /*#__PURE__*/_jsx("code", {
            className: "text-amber-400",
            children: "data/tx_counties.geo.json"
          }), " exist alongside this page."]
        })]
      })
    });
  }
  if (!DATA || !TX_COUNTY_GEOMETRY) {
    return /*#__PURE__*/_jsx("div", {
      className: "min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center",
      children: /*#__PURE__*/_jsx("div", {
        className: "text-sm text-slate-500",
        children: "Loading catchment data…"
      })
    });
  }
  return /*#__PURE__*/_jsxs("div", {
    className: "min-h-screen bg-slate-950 text-slate-100 font-sans",
    children: [/*#__PURE__*/_jsx("div", {
      className: "border-b border-slate-800 bg-slate-900/60",
      children: /*#__PURE__*/_jsxs("div", {
        className: "max-w-7xl mx-auto px-4 sm:px-6 py-4 flex flex-col gap-3",
        children: [/*#__PURE__*/_jsxs("div", {
          className: "flex items-center justify-between flex-wrap gap-3",
          children: [/*#__PURE__*/_jsxs("div", {
            className: "flex items-center gap-3",
            children: [/*#__PURE__*/_jsx("div", {
              className: "w-9 h-9 rounded-md bg-amber-400/10 border border-amber-400/30 flex items-center justify-center",
              children: /*#__PURE__*/_jsx(Plane, {
                className: "w-4.5 h-4.5 text-amber-400",
                strokeWidth: 2
              })
            }), /*#__PURE__*/_jsxs("div", {
              children: [/*#__PURE__*/_jsx("div", {
                className: "text-sm font-semibold tracking-wide text-slate-100",
                children: "Texas OD & Catchment Console"
              }), /*#__PURE__*/_jsxs("div", {
                className: "text-xs text-slate-500",
                children: [airport, " — ", AIRPORT_REGISTRY[airport]?.name]
              })]
            })]
          }), /*#__PURE__*/_jsx("div", {
            className: "flex items-center gap-1.5",
            children: Array.from({
              length: 9
            }).map((_, i) => /*#__PURE__*/_jsx("span", {
              className: "w-1.5 h-1.5 rounded-full bg-amber-400",
              style: {
                opacity: 0.25 + 0.75 * (1 - Math.abs(i - 4) / 4),
                animation: `pulseDot 2.4s ease-in-out ${i * 0.12}s infinite`
              }
            }, i))
          })]
        }), /*#__PURE__*/_jsx("div", {
          className: "flex gap-1.5 flex-wrap",
          children: airportCodes.map(code => {
            const active = code === airport;
            const populated = Boolean(DATA[code]);
            return /*#__PURE__*/_jsxs("button", {
              onClick: () => handleAirportChange(code),
              className: `px-2.5 py-1 rounded text-xs font-mono border transition-colors ${active ? "border-amber-400 bg-amber-400/10 text-amber-300" : populated ? "border-slate-700 text-slate-300 hover:border-slate-500" : "border-slate-800 text-slate-600 hover:border-slate-700"}`,
              title: AIRPORT_REGISTRY[code].name + (populated ? "" : " (no extract processed yet)"),
              children: [code, !populated && /*#__PURE__*/_jsx("span", {
                className: "ml-1 text-slate-700",
                children: "·"
              })]
            }, code);
          })
        }), /*#__PURE__*/_jsx("div", {
          className: "flex gap-1 text-sm",
          children: [{
            id: "catchment",
            label: "Catchment",
            icon: MapPinned
          }, {
            id: "leakage",
            label: "Leakage",
            icon: ArrowRightLeft
          }, {
            id: "destinations",
            label: "Destination Airports",
            icon: Radar
          }].map(t => /*#__PURE__*/_jsxs("button", {
            onClick: () => setTab(t.id),
            className: `flex items-center gap-1.5 px-3 py-1.5 rounded-t-md border-b-2 transition-colors ${tab === t.id ? "border-amber-400 text-slate-50 bg-slate-800/60" : "border-transparent text-slate-500 hover:text-slate-300"}`,
            children: [/*#__PURE__*/_jsx(t.icon, {
              className: "w-3.5 h-3.5"
            }), t.label]
          }, t.id))
        })]
      })
    }), /*#__PURE__*/_jsxs("div", {
      className: "max-w-7xl mx-auto px-4 sm:px-6 py-6",
      children: [tab === "catchment" && !hasData && /*#__PURE__*/_jsxs("div", {
        className: "bg-slate-900/60 border border-slate-800 border-dashed rounded-lg p-10 flex flex-col items-center text-center gap-3",
        children: [/*#__PURE__*/_jsx(Inbox, {
          className: "w-8 h-8 text-slate-600"
        }), /*#__PURE__*/_jsxs("div", {
          className: "text-sm font-semibold text-slate-300",
          children: ["No extract processed yet for ", airport]
        }), /*#__PURE__*/_jsxs("p", {
          className: "text-xs text-slate-500 max-w-md",
          children: ["Run this airport's raw TSV through ", /*#__PURE__*/_jsx("code", {
            className: "text-amber-400",
            children: "aggregate_v2.py"
          }), " (single-file mode or add it to your manifest.json) to populate this view. Every other airport's data stays untouched when you do."]
        })]
      }), tab === "catchment" && hasData && /*#__PURE__*/_jsxs(_Fragment, {
        children: [/*#__PURE__*/_jsxs("div", {
          className: "mb-6 bg-slate-900/60 border border-slate-800 rounded-lg px-4 py-3",
          children: [/*#__PURE__*/_jsxs("div", {
            className: "flex items-center justify-between mb-3",
            children: [/*#__PURE__*/_jsx("span", {
              className: "text-xs uppercase tracking-wider text-slate-500",
              children: "Period"
            }), /*#__PURE__*/_jsx("span", {
              className: "text-sm font-semibold text-amber-400",
              children: quarter
            })]
          }), /*#__PURE__*/_jsx("div", {
            className: "flex gap-1.5 flex-wrap mb-2",
            children: years.map(y => /*#__PURE__*/_jsx("button", {
              onClick: () => jumpToYear(y),
              className: `px-2.5 py-1 rounded text-xs font-mono border transition-colors ${quarter?.startsWith(String(y)) ? "border-amber-400 bg-amber-400/10 text-amber-300" : "border-slate-700 text-slate-400 hover:border-slate-500"}`,
              children: y
            }, y))
          }), /*#__PURE__*/_jsx("div", {
            className: "flex gap-1.5 flex-wrap",
            children: ["Q1", "Q2", "Q3", "Q4"].map(qLabel => {
              const year = quarter?.split("-")[0] || "";
              const candidate = `${year}-${qLabel}`;
              const exists = quarters.includes(candidate);
              const active = candidate === quarter;
              return /*#__PURE__*/_jsx("button", {
                disabled: !exists,
                onClick: () => setQIdx(quarters.indexOf(candidate)),
                className: `px-3 py-1 rounded text-xs border transition-colors ${active ? "border-amber-400 bg-amber-400/10 text-amber-300" : exists ? "border-slate-700 text-slate-300 hover:border-slate-500" : "border-slate-850 text-slate-700 cursor-not-allowed"}`,
                children: qLabel
              }, qLabel);
            })
          })]
        }), /*#__PURE__*/_jsxs("div", {
          className: "grid grid-cols-2 md:grid-cols-4 gap-3 mb-6",
          children: [/*#__PURE__*/_jsx(KPI, {
            label: "Sample Size (devices)",
            value: fmt(snap.total_devices),
            sub: qoq !== null ? `${qoq >= 0 ? "+" : ""}${qoq.toFixed(1)}% QoQ (sample, not visitation)` : "no prior Q",
            subColor: qoq >= 0 ? "text-teal-400" : "text-rose-400"
          }), /*#__PURE__*/_jsx(KPI, {
            label: "Total Pings",
            value: fmt(snap.total_pings),
            sub: `${(snap.total_pings / snap.total_devices).toFixed(1)} pings / device`
          }), /*#__PURE__*/_jsx(KPI, {
            label: "Origin Counties",
            value: fmt(snap.county_count),
            sub: "distinct home locations"
          }), /*#__PURE__*/_jsx(KPI, {
            label: "Core Catchment Share",
            value: `${localShare}%`,
            sub: `home ≤ 60 mi from ${airport}`
          })]
        }), /*#__PURE__*/_jsxs("div", {
          className: "bg-slate-900/60 border border-slate-800 rounded-lg p-4 mb-6",
          children: [/*#__PURE__*/_jsxs("div", {
            className: "flex items-center justify-between mb-1",
            children: [/*#__PURE__*/_jsx("h3", {
              className: "text-sm font-semibold text-slate-200",
              children: "Texas Catchment by County"
            }), /*#__PURE__*/_jsx(Info, {
              className: "w-3.5 h-3.5 text-slate-600"
            })]
          }), /*#__PURE__*/_jsxs("p", {
            className: "text-xs text-slate-500 mb-3",
            children: ["All 254 TX counties · shaded by share of the ", quarter, " device sample (n=", fmt(snap.total_devices), "), not raw counts"]
          }), /*#__PURE__*/_jsx(TexasCountyMap, {
            countyShares: snap.tx_counties_share || {},
            countyDevices: snap.tx_counties || {},
            geometry: TX_COUNTY_GEOMETRY
          }), /*#__PURE__*/_jsxs("div", {
            className: "flex flex-wrap gap-3 mt-3 text-[11px] text-slate-500",
            children: [/*#__PURE__*/_jsxs("span", {
              className: "flex items-center gap-1",
              children: [/*#__PURE__*/_jsx("span", {
                className: "w-2.5 h-2.5 rounded-sm inline-block",
                style: {
                  background: "#1e293b"
                }
              }), "No sample"]
            }), /*#__PURE__*/_jsxs("span", {
              className: "flex items-center gap-1",
              children: [/*#__PURE__*/_jsx("span", {
                className: "w-2.5 h-2.5 rounded-sm inline-block",
                style: {
                  background: "#0f766e"
                }
              }), "<0.05%"]
            }), /*#__PURE__*/_jsxs("span", {
              className: "flex items-center gap-1",
              children: [/*#__PURE__*/_jsx("span", {
                className: "w-2.5 h-2.5 rounded-sm inline-block",
                style: {
                  background: "#2dd4bf"
                }
              }), "0.05–0.2%"]
            }), /*#__PURE__*/_jsxs("span", {
              className: "flex items-center gap-1",
              children: [/*#__PURE__*/_jsx("span", {
                className: "w-2.5 h-2.5 rounded-sm inline-block",
                style: {
                  background: "#facc15"
                }
              }), "0.2–1%"]
            }), /*#__PURE__*/_jsxs("span", {
              className: "flex items-center gap-1",
              children: [/*#__PURE__*/_jsx("span", {
                className: "w-2.5 h-2.5 rounded-sm inline-block",
                style: {
                  background: "#f59e0b"
                }
              }), "1–5%"]
            }), /*#__PURE__*/_jsxs("span", {
              className: "flex items-center gap-1",
              children: [/*#__PURE__*/_jsx("span", {
                className: "w-2.5 h-2.5 rounded-sm inline-block",
                style: {
                  background: "#fb7185"
                }
              }), "5%+"]
            })]
          })]
        }), /*#__PURE__*/_jsxs("div", {
          className: "grid lg:grid-cols-3 gap-4 mb-6",
          children: [/*#__PURE__*/_jsxs("div", {
            className: "lg:col-span-2 bg-slate-900/60 border border-slate-800 rounded-lg p-4",
            children: [/*#__PURE__*/_jsxs("div", {
              className: "flex items-center justify-between mb-1",
              children: [/*#__PURE__*/_jsx("h3", {
                className: "text-sm font-semibold text-slate-200",
                children: "Home Location of Airport Visitors"
              }), /*#__PURE__*/_jsx(Info, {
                className: "w-3.5 h-3.5 text-slate-600"
              })]
            }), /*#__PURE__*/_jsxs("p", {
              className: "text-xs text-slate-500 mb-3",
              children: ["Bubble size = share of ", quarter, " sample · color = distance band"]
            }), /*#__PURE__*/_jsx("div", {
              style: {
                width: "100%",
                height: 320
              },
              children: /*#__PURE__*/_jsx(ResponsiveContainer, {
                children: /*#__PURE__*/_jsxs(ScatterChart, {
                  margin: {
                    top: 10,
                    right: 20,
                    bottom: 10,
                    left: 0
                  },
                  children: [/*#__PURE__*/_jsx(CartesianGrid, {
                    stroke: "#1e293b"
                  }), /*#__PURE__*/_jsx(XAxis, {
                    type: "number",
                    dataKey: "lon",
                    domain: [-125, -70],
                    tick: {
                      fill: "#64748b",
                      fontSize: 10
                    },
                    tickFormatter: v => `${v}°`,
                    name: "Longitude"
                  }), /*#__PURE__*/_jsx(YAxis, {
                    type: "number",
                    dataKey: "lat",
                    domain: [24, 50],
                    tick: {
                      fill: "#64748b",
                      fontSize: 10
                    },
                    tickFormatter: v => `${v}°`,
                    name: "Latitude"
                  }), /*#__PURE__*/_jsx(ZAxis, {
                    type: "number",
                    dataKey: "share",
                    range: [40, 900],
                    name: "Share"
                  }), /*#__PURE__*/_jsx(Tooltip, {
                    cursor: {
                      strokeDasharray: "3 3"
                    },
                    content: ({
                      active,
                      payload
                    }) => {
                      if (!active || !payload?.length) return null;
                      const d = payload[0].payload;
                      return /*#__PURE__*/_jsxs("div", {
                        className: "bg-slate-900 border border-slate-700 rounded-md px-3 py-2 text-xs",
                        children: [/*#__PURE__*/_jsxs("div", {
                          className: "font-semibold text-slate-100",
                          children: [d.label, d.state ? `, home state ${d.state}` : ""]
                        }), /*#__PURE__*/_jsxs("div", {
                          className: "text-slate-400",
                          children: ["Share of sample: ", /*#__PURE__*/_jsx("span", {
                            className: "text-slate-200",
                            children: fmtPct(d.share)
                          })]
                        }), /*#__PURE__*/_jsxs("div", {
                          className: "text-slate-500",
                          children: ["(", fmt(d.devices), " devices)"]
                        }), /*#__PURE__*/_jsxs("div", {
                          className: "text-slate-400",
                          children: ["Avg. distance: ", /*#__PURE__*/_jsxs("span", {
                            className: "text-slate-200",
                            children: [d.avg_distance_mi, " mi"]
                          })]
                        }), /*#__PURE__*/_jsx("div", {
                          style: {
                            color: d.bucket.color
                          },
                          children: d.bucket.label
                        })]
                      });
                    }
                  }), /*#__PURE__*/_jsx(Scatter, {
                    data: scatterData,
                    children: scatterData.map((d, i) => /*#__PURE__*/_jsx(Cell, {
                      fill: d.bucket.color
                    }, i))
                  })]
                })
              })
            }), /*#__PURE__*/_jsxs("div", {
              className: "flex gap-4 mt-2 text-[11px] text-slate-500",
              children: [/*#__PURE__*/_jsxs("span", {
                className: "flex items-center gap-1",
                children: [/*#__PURE__*/_jsx("span", {
                  className: "w-2 h-2 rounded-full inline-block",
                  style: {
                    background: "#2dd4bf"
                  }
                }), "Core"]
              }), /*#__PURE__*/_jsxs("span", {
                className: "flex items-center gap-1",
                children: [/*#__PURE__*/_jsx("span", {
                  className: "w-2 h-2 rounded-full inline-block",
                  style: {
                    background: "#facc15"
                  }
                }), "Extended"]
              }), /*#__PURE__*/_jsxs("span", {
                className: "flex items-center gap-1",
                children: [/*#__PURE__*/_jsx("span", {
                  className: "w-2 h-2 rounded-full inline-block",
                  style: {
                    background: "#fb7185"
                  }
                }), "Long-haul"]
              })]
            })]
          }), /*#__PURE__*/_jsxs("div", {
            className: "bg-slate-900/60 border border-slate-800 rounded-lg p-4",
            children: [/*#__PURE__*/_jsx("h3", {
              className: "text-sm font-semibold text-slate-200 mb-3",
              children: "Top Origin Counties"
            }), /*#__PURE__*/_jsxs("p", {
              className: "text-[11px] text-slate-500 mb-3",
              children: ["% share of ", quarter, "'s device sample (n=", fmt(snap.total_devices), ")"]
            }), /*#__PURE__*/_jsx("div", {
              className: "space-y-2",
              children: snap.top_counties.slice(0, 12).map((c, i) => {
                const maxShare = snap.top_counties[0].share;
                const pct = c.share / maxShare * 100;
                const bucket = distanceBucket(c.avg_distance_mi);
                return /*#__PURE__*/_jsxs("div", {
                  className: "text-xs",
                  children: [/*#__PURE__*/_jsxs("div", {
                    className: "flex justify-between mb-0.5",
                    children: [/*#__PURE__*/_jsx("span", {
                      className: "text-slate-300 truncate",
                      children: c.label
                    }), /*#__PURE__*/_jsx("span", {
                      className: "text-slate-400 font-mono",
                      children: fmtPct(c.share)
                    })]
                  }), /*#__PURE__*/_jsx("div", {
                    className: "h-1.5 bg-slate-800 rounded-full overflow-hidden",
                    children: /*#__PURE__*/_jsx("div", {
                      className: "h-full rounded-full",
                      style: {
                        width: `${pct}%`,
                        background: bucket.color
                      }
                    })
                  })]
                }, (c.fips || c.label) + i);
              })
            })]
          })]
        }), /*#__PURE__*/_jsxs("div", {
          className: "grid md:grid-cols-2 gap-4 mb-6",
          children: [/*#__PURE__*/_jsx(BreakdownPanel, {
            title: "By State",
            rows: snap.by_state,
            rowKey: "state",
            total: snap.total_devices
          }), /*#__PURE__*/_jsx(BreakdownPanel, {
            title: "By Country",
            rows: snap.by_country,
            rowKey: "country",
            total: snap.total_devices
          })]
        }), /*#__PURE__*/_jsxs("div", {
          className: "bg-slate-900/60 border border-slate-800 rounded-lg p-4",
          children: [/*#__PURE__*/_jsxs("div", {
            className: "flex items-center justify-between mb-3 flex-wrap gap-2",
            children: [/*#__PURE__*/_jsxs("div", {
              className: "flex items-center gap-1.5",
              children: [/*#__PURE__*/_jsx(TrendingUp, {
                className: "w-3.5 h-3.5 text-cyan-400"
              }), /*#__PURE__*/_jsx("h3", {
                className: "text-sm font-semibold text-slate-200",
                children: "Quarterly Trend"
              })]
            }), /*#__PURE__*/_jsxs("div", {
              className: "flex gap-1 text-xs",
              children: [/*#__PURE__*/_jsxs("button", {
                onClick: () => setTrendMode("indexed"),
                className: `px-2.5 py-1 rounded border ${trendMode === "indexed" ? "border-amber-400 bg-amber-400/10 text-amber-300" : "border-slate-700 text-slate-400"}`,
                children: ["Indexed (", quarters[0], "=100)"]
              }), /*#__PURE__*/_jsx("button", {
                onClick: () => setTrendMode("raw"),
                className: `px-2.5 py-1 rounded border ${trendMode === "raw" ? "border-amber-400 bg-amber-400/10 text-amber-300" : "border-slate-700 text-slate-400"}`,
                children: "Raw sample count"
              })]
            })]
          }), /*#__PURE__*/_jsx("div", {
            style: {
              width: "100%",
              height: 200
            },
            children: /*#__PURE__*/_jsx(ResponsiveContainer, {
              children: /*#__PURE__*/_jsxs(LineChart, {
                data: trend,
                margin: {
                  top: 5,
                  right: 20,
                  bottom: 0,
                  left: 0
                },
                children: [/*#__PURE__*/_jsx(CartesianGrid, {
                  stroke: "#1e293b",
                  vertical: false
                }), /*#__PURE__*/_jsx(XAxis, {
                  dataKey: "quarter",
                  tick: {
                    fill: "#64748b",
                    fontSize: 10
                  },
                  interval: 1
                }), /*#__PURE__*/_jsx(YAxis, {
                  tick: {
                    fill: "#64748b",
                    fontSize: 10
                  },
                  tickFormatter: trendMode === "indexed" ? v => v : fmt
                }), /*#__PURE__*/_jsx(Tooltip, {
                  contentStyle: {
                    background: "#0f172a",
                    border: "1px solid #334155",
                    borderRadius: 6,
                    fontSize: 12
                  },
                  labelStyle: {
                    color: "#e2e8f0"
                  },
                  formatter: v => trendMode === "indexed" ? [v, `Index (${quarters[0]}=100)`] : [fmt(v), "Devices (sample)"]
                }), /*#__PURE__*/_jsx(ReferenceLine, {
                  x: quarter,
                  stroke: "#facc15",
                  strokeDasharray: "4 4"
                }), trendMode === "indexed" && /*#__PURE__*/_jsx(ReferenceLine, {
                  y: 100,
                  stroke: "#475569",
                  strokeDasharray: "2 2"
                }), /*#__PURE__*/_jsx(Line, {
                  type: "monotone",
                  dataKey: "devices",
                  stroke: "#2dd4bf",
                  strokeWidth: 2,
                  dot: {
                    r: 2,
                    fill: "#2dd4bf"
                  }
                })]
              })
            })
          }), /*#__PURE__*/_jsx("p", {
            className: "text-[11px] text-slate-500 mt-2 leading-relaxed",
            children: trendMode === "indexed" ? `Indexed to ${quarters[0]} = 100 so relative movement is easier to read. This does not correct for the mobility panel's own size changing over time — it only rescales this airport's own sample against its own starting point. A true panel-normalized trend needs an independent panel-size index from the data vendor (see note below).` : "Raw sample counts. These reflect both real travel patterns and the mobility panel's size that quarter — not directly comparable across quarters without a panel-size adjustment."
          })]
        }), /*#__PURE__*/_jsx("p", {
          className: "text-[11px] text-slate-600 mt-4 leading-relaxed",
          children: "Methodology: aggregated from hashed-device evening-location pings matched against a drawn facility polygon. No device-level data is displayed. Figures are shown as share of each quarter's device sample, not raw visitation counts, since the underlying panel is a sample of true travel volume and its size varies by period. County names use Census county boundaries rather than the raw feed's metro/CBSA labels, so distinct counties (e.g. Dallas vs. Tarrant) no longer render as duplicate-looking entries. International locations (e.g. Ciudad Juárez, MX) are kept in a separate namespace from US county FIPS to avoid incidental code collisions. Normalizing the trend for panel-size drift over time requires an independent panel index from the mobility vendor, which isn't part of this extract — happy to wire that in as soon as it's available."
        })]
      }), tab === "leakage" && /*#__PURE__*/_jsxs("div", {
        className: "space-y-4",
        children: [/*#__PURE__*/_jsx(LeakageOverlapMap, {
          DATA: DATA,
          geometry: TX_COUNTY_GEOMETRY
        }), /*#__PURE__*/_jsx(AirportLeakageTrend, {
          DATA: DATA,
          airport: airport
        }), /*#__PURE__*/_jsx(RoadmapPanel, {
          type: "leakage"
        })]
      }), tab === "destinations" && /*#__PURE__*/_jsx(DestinationsPanel, {
        DESTINATIONS: DESTINATIONS,
        airport: airport,
        airportCodes: airportCodes
      })]
    }), /*#__PURE__*/_jsx("style", {
      children: `
        @keyframes pulseDot { 0%,100% { opacity: .25 } 50% { opacity: 1 } }
      `
    })]
  });
}
const AIRPORT_COLOR_PALETTE = ["#facc15", "#2dd4bf", "#fb7185", "#818cf8", "#4ade80", "#f472b6", "#38bdf8", "#fb923c", "#a78bfa", "#e879f9", "#fbbf24", "#34d399", "#60a5fa", "#f87171"];
function airportColor(code, airportCodes) {
  const i = airportCodes.indexOf(code);
  return AIRPORT_COLOR_PALETTE[i >= 0 ? i % AIRPORT_COLOR_PALETTE.length : 0];
}
function LeakageOverlapMap({
  DATA,
  geometry
}) {
  const airportCodes = useMemo(() => DATA ? Object.keys(DATA) : [], [DATA]);
  const colorFor = code => airportColor(code, airportCodes);
  const allQuarters = useMemo(() => multiAirportQuarters(DATA, airportCodes), [DATA, airportCodes]);
  const [qIdx, setQIdx] = useState(-1);
  useEffect(() => {
    if (allQuarters.length && qIdx === -1) setQIdx(allQuarters.length - 1);
  }, [allQuarters, qIdx]);
  const safeQIdx = allQuarters.length ? Math.min(Math.max(qIdx, 0), allQuarters.length - 1) : 0;
  const quarter = allQuarters[safeQIdx];
  const [hovered, setHovered] = useState(null);
  const [overlapOnly, setOverlapOnly] = useState(false);
  const [mousePos, setMousePos] = useState({
    x: 0,
    y: 0
  });
  const containerRef = useRef(null);

  // Which airports participate in the pooled comparison. Defaults to all,
  // once the airport list is known -- lets you isolate a head-to-head
  // (e.g. just ELP vs ABQ) by deselecting everyone else, instead of always
  // seeing the full 10-airport picture.
  const [activeCodes, setActiveCodes] = useState(new Set());
  const [initialized, setInitialized] = useState(false);
  useEffect(() => {
    if (airportCodes.length && !initialized) {
      setActiveCodes(new Set(airportCodes));
      setInitialized(true);
    }
  }, [airportCodes, initialized]);
  function toggleAirport(code) {
    setActiveCodes(prev => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);else next.add(code);
      return next;
    });
  }
  function handleMouseMove(e) {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    setMousePos({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    });
  }

  // For every TX county, pool RAW device counts across every SELECTED
  // airport that has data for that county this quarter, then rank airports
  // by their share of that county's own combined total -- NOT their share
  // of the airport's own overall sample. This is what makes it a fair "who
  // actually wins this county" comparison instead of an artifact of one
  // airport's panel being bigger than another's.
  const countyRankings = useMemo(() => {
    if (!DATA || !quarter) return {};
    const pooled = {}; // fips -> [{code, devices}]
    for (const code of airportCodes) {
      if (!activeCodes.has(code)) continue;
      const snap = DATA[code].quarters[quarter];
      if (!snap || !snap.tx_counties) continue;
      for (const [fips, devices] of Object.entries(snap.tx_counties)) {
        if (!devices) continue;
        (pooled[fips] = pooled[fips] || []).push({
          code,
          devices
        });
      }
    }
    const rankings = {};
    for (const [fips, entries] of Object.entries(pooled)) {
      const total = entries.reduce((s, e) => s + e.devices, 0);
      const ranked = entries.map(e => ({
        ...e,
        share: e.devices / total
      })).sort((a, b) => b.share - a.share);
      const contested = ranked.length >= 2 && ranked[1].share >= 0.25; // runner-up has a real foothold
      rankings[fips] = {
        ranked,
        total,
        contested
      };
    }
    return rankings;
  }, [DATA, quarter, airportCodes, activeCodes]);
  const nearestAirports = useMemo(() => computeNearestAirports(geometry, DATA, airportCodes.filter(c => activeCodes.has(c))), [geometry, DATA, airportCodes, activeCodes]);
  const [showMismatch, setShowMismatch] = useState(false);
  const mismatchCount = Object.entries(countyRankings).filter(([fips, r]) => nearestAirports[fips] && r.ranked[0].code !== nearestAirports[fips].code).length;
  const contestedCount = Object.values(countyRankings).filter(r => r.contested).length;
  const {
    features,
    pathFor
  } = useMemo(() => {
    const fc = {
      type: "FeatureCollection",
      features: geometry.map(c => ({
        type: "Feature",
        properties: {
          fips: c.fips,
          name: c.name
        },
        geometry: {
          type: c.type,
          coordinates: c.coordinates
        }
      }))
    };
    const projection = d3.geoMercator().fitSize([760, 620], fc);
    return {
      features: fc.features,
      pathFor: d3.geoPath(projection)
    };
  }, [geometry]);
  if (!DATA || !quarter) return null;
  return /*#__PURE__*/_jsxs("div", {
    className: "bg-slate-900/60 border border-slate-800 rounded-lg p-4",
    children: [/*#__PURE__*/_jsxs("div", {
      className: "flex items-center justify-between mb-1 flex-wrap gap-2",
      children: [/*#__PURE__*/_jsx("h3", {
        className: "text-sm font-semibold text-slate-200",
        children: "Catchment Overlap by County"
      }), /*#__PURE__*/_jsxs("div", {
        className: "flex items-center gap-2 flex-wrap",
        children: [/*#__PURE__*/_jsx("button", {
          onClick: () => setShowMismatch(v => !v),
          className: `px-2.5 py-1 rounded text-xs border transition-colors ${showMismatch ? "border-cyan-400 bg-cyan-400/10 text-cyan-300" : "border-slate-700 text-slate-400"}`,
          children: showMismatch ? `Showing: bypasses nearest airport (${mismatchCount})` : "Show geographic bypass"
        }), /*#__PURE__*/_jsx("button", {
          onClick: () => setOverlapOnly(v => !v),
          className: `px-2.5 py-1 rounded text-xs border transition-colors ${overlapOnly ? "border-amber-400 bg-amber-400/10 text-amber-300" : "border-slate-700 text-slate-400"}`,
          children: overlapOnly ? "Showing: contested counties only" : "Show all counties"
        }), /*#__PURE__*/_jsx(Info, {
          className: "w-3.5 h-3.5 text-slate-600"
        })]
      })]
    }), /*#__PURE__*/_jsxs("p", {
      className: "text-xs text-slate-500 mb-1",
      children: ["Each county colored by whichever tracked airport has the largest share of that county's pooled device sample this quarter — this is the actual leakage picture, not a distance estimate.", showMismatch && " Ring-outlined counties: the airport that WINS the county's device sample isn't the geographically nearest one \u2014 real bypass behavior, not just a data artifact."]
    }), /*#__PURE__*/_jsxs("p", {
      className: "text-xs text-slate-500 mb-3",
      children: [quarter, " · ", activeCodes.size, " of ", airportCodes.length, " airports selected ·", " ", activeCodes.size < 2 ? "select at least 2 to see contested counties" : `${contestedCount} of ${Object.keys(countyRankings).length} counties with any data are contested`, " ", "· hover any county for the full breakdown"]
    }), /*#__PURE__*/_jsxs("div", {
      className: "flex items-center gap-2 mb-2",
      children: [/*#__PURE__*/_jsx("span", {
        className: "text-[11px] text-slate-500",
        children: "Quarter:"
      }), /*#__PURE__*/_jsx("input", {
        type: "range",
        min: 0,
        max: Math.max(allQuarters.length - 1, 0),
        value: safeQIdx,
        onChange: e => setQIdx(Number(e.target.value)),
        className: "flex-1 accent-amber-400"
      }), /*#__PURE__*/_jsx("span", {
        className: "text-xs font-mono text-amber-400 w-16 text-right",
        children: quarter
      })]
    }), /*#__PURE__*/_jsxs("div", {
      className: "relative",
      ref: containerRef,
      onMouseMove: handleMouseMove,
      children: [/*#__PURE__*/_jsxs("svg", {
        viewBox: "0 0 760 620",
        className: "w-full h-auto",
        children: [/*#__PURE__*/_jsx("defs", {
          children: /*#__PURE__*/_jsx("pattern", {
            id: "contested-hatch",
            patternUnits: "userSpaceOnUse",
            width: "6",
            height: "6",
            patternTransform: "rotate(45)",
            children: /*#__PURE__*/_jsx("line", {
              x1: "0",
              y1: "0",
              x2: "0",
              y2: "6",
              stroke: "#0f172a",
              strokeWidth: "2"
            })
          })
        }), features.map(f => {
          const r = countyRankings[f.properties.fips];
          const nearest = nearestAirports[f.properties.fips];
          const isMismatch = r && nearest && r.ranked[0].code !== nearest.code;
          const isHovered = hovered && hovered.fips === f.properties.fips;
          const dim = overlapOnly && r && !r.contested || showMismatch && !isMismatch;
          const fill = r ? colorFor(r.ranked[0].code) : "#1e293b";
          return /*#__PURE__*/_jsxs("g", {
            opacity: dim ? 0.12 : 1,
            children: [/*#__PURE__*/_jsx("path", {
              d: pathFor(f),
              fill: fill,
              stroke: isHovered ? "#facc15" : showMismatch && isMismatch ? "#22d3ee" : "#0f172a",
              strokeWidth: isHovered ? 1.5 : showMismatch && isMismatch ? 1.4 : 0.6,
              onMouseEnter: () => setHovered({
                fips: f.properties.fips,
                name: f.properties.name,
                ranking: r,
                nearest
              }),
              onMouseLeave: () => setHovered(null),
              style: {
                cursor: r ? "pointer" : "default",
                transition: "opacity 0.15s"
              }
            }), r?.contested && !dim && /*#__PURE__*/_jsx("path", {
              d: pathFor(f),
              fill: "url(#contested-hatch)",
              opacity: 0.55,
              style: {
                pointerEvents: "none"
              }
            })]
          }, f.properties.fips);
        })]
      }), hovered?.ranking && /*#__PURE__*/_jsxs("div", {
        className: "absolute bg-slate-900 border border-slate-700 rounded-md px-3 py-2 text-xs max-w-[220px] pointer-events-none z-10",
        style: {
          left: Math.min(mousePos.x + 14, 560),
          top: Math.max(mousePos.y - 10, 0)
        },
        children: [/*#__PURE__*/_jsxs("div", {
          className: "font-semibold text-slate-100 mb-1",
          children: [hovered.name, " County, TX"]
        }), hovered.ranking.ranked.slice(0, 4).map((e, i) => /*#__PURE__*/_jsxs("div", {
          className: "flex justify-between gap-3",
          children: [/*#__PURE__*/_jsxs("span", {
            className: "flex items-center gap-1",
            style: {
              color: i === 0 ? colorFor(e.code) : "#94a3b8"
            },
            children: [/*#__PURE__*/_jsx("span", {
              className: "w-2 h-2 rounded-full inline-block",
              style: {
                background: colorFor(e.code)
              }
            }), e.code]
          }), /*#__PURE__*/_jsx("span", {
            className: "font-mono text-slate-300",
            children: fmtPct(e.share)
          })]
        }, e.code)), hovered.nearest && /*#__PURE__*/_jsxs("div", {
          className: "text-slate-500 mt-1.5 pt-1.5 border-t border-slate-800",
          children: ["Nearest airport: ", /*#__PURE__*/_jsx("span", {
            className: "text-slate-300",
            children: hovered.nearest.code
          }), " (", hovered.nearest.dist.toFixed(0), " mi)"]
        }), hovered.ranking.ranked[0].code !== hovered.nearest?.code && hovered.nearest && /*#__PURE__*/_jsx("div", {
          className: "text-cyan-400 text-[10px]",
          children: "Bypasses nearest airport"
        }), hovered.ranking.contested && /*#__PURE__*/_jsx("div", {
          className: "text-amber-400 mt-1 text-[10px]",
          children: "Contested — runner-up holds ≥25% here"
        })]
      }), hovered && !hovered.ranking && /*#__PURE__*/_jsxs("div", {
        className: "absolute bg-slate-900 border border-slate-700 rounded-md px-3 py-2 text-xs pointer-events-none z-10",
        style: {
          left: Math.min(mousePos.x + 14, 560),
          top: Math.max(mousePos.y - 10, 0)
        },
        children: [/*#__PURE__*/_jsxs("div", {
          className: "font-semibold text-slate-100",
          children: [hovered.name, " County, TX"]
        }), /*#__PURE__*/_jsx("div", {
          className: "text-slate-500",
          children: "No tracked airport has sample data from this county."
        })]
      })]
    }), /*#__PURE__*/_jsxs("div", {
      className: "flex items-center justify-between mt-3 mb-1.5",
      children: [/*#__PURE__*/_jsx("span", {
        className: "text-[11px] text-slate-500",
        children: "Tap an airport to include/exclude it from the comparison:"
      }), /*#__PURE__*/_jsxs("div", {
        className: "flex gap-1.5",
        children: [/*#__PURE__*/_jsx("button", {
          onClick: () => setActiveCodes(new Set(airportCodes)),
          className: "text-[11px] px-2 py-0.5 rounded border border-slate-700 text-slate-400 hover:border-slate-500",
          children: "All"
        }), /*#__PURE__*/_jsx("button", {
          onClick: () => setActiveCodes(new Set()),
          className: "text-[11px] px-2 py-0.5 rounded border border-slate-700 text-slate-400 hover:border-slate-500",
          children: "None"
        })]
      })]
    }), /*#__PURE__*/_jsx("div", {
      className: "flex flex-wrap gap-1.5 text-[11px] items-center",
      children: airportCodes.map(code => {
        const active = activeCodes.has(code);
        return /*#__PURE__*/_jsxs("button", {
          onClick: () => toggleAirport(code),
          className: `flex items-center gap-1 px-2 py-1 rounded border transition-opacity ${active ? "border-slate-600" : "border-slate-800 opacity-40"}`,
          children: [/*#__PURE__*/_jsx("span", {
            className: "w-2.5 h-2.5 rounded-sm inline-block",
            style: {
              background: colorFor(code)
            }
          }), /*#__PURE__*/_jsx("span", {
            className: active ? "text-slate-300" : "text-slate-600",
            children: code
          })]
        }, code);
      })
    }), /*#__PURE__*/_jsxs("div", {
      className: "flex flex-wrap gap-3 mt-2 text-[11px] text-slate-500 items-center",
      children: [/*#__PURE__*/_jsxs("span", {
        className: "flex items-center gap-1",
        children: [/*#__PURE__*/_jsx("span", {
          className: "w-2.5 h-2.5 rounded-sm inline-block",
          style: {
            background: "#1e293b"
          }
        }), "No data"]
      }), /*#__PURE__*/_jsxs("span", {
        className: "flex items-center gap-1 pl-2 border-l border-slate-700",
        children: [/*#__PURE__*/_jsxs("svg", {
          width: "14",
          height: "14",
          className: "rounded-sm overflow-hidden",
          children: [/*#__PURE__*/_jsx("rect", {
            width: "14",
            height: "14",
            fill: "#475569"
          }), /*#__PURE__*/_jsx("rect", {
            width: "14",
            height: "14",
            fill: "url(#contested-hatch)",
            opacity: 0.55
          })]
        }), "Hatched = contested (2nd airport ≥25% share)"]
      })]
    }), /*#__PURE__*/_jsx("p", {
      className: "text-[11px] text-slate-600 mt-3 leading-relaxed",
      children: "Methodology: for each county, every SELECTED airport's device count from that county (same quarter) is pooled, then each airport's share is computed against that county-specific pool — not against the airport's own overall sample size. A county is \"contested\" when a non-dominant airport still holds at least 25% of the pooled total. \"Nearest airport\" is computed independently of any device data — straight- line distance from the county's true geometric centroid to each selected airport's coordinates — so \"bypasses nearest airport\" counties are a genuine geographic signal, not a data artifact. Airports with no processed extract yet simply don't appear in the pool, so this map fills in automatically as more extracts are added, with no code changes needed."
    })]
  });
}
function TexasCountyMap({
  countyShares,
  countyDevices,
  geometry,
  width = 760,
  height = 620
}) {
  const [hovered, setHovered] = useState(null);
  const {
    features,
    pathFor
  } = useMemo(() => {
    const fc = {
      type: "FeatureCollection",
      features: geometry.map(c => ({
        type: "Feature",
        properties: {
          fips: c.fips,
          name: c.name
        },
        geometry: {
          type: c.type,
          coordinates: c.coordinates
        }
      }))
    };
    const projection = d3.geoMercator().fitSize([width, height], fc);
    const path = d3.geoPath(projection);
    return {
      features: fc.features,
      pathFor: path
    };
  }, [width, height, geometry]);
  return /*#__PURE__*/_jsxs("div", {
    className: "relative",
    children: [/*#__PURE__*/_jsx("svg", {
      viewBox: `0 0 ${width} ${height}`,
      className: "w-full h-auto",
      children: features.map(f => {
        const share = countyShares[f.properties.fips] || 0;
        const devices = countyDevices[f.properties.fips] || 0;
        const isHovered = hovered && hovered.fips === f.properties.fips;
        return /*#__PURE__*/_jsx("path", {
          d: pathFor(f),
          fill: countyColor(share),
          stroke: isHovered ? "#facc15" : "#0f172a",
          strokeWidth: isHovered ? 1.5 : 0.6,
          onMouseEnter: () => setHovered({
            fips: f.properties.fips,
            name: f.properties.name,
            share,
            devices
          }),
          onMouseLeave: () => setHovered(null),
          style: {
            cursor: "pointer",
            transition: "stroke 0.1s"
          }
        }, f.properties.fips);
      })
    }), hovered && /*#__PURE__*/_jsxs("div", {
      className: "absolute top-2 left-2 bg-slate-900 border border-slate-700 rounded-md px-3 py-2 text-xs pointer-events-none",
      children: [/*#__PURE__*/_jsxs("div", {
        className: "font-semibold text-slate-100",
        children: [hovered.name, " County, TX"]
      }), /*#__PURE__*/_jsxs("div", {
        className: "text-slate-400",
        children: ["Share of sample: ", /*#__PURE__*/_jsx("span", {
          className: "text-slate-200 font-mono",
          children: fmtPct(hovered.share)
        })]
      }), /*#__PURE__*/_jsxs("div", {
        className: "text-slate-500",
        children: ["(", fmt(hovered.devices), " devices in sample)"]
      })]
    })]
  });
}
function BreakdownPanel({
  title,
  rows,
  rowKey,
  total,
  limit = 8
}) {
  const list = rows || [];
  const shown = list.slice(0, limit);
  const otherShare = list.slice(limit).reduce((s, r) => s + r.share, 0);
  const otherDevices = list.slice(limit).reduce((s, r) => s + r.devices, 0);
  const maxShare = shown[0]?.share || 1;
  return /*#__PURE__*/_jsxs("div", {
    className: "bg-slate-900/60 border border-slate-800 rounded-lg p-4",
    children: [/*#__PURE__*/_jsx("h3", {
      className: "text-sm font-semibold text-slate-200 mb-3",
      children: title
    }), !list.length ? /*#__PURE__*/_jsx("p", {
      className: "text-xs text-slate-600",
      children: "No data for this quarter."
    }) : /*#__PURE__*/_jsxs("div", {
      className: "space-y-2",
      children: [shown.map((r, i) => /*#__PURE__*/_jsxs("div", {
        className: "text-xs",
        children: [/*#__PURE__*/_jsxs("div", {
          className: "flex justify-between mb-0.5",
          children: [/*#__PURE__*/_jsx("span", {
            className: "text-slate-300",
            children: r[rowKey]
          }), /*#__PURE__*/_jsxs("span", {
            className: "text-slate-400 font-mono",
            children: [fmtPct(r.share), " · ", fmt(r.devices)]
          })]
        }), /*#__PURE__*/_jsx("div", {
          className: "h-1.5 bg-slate-800 rounded-full overflow-hidden",
          children: /*#__PURE__*/_jsx("div", {
            className: "h-full rounded-full bg-cyan-400",
            style: {
              width: `${r.share / maxShare * 100}%`
            }
          })
        })]
      }, r[rowKey] + i)), list.length > limit && /*#__PURE__*/_jsx("div", {
        className: "text-xs pt-1",
        children: /*#__PURE__*/_jsxs("div", {
          className: "flex justify-between mb-0.5 text-slate-500",
          children: [/*#__PURE__*/_jsxs("span", {
            children: ["Other (", list.length - limit, ")"]
          }), /*#__PURE__*/_jsxs("span", {
            className: "font-mono",
            children: [fmtPct(otherShare), " · ", fmt(otherDevices)]
          })]
        })
      })]
    })]
  });
}
function KPI({
  label,
  value,
  sub,
  subColor = "text-slate-500"
}) {
  return /*#__PURE__*/_jsxs("div", {
    className: "bg-slate-900/60 border border-slate-800 rounded-lg p-4",
    children: [/*#__PURE__*/_jsx("div", {
      className: "text-[11px] uppercase tracking-wider text-slate-500 mb-1",
      children: label
    }), /*#__PURE__*/_jsx("div", {
      className: "text-2xl font-semibold text-slate-100 font-mono",
      children: value
    }), /*#__PURE__*/_jsx("div", {
      className: `text-[11px] mt-1 ${subColor}`,
      children: sub
    })]
  });
}
function AirportLeakageTrend({
  DATA,
  airport
}) {
  const airportCodes = useMemo(() => DATA ? Object.keys(DATA) : [], [DATA]);
  const quarters = useMemo(() => multiAirportQuarters(DATA, airportCodes), [DATA, airportCodes]);
  const CATCHMENT_SHARE_THRESHOLD = 0.10;

  // Pool every airport's raw device count per county, for a given quarter.
  function poolCounty(q) {
    const pooled = {}; // fips -> {code: devices}
    for (const code of airportCodes) {
      const snap = DATA[code].quarters[q];
      if (!snap?.tx_counties) continue;
      for (const [fips, devices] of Object.entries(snap.tx_counties)) {
        if (!devices) continue;
        (pooled[fips] = pooled[fips] || {})[code] = devices;
      }
    }
    return pooled;
  }

  // This airport's catchment = counties where it holds a REAL share (>=10%)
  // of that county's cross-airport pooled sample, as of the latest
  // comparable quarter -- not just "any county it's ever appeared in".
  // That distinction matters: a small airport shows up with a handful of
  // devices in huge population centers (Houston, Dallas) it doesn't
  // meaningfully serve; including those would let those metros' sheer size
  // swamp the comparison. Requiring a real share keeps this to counties
  // that are actually contested or owned by this airport.
  const catchmentFips = useMemo(() => {
    if (!quarters.length) return new Set();
    const latestQ = quarters[quarters.length - 1];
    const pooled = poolCounty(latestQ);
    const set = new Set();
    for (const [fips, byCode] of Object.entries(pooled)) {
      const total = Object.values(byCode).reduce((a, b) => a + b, 0);
      if (total && (byCode[airport] || 0) / total >= CATCHMENT_SHARE_THRESHOLD) set.add(fips);
    }
    return set;
  }, [DATA, airport, quarters, airportCodes]);
  const trend = useMemo(() => {
    return quarters.map(q => {
      const pooled = poolCounty(q);
      const totals = {};
      for (const fips of catchmentFips) {
        const byCode = pooled[fips];
        if (!byCode) continue;
        for (const [code, devices] of Object.entries(byCode)) {
          totals[code] = (totals[code] || 0) + devices;
        }
      }
      const total = Object.values(totals).reduce((a, b) => a + b, 0);
      const shares = Object.fromEntries(Object.entries(totals).map(([c, d]) => [c, total ? d / total : 0]));
      return {
        quarter: q,
        shares,
        total
      };
    });
  }, [quarters, catchmentFips, DATA, airportCodes]);
  if (!trend.length || !catchmentFips.size) {
    return /*#__PURE__*/_jsxs("div", {
      className: "bg-slate-900/60 border border-slate-800 rounded-lg p-4",
      children: [/*#__PURE__*/_jsxs("h3", {
        className: "text-sm font-semibold text-slate-200 mb-1",
        children: ["Leakage Trend — ", airport]
      }), /*#__PURE__*/_jsxs("p", {
        className: "text-xs text-slate-500",
        children: ["Not enough overlapping data yet. This needs at least one quarter where ", airport, " AND at least one other tracked airport both have processed extracts."]
      })]
    });
  }
  const latest = trend[trend.length - 1];
  const selfShare = latest.shares[airport] || 0;

  // Rank competitors (everyone except the selected airport) by their most
  // recent share, so the chart legend/lines always lead with whoever
  // currently matters most.
  const competitors = Object.keys(latest.shares).filter(c => c !== airport).sort((a, b) => (latest.shares[b] || 0) - (latest.shares[a] || 0)).slice(0, 5);
  const chartData = trend.map(t => ({
    quarter: t.quarter,
    ...Object.fromEntries(competitors.map(c => [c, Math.round((t.shares[c] || 0) * 1000) / 10]))
  }));
  const maxCompetitorPct = Math.max(1, ...chartData.flatMap(d => competitors.map(c => d[c] || 0)));
  const yMax = Math.min(100, Math.ceil(maxCompetitorPct * 1.3 / 5) * 5);
  return /*#__PURE__*/_jsxs("div", {
    className: "bg-slate-900/60 border border-slate-800 rounded-lg p-4",
    children: [/*#__PURE__*/_jsxs("div", {
      className: "flex items-center justify-between mb-1",
      children: [/*#__PURE__*/_jsxs("h3", {
        className: "text-sm font-semibold text-slate-200",
        children: ["Leakage Trend — ", airport, "'s Catchment"]
      }), /*#__PURE__*/_jsx(Info, {
        className: "w-3.5 h-3.5 text-slate-600"
      })]
    }), /*#__PURE__*/_jsxs("p", {
      className: "text-xs text-slate-500 mb-4",
      children: ["Region = TX counties where ", airport, " holds ≥10% of that county's cross-airport sample as of the latest quarter (", catchmentFips.size, " counties). Shows what share of that combined pool each airport actually captures, ", latest.quarter, "."]
    }), /*#__PURE__*/_jsxs("div", {
      className: "flex gap-3 mb-4 flex-wrap items-stretch",
      children: [/*#__PURE__*/_jsxs("div", {
        className: "rounded-md border border-amber-400/40 bg-amber-400/5 px-4 py-3 flex flex-col justify-center",
        children: [/*#__PURE__*/_jsxs("div", {
          className: "text-[11px] text-slate-500",
          children: [airport, " self-capture"]
        }), /*#__PURE__*/_jsx("div", {
          className: "text-2xl font-mono text-amber-300",
          children: fmtPct(selfShare)
        }), /*#__PURE__*/_jsx("div", {
          className: "text-[10px] text-slate-500",
          children: "of its own catchment's pooled sample"
        })]
      }), competitors.slice(0, 3).map(code => /*#__PURE__*/_jsxs("div", {
        className: "flex-1 min-w-[90px] rounded-md border border-slate-700 px-3 py-2",
        children: [/*#__PURE__*/_jsx("div", {
          className: "text-[11px] text-slate-500",
          children: code
        }), /*#__PURE__*/_jsx("div", {
          className: "text-lg font-mono",
          style: {
            color: airportColor(code, airportCodes)
          },
          children: fmtPct(latest.shares[code] || 0)
        }), /*#__PURE__*/_jsx("div", {
          className: "text-[10px] text-slate-500",
          children: "competitor share"
        })]
      }, code))]
    }), /*#__PURE__*/_jsxs("p", {
      className: "text-[11px] text-slate-500 mb-1",
      children: ["Competitor share over time — ", airport, " itself is excluded from this chart (shown as the badge above instead) so the y-axis isn't squashed flat by its much larger share."]
    }), /*#__PURE__*/_jsx("div", {
      style: {
        width: "100%",
        height: 180
      },
      children: /*#__PURE__*/_jsx(ResponsiveContainer, {
        children: /*#__PURE__*/_jsxs(LineChart, {
          data: chartData,
          margin: {
            top: 5,
            right: 20,
            bottom: 0,
            left: 0
          },
          children: [/*#__PURE__*/_jsx(CartesianGrid, {
            stroke: "#1e293b",
            vertical: false
          }), /*#__PURE__*/_jsx(XAxis, {
            dataKey: "quarter",
            tick: {
              fill: "#64748b",
              fontSize: 10
            },
            interval: 1
          }), /*#__PURE__*/_jsx(YAxis, {
            tick: {
              fill: "#64748b",
              fontSize: 10
            },
            tickFormatter: v => `${v}%`,
            domain: [0, yMax]
          }), /*#__PURE__*/_jsx(Tooltip, {
            contentStyle: {
              background: "#0f172a",
              border: "1px solid #334155",
              borderRadius: 6,
              fontSize: 12
            },
            labelStyle: {
              color: "#e2e8f0"
            },
            formatter: v => [`${v.toFixed(1)}%`, "share"]
          }), competitors.map(code => /*#__PURE__*/_jsx(Line, {
            type: "monotone",
            dataKey: code,
            stroke: airportColor(code, airportCodes),
            strokeWidth: 2,
            dot: {
              r: 2
            },
            connectNulls: true
          }, code))]
        })
      })
    }), /*#__PURE__*/_jsx("div", {
      className: "flex gap-4 mt-2 text-[11px] text-slate-500 flex-wrap",
      children: competitors.map(code => /*#__PURE__*/_jsxs("span", {
        className: "flex items-center gap-1",
        children: [/*#__PURE__*/_jsx("span", {
          className: "w-2 h-2 rounded-full inline-block",
          style: {
            background: airportColor(code, airportCodes)
          }
        }), code]
      }, code))
    }), /*#__PURE__*/_jsx("p", {
      className: "text-[11px] text-slate-600 mt-3 leading-relaxed",
      children: "Switch airports using the selector at the top of the page — this panel recomputes for whichever airport is currently selected, using only quarters where a real comparison is possible (2+ airports with processed extracts)."
    })]
  });
}
function DestinationsPanel({
  DESTINATIONS,
  airport,
  airportCodes
}) {
  const [direction, setDirection] = useState("outbound");
  const [qIdx, setQIdx] = useState(-1);
  const hasAny = Boolean(DESTINATIONS);
  const hasAirport = Boolean(DESTINATIONS && DESTINATIONS[airport]);
  const quarters = useMemo(() => hasAirport ? Object.keys(DESTINATIONS[airport]).sort(sortQuarters) : [], [DESTINATIONS, airport, hasAirport]);
  useEffect(() => {
    if (quarters.length) setQIdx(quarters.length - 1);
  }, [quarters.length, airport]);
  const safeQIdx = quarters.length ? Math.min(Math.max(qIdx, 0), quarters.length - 1) : 0;
  const quarter = quarters[safeQIdx];
  const snap = quarter ? DESTINATIONS[airport][quarter]?.[direction] : null;
  const trend = useMemo(() => {
    if (!hasAirport) return [];
    return quarters.map(q => ({
      quarter: q,
      outbound: DESTINATIONS[airport][q]?.outbound?.total_trips || 0,
      inbound: DESTINATIONS[airport][q]?.inbound?.total_trips || 0
    }));
  }, [DESTINATIONS, airport, quarters, hasAirport]);
  if (!hasAny) {
    return /*#__PURE__*/_jsxs("div", {
      className: "bg-slate-900/60 border border-slate-800 border-dashed rounded-lg p-10 flex flex-col items-center text-center gap-3",
      children: [/*#__PURE__*/_jsx(Inbox, {
        className: "w-8 h-8 text-slate-600"
      }), /*#__PURE__*/_jsx("div", {
        className: "text-sm font-semibold text-slate-300",
        children: "No destination-trajectory data processed yet"
      }), /*#__PURE__*/_jsxs("p", {
        className: "text-xs text-slate-500 max-w-md",
        children: ["Run ", /*#__PURE__*/_jsx("code", {
          className: "text-amber-400",
          children: "analyze_destinations.py"
        }), " against a device-trajectory extract and upload the resulting ", /*#__PURE__*/_jsx("code", {
          className: "text-amber-400",
          children: "data/destinations_summary.json"
        }), " to enable this tab."]
      })]
    });
  }
  if (!hasAirport) {
    return /*#__PURE__*/_jsxs("div", {
      className: "bg-slate-900/60 border border-slate-800 border-dashed rounded-lg p-10 flex flex-col items-center text-center gap-3",
      children: [/*#__PURE__*/_jsx(Inbox, {
        className: "w-8 h-8 text-slate-600"
      }), /*#__PURE__*/_jsxs("div", {
        className: "text-sm font-semibold text-slate-300",
        children: ["No destination data for ", airport, " yet"]
      }), /*#__PURE__*/_jsxs("p", {
        className: "text-xs text-slate-500 max-w-md",
        children: ["Destination trip data is currently processed for: ", Object.keys(DESTINATIONS).join(", ") || "none", ". Switch airports above, or run ", /*#__PURE__*/_jsx("code", {
          className: "text-amber-400",
          children: "analyze_destinations.py"
        }), " against a", " ", airport, " trajectory extract to add it."]
      })]
    });
  }
  return /*#__PURE__*/_jsxs("div", {
    className: "space-y-4",
    children: [/*#__PURE__*/_jsxs("div", {
      className: "bg-slate-900/60 border border-slate-800 rounded-lg p-4",
      children: [/*#__PURE__*/_jsxs("div", {
        className: "flex items-center justify-between mb-3 flex-wrap gap-2",
        children: [/*#__PURE__*/_jsxs("h3", {
          className: "text-sm font-semibold text-slate-200",
          children: ["Where ", airport, " Travelers Actually Go"]
        }), /*#__PURE__*/_jsx("div", {
          className: "flex gap-1",
          children: ["outbound", "inbound"].map(d => /*#__PURE__*/_jsx("button", {
            onClick: () => setDirection(d),
            className: `px-2.5 py-1 rounded text-xs border capitalize ${direction === d ? "border-amber-400 bg-amber-400/10 text-amber-300" : "border-slate-700 text-slate-400"}`,
            children: d
          }, d))
        })]
      }), /*#__PURE__*/_jsxs("p", {
        className: "text-xs text-slate-500 mb-3",
        children: [direction === "outbound" ? `Devices seen at ${airport}, then later seen at another tracked polygon \u2014 i.e. where they flew to.` : `Devices seen at another tracked polygon, then later seen at ${airport} \u2014 i.e. where they flew in from.`, " ", "Deduplicated to trips (not raw pings); see methodology note below."]
      }), quarters.length > 1 && /*#__PURE__*/_jsxs("div", {
        className: "flex items-center gap-2 mb-4",
        children: [/*#__PURE__*/_jsx("span", {
          className: "text-[11px] text-slate-500",
          children: "Quarter:"
        }), /*#__PURE__*/_jsx("input", {
          type: "range",
          min: 0,
          max: quarters.length - 1,
          value: safeQIdx,
          onChange: e => setQIdx(Number(e.target.value)),
          className: "flex-1 accent-amber-400"
        }), /*#__PURE__*/_jsx("span", {
          className: "text-xs font-mono text-amber-400 w-16 text-right",
          children: quarter
        })]
      }), !snap || !snap.destinations.length ? /*#__PURE__*/_jsxs("p", {
        className: "text-xs text-slate-600",
        children: ["No ", direction, " trips found for ", quarter, "."]
      }) : /*#__PURE__*/_jsxs(_Fragment, {
        children: [/*#__PURE__*/_jsxs("div", {
          className: "text-xs text-slate-500 mb-2",
          children: [quarter, " · ", fmt(snap.total_trips), " total ", direction, " trips"]
        }), /*#__PURE__*/_jsx("div", {
          className: "space-y-2",
          children: snap.destinations.map((d, i) => {
            const maxTrips = snap.destinations[0].trips;
            return /*#__PURE__*/_jsxs("div", {
              className: "text-xs",
              children: [/*#__PURE__*/_jsxs("div", {
                className: "flex justify-between mb-0.5",
                children: [/*#__PURE__*/_jsxs("span", {
                  className: "text-slate-300",
                  children: [d.dest, AIRPORT_REGISTRY[d.dest] ? ` \u2014 ${AIRPORT_REGISTRY[d.dest].name}` : ""]
                }), /*#__PURE__*/_jsxs("span", {
                  className: "text-slate-400 font-mono",
                  children: [fmtPct(d.share), " · ", fmt(d.trips), " trips · ", fmt(d.unique_devices), " devices"]
                })]
              }), /*#__PURE__*/_jsx("div", {
                className: "h-1.5 bg-slate-800 rounded-full overflow-hidden",
                children: /*#__PURE__*/_jsx("div", {
                  className: "h-full rounded-full bg-amber-400",
                  style: {
                    width: `${d.trips / maxTrips * 100}%`
                  }
                })
              })]
            }, d.dest + i);
          })
        })]
      })]
    }), quarters.length > 1 && /*#__PURE__*/_jsxs("div", {
      className: "bg-slate-900/60 border border-slate-800 rounded-lg p-4",
      children: [/*#__PURE__*/_jsx("h3", {
        className: "text-sm font-semibold text-slate-200 mb-3",
        children: "Trip Volume Trend"
      }), /*#__PURE__*/_jsx("div", {
        style: {
          width: "100%",
          height: 180
        },
        children: /*#__PURE__*/_jsx(ResponsiveContainer, {
          children: /*#__PURE__*/_jsxs(LineChart, {
            data: trend,
            margin: {
              top: 5,
              right: 20,
              bottom: 0,
              left: 0
            },
            children: [/*#__PURE__*/_jsx(CartesianGrid, {
              stroke: "#1e293b",
              vertical: false
            }), /*#__PURE__*/_jsx(XAxis, {
              dataKey: "quarter",
              tick: {
                fill: "#64748b",
                fontSize: 10
              },
              interval: 1
            }), /*#__PURE__*/_jsx(YAxis, {
              tick: {
                fill: "#64748b",
                fontSize: 10
              },
              tickFormatter: fmt
            }), /*#__PURE__*/_jsx(Tooltip, {
              contentStyle: {
                background: "#0f172a",
                border: "1px solid #334155",
                borderRadius: 6,
                fontSize: 12
              },
              labelStyle: {
                color: "#e2e8f0"
              }
            }), /*#__PURE__*/_jsx(Line, {
              type: "monotone",
              dataKey: "outbound",
              stroke: "#facc15",
              strokeWidth: 2,
              dot: {
                r: 2
              }
            }), /*#__PURE__*/_jsx(Line, {
              type: "monotone",
              dataKey: "inbound",
              stroke: "#2dd4bf",
              strokeWidth: 2,
              dot: {
                r: 2
              }
            })]
          })
        })
      }), /*#__PURE__*/_jsxs("div", {
        className: "flex gap-4 mt-2 text-[11px] text-slate-500",
        children: [/*#__PURE__*/_jsxs("span", {
          className: "flex items-center gap-1",
          children: [/*#__PURE__*/_jsx("span", {
            className: "w-2 h-2 rounded-full inline-block bg-amber-400"
          }), "Outbound trips"]
        }), /*#__PURE__*/_jsxs("span", {
          className: "flex items-center gap-1",
          children: [/*#__PURE__*/_jsx("span", {
            className: "w-2 h-2 rounded-full inline-block bg-teal-400"
          }), "Inbound trips"]
        })]
      })]
    }), /*#__PURE__*/_jsxs("p", {
      className: "text-[11px] text-slate-600 leading-relaxed px-1",
      children: ["Methodology: trips are deduplicated from raw device pings (multiple pings from the same visit collapse into one trip), and same-polygon self-references are excluded. A minimum time-separation threshold filters out sightings too close to the origin visit to represent a genuinely distinct destination. See", " ", /*#__PURE__*/_jsx("code", {
        className: "text-amber-400",
        children: "analyze_destinations.py"
      }), " for exact thresholds used."]
    })]
  });
}
function RoadmapPanel({
  type
}) {
  const content = type === "leakage" ? {
    title: "Extending Leakage Coverage",
    desc: "The map above IS the leakage analysis, live with your 10 small-airport extracts. It gets more complete as the remaining large airports (AUS, DFW, IAH, HOU, SAT) are processed — counties currently shown as one airport's uncontested territory may turn out to be contested once a nearby large airport's data is in.",
    needs: ["Process the large-airport batch (manifest_large.json) through aggregate.py the same way the small batch was", "Re-upload the resulting data/summary.json — no code or dashboard changes needed, the map above already loops over however many airports are present", "Optionally: a distance-to-nearest-airport lookup per county, to distinguish “contested because genuinely equidistant” from “contested because of a real preference/leakage pattern”"],
    math: "Per-county share = that airport's devices from the county ÷ total devices from the county across every tracked airport this quarter. ≥25% for the runner-up = contested."
  } : {
    title: "Top Destination Airports by Origin Airport",
    desc: "Show where travelers actually fly to — not just where they live.",
    needs: ["Device trajectory linkage: the same hashed device seen at an origin polygon and later at a destination-airport polygon within a plausible travel window", "Polygons drawn at each candidate destination airport (or a vendor-provided “polygon A → polygon B” linkage feed)", "A window rule (e.g. departure polygon ping → arrival polygon ping within 0–24 hrs) to avoid false links from unrelated trips"],
    math: "None of the home-location extracts (this one included) contain destination pings — this is the next data request to make of your mobility vendor."
  };
  return /*#__PURE__*/_jsxs("div", {
    className: "bg-slate-900/60 border border-slate-800 rounded-lg p-6 max-w-2xl",
    children: [/*#__PURE__*/_jsx("h3", {
      className: "text-base font-semibold text-slate-100 mb-2",
      children: content.title
    }), /*#__PURE__*/_jsx("p", {
      className: "text-sm text-slate-400 mb-4",
      children: content.desc
    }), /*#__PURE__*/_jsx("div", {
      className: "text-xs uppercase tracking-wider text-slate-500 mb-2",
      children: "Data needed to build this tab"
    }), /*#__PURE__*/_jsx("ul", {
      className: "space-y-2 mb-4",
      children: content.needs.map((n, i) => /*#__PURE__*/_jsxs("li", {
        className: "flex gap-2 text-sm text-slate-300",
        children: [/*#__PURE__*/_jsx("span", {
          className: "text-amber-400 mt-0.5",
          children: "□"
        }), /*#__PURE__*/_jsx("span", {
          children: n
        })]
      }, i))
    }), /*#__PURE__*/_jsx("div", {
      className: "text-xs text-slate-500 bg-slate-800/50 border border-slate-700 rounded-md p-3",
      children: content.math
    })]
  });
}
