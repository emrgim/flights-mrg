#!/usr/bin/env node
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const outDir = join(root, "public/flight-tracker/EK/030");
const out = join(outDir, "status.json");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";

async function fetchText(url, opts = {}) {
  const res = await fetch(url, {
    headers: {
      "user-agent": UA,
      accept: opts.accept || "text/html,application/json",
      ...(opts.headers || {}),
    },
    signal: AbortSignal.timeout(opts.timeout || 25000),
  });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.text();
}

async function fetchJson(url, opts = {}) {
  const text = await fetchText(url, {
    ...opts,
    accept: "application/json,text/plain,*/*",
  });
  return JSON.parse(text);
}

function parseNextData(html) {
  const m = html.match(/__NEXT_DATA__\s*=\s*(\{[\s\S]*?\});?\s*(?:__NEXT_LOADED_PAGES__|<)/);
  if (!m) throw new Error("No __NEXT_DATA__");
  return JSON.parse(m[1]);
}

function fmtDateLabel(isoLocal) {
  if (!isoLocal) return null;
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const m = isoLocal.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return `${m[3]}-${months[Number(m[2]) - 1]}-${m[1]}`;
}

function todayYmdInTz(tz) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date()); // YYYY-MM-DD
}

function utcYmdFromUnix(ts) {
  if (!ts) return null;
  return new Date(Number(ts) * 1000).toISOString().slice(0, 10);
}

function londonYmdFromUnix(ts) {
  if (!ts) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Number(ts) * 1000));
}

function normalizeReg(reg) {
  if (!reg) return null;
  const m = String(reg).toUpperCase().replace(/\s+/g, "").match(/A6-[A-Z0-9]{3}/);
  return m ? m[0] : null;
}

function normalizeHex(hex) {
  if (!hex) return null;
  const h = String(hex).toLowerCase().replace(/^0x/, "").replace(/[^0-9a-f]/g, "");
  return h.length >= 6 ? h.slice(-6) : null;
}

/** Resolve today's EK030 registration from Flightradar24 (API + HTML fallbacks). */
async function resolveRegistration(flightDateYmd) {
  const target = flightDateYmd || todayYmdInTz("Europe/London");
  let registration = null;
  let icao24 = null;
  let source = null;

  // 1) FR24 public flight list API
  try {
    const url =
      "https://api.flightradar24.com/common/v1/flight/list.json?query=ek30&fetchBy=flight&page=1&limit=100";
    const data = await fetchJson(url);
    const rows = data?.result?.response?.data || [];
    for (const f of rows) {
      const dep = f?.time?.scheduled?.departure;
      const day = londonYmdFromUnix(dep) || utcYmdFromUnix(dep);
      if (day !== target) continue;
      const reg = normalizeReg(f?.aircraft?.registration);
      if (reg) {
        registration = reg;
        icao24 = normalizeHex(f?.aircraft?.hex) || icao24;
        source = "flightradar24-api";
        break;
      }
    }
    // nearest upcoming with a reg if exact day missing
    if (!registration) {
      const withReg = rows
        .map((f) => ({
          f,
          dep: f?.time?.scheduled?.departure,
          reg: normalizeReg(f?.aircraft?.registration),
          hex: normalizeHex(f?.aircraft?.hex),
        }))
        .filter((x) => x.reg && x.dep)
        .sort((a, b) => a.dep - b.dep);
      const now = Math.floor(Date.now() / 1000);
      const upcoming = withReg.find((x) => x.dep >= now - 6 * 3600) || withReg[withReg.length - 1];
      if (upcoming) {
        registration = upcoming.reg;
        icao24 = upcoming.hex || icao24;
        source = "flightradar24-api-nearest";
      }
    }
  } catch (e) {
    console.warn("FR24 API registration lookup failed:", e.message || e);
  }

  // 2) FR24 HTML scrape: data/flights/ek30 — A6-XXX on today's date row
  if (!registration) {
    try {
      const html = await fetchText("https://www.flightradar24.com/data/flights/ek30");
      const rows = [];
      for (const tr of html.match(/<tr[\s\S]*?<\/tr>/g) || []) {
        const regs = tr.match(/A6-[A-Z0-9]{3}/g) || [];
        const stamps = [...tr.matchAll(/data-timestamp="(\d+)"/g)].map((m) => Number(m[1]));
        if (!regs.length || !stamps.length) continue;
        const ts = stamps[0];
        const day = londonYmdFromUnix(ts);
        rows.push({ reg: normalizeReg(regs[0]), ts, day });
      }
      const hit = rows.find((r) => r.day === target && r.reg);
      if (hit) {
        registration = hit.reg;
        source = "flightradar24-html";
      } else if (rows.length) {
        // first future/today-ish row
        const now = Math.floor(Date.now() / 1000);
        const upcoming = rows.find((r) => r.ts >= now - 6 * 3600) || rows[0];
        if (upcoming?.reg) {
          registration = upcoming.reg;
          source = "flightradar24-html-nearest";
        }
      }
    } catch (e) {
      console.warn("FR24 HTML registration scrape failed:", e.message || e);
    }
  }

  return { registration, icao24, source, targetDate: target };
}

async function resolveIcao24(registration, knownHex) {
  let hex = normalizeHex(knownHex);
  if (hex) return { icao24: hex, source: "flightradar24" };

  if (!registration) return { icao24: null, source: null };

  // api.adsbdb.com
  try {
    const data = await fetchJson(`https://api.adsbdb.com/v0/aircraft/${encodeURIComponent(registration)}`);
    hex = normalizeHex(data?.response?.aircraft?.mode_s);
    if (hex) return { icao24: hex, source: "adsbdb" };
  } catch (e) {
    console.warn("adsbdb hex lookup failed:", e.message || e);
  }

  // hexdb.io
  try {
    const text = (await fetchText(`https://hexdb.io/reg-hex?reg=${encodeURIComponent(registration)}`)).trim();
    hex = normalizeHex(text);
    if (hex) return { icao24: hex, source: "hexdb" };
  } catch (e) {
    console.warn("hexdb lookup failed:", e.message || e);
  }

  return { icao24: null, source: null };
}

function pickAcFromAdsbResponse(data, registration, icao24) {
  const list = data?.ac || data?.aircraft || (Array.isArray(data) ? data : []);
  if (!Array.isArray(list) || !list.length) return null;
  const regU = (registration || "").toUpperCase();
  const hexL = (icao24 || "").toLowerCase();
  let ac =
    list.find((a) => normalizeReg(a.r || a.reg || a.registration) === regU) ||
    list.find((a) => normalizeHex(a.hex || a.icao24) === hexL) ||
    list[0];
  if (!ac) return null;
  const lat = Number(ac.lat ?? ac.latitude);
  const lon = Number(ac.lon ?? ac.longitude ?? ac.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const altRaw = ac.alt_baro ?? ac.alt_geom ?? ac.altitude ?? ac.baro_altitude;
  const onGround =
    ac.alt_baro === "ground" ||
    ac.ground === true ||
    ac.on_ground === true ||
    (typeof altRaw === "number" && altRaw <= 0);
  let altitude = null;
  if (typeof altRaw === "number" && Number.isFinite(altRaw)) altitude = altRaw;
  else if (typeof altRaw === "string" && altRaw !== "ground" && Number.isFinite(Number(altRaw))) {
    altitude = Number(altRaw);
  }
  const heading = Number(ac.track ?? ac.true_heading ?? ac.mag_heading ?? ac.heading);
  const speed = Number(ac.gs ?? ac.ground_speed ?? ac.speed);
  const seenSec = Number(ac.seen_pos ?? ac.seen ?? 0);
  const seenAt = new Date(Date.now() - (Number.isFinite(seenSec) ? seenSec * 1000 : 0)).toISOString();
  return {
    lat,
    lon,
    altitude: onGround ? 0 : altitude,
    heading: Number.isFinite(heading) ? heading : null,
    speed: Number.isFinite(speed) ? speed : null,
    seenAt,
    onGround: Boolean(onGround),
  };
}

async function resolvePosition(registration, icao24) {
  const attempts = [];
  if (registration) {
    attempts.push({
      name: "adsb.lol-reg",
      url: `https://api.adsb.lol/v2/reg/${encodeURIComponent(registration)}`,
    });
  }
  if (icao24) {
    attempts.push({
      name: "adsb.lol-hex",
      url: `https://api.adsb.lol/v2/hex/${encodeURIComponent(icao24)}`,
    });
  }
  if (registration) {
    attempts.push({
      name: "airplanes.live-reg",
      url: `https://api.airplanes.live/v2/reg/${encodeURIComponent(registration)}`,
    });
  }
  if (icao24) {
    attempts.push({
      name: "airplanes.live-hex",
      url: `https://api.airplanes.live/v2/hex/${encodeURIComponent(icao24)}`,
    });
  }

  for (const a of attempts) {
    try {
      const data = await fetchJson(a.url, { timeout: 15000 });
      const pos = pickAcFromAdsbResponse(data, registration, icao24);
      if (pos) return { ...pos, source: a.name };
    } catch (e) {
      console.warn(`${a.name} failed:`, e.message || e);
    }
  }

  // OpenSky by icao24
  if (icao24) {
    try {
      const data = await fetchJson(
        `https://opensky-network.org/api/states/all?icao24=${encodeURIComponent(icao24.toLowerCase())}`,
        { timeout: 20000 }
      );
      const st = (data?.states || [])[0];
      if (st) {
        // [icao24, callsign, origin_country, time_position, last_contact, lon, lat, baro_altitude, on_ground, velocity, true_track, ...]
        const lon = Number(st[5]);
        const lat = Number(st[6]);
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          return {
            lat,
            lon,
            altitude: st[7] != null ? Math.round(Number(st[7]) / 0.3048) : null, // m → ft
            heading: st[10] != null ? Number(st[10]) : null,
            speed: st[9] != null ? Number(st[9]) * 1.94384 : null, // m/s → kt
            seenAt: new Date((st[3] || st[4] || Date.now() / 1000) * 1000).toISOString(),
            onGround: Boolean(st[8]),
            source: "opensky",
          };
        }
      }
    } catch (e) {
      console.warn("opensky failed:", e.message || e);
    }
  }

  return null;
}

async function enrichAircraft(baseAircraft, flightDateYmd) {
  const aircraft = {
    code: baseAircraft?.code || null,
    description: baseAircraft?.description || null,
    duration: baseAircraft?.duration || null,
    registration: null,
    icao24: null,
    position: null,
  };

  try {
    const regInfo = await resolveRegistration(flightDateYmd);
    aircraft.registration = regInfo.registration;
    let hex = regInfo.icao24;

    const hexInfo = await resolveIcao24(aircraft.registration, hex);
    aircraft.icao24 = hexInfo.icao24;

    if (aircraft.registration || aircraft.icao24) {
      const pos = await resolvePosition(aircraft.registration, aircraft.icao24);
      aircraft.position = pos;
    }

    if (regInfo.source) {
      console.log(
        "aircraft",
        aircraft.registration,
        aircraft.icao24,
        "via",
        regInfo.source,
        hexInfo.source || "-",
        posLabel(aircraft.position)
      );
    }
  } catch (e) {
    console.warn("aircraft enrichment failed (continuing):", e.message || e);
  }

  return aircraft;
}

function posLabel(pos) {
  if (!pos) return "no-position";
  return `${pos.lat.toFixed(3)},${pos.lon.toFixed(3)} @${pos.source}`;
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const news = [];
  const sources = [];
  let caution = null;

  const html = await fetchText("https://www.flightstats.com/v2/flight-tracker/EK/030");
  sources.push({ name: "FlightStats", url: "https://www.flightstats.com/v2/flight-tracker/EK/030" });
  const next = parseNextData(html);
  const flight = next?.props?.initialState?.flightTracker?.flight;
  if (!flight) throw new Error("No flight object in FlightStats payload");

  const dep = flight.departureAirport || {};
  const arr = flight.arrivalAirport || {};
  const st = flight.status || {};
  const note = flight.flightNote || {};
  const otherDays = next?.props?.initialState?.flightTracker?.otherDays || [];

  try {
    const h = await fetchText("https://www.heathrow.com/departures/terminal-3/flight-details/EK030");
    sources.push({ name: "Heathrow", url: "https://www.heathrow.com/departures/terminal-3/flight-details/EK030" });
    if (/NATS|knock-on disruption|technical issue/i.test(h)) {
      caution =
        "Heathrow recovering from NATS ATC issue; knock-on disruption possible. Confirm with Emirates before going to the airport.";
      news.push({
        title: "NATS air traffic control technical issue — Heathrow",
        url: "https://www.heathrow.com/departures/terminal-3/flight-details/EK030",
        source: "Heathrow Airport",
        airport: "LHR",
        summary:
          "Operations recovering; some knock-on disruption expected as airlines reposition aircraft and crew.",
      });
    }
  } catch {}

  try {
    const nUrl =
      "https://www.thenationalnews.com/travel/2026/09/09/dubai-abu-dhabi-flight-delays-cancellations/";
    const n = await fetchText(nUrl);
    sources.push({ name: "The National", url: nUrl });
    if (/EK030/i.test(n)) {
      news.push({
        title: "Dubai/Abu Dhabi delays after Heathrow outage",
        url: nUrl,
        source: "The National",
        airport: "LHR",
        summary: "EK030 from Heathrow listed among Emirates services running behind schedule.",
      });
      caution =
        (caution ? caution + " " : "") +
        "Press lists EK030 among delayed services — treat on-time cautiously.";
    }
  } catch {}

  const flightDate = (dep.date || "").slice(0, 10) || todayYmdInTz("Europe/London");
  const baseAc = {
    code: flight.additionalFlightInfo?.equipment?.iata || null,
    description: flight.additionalFlightInfo?.equipment?.name || null,
    duration: flight.additionalFlightInfo?.flightDuration || null,
  };
  const aircraft = await enrichAircraft(baseAc, flightDate);

  sources.push({ name: "Flightradar24", url: "https://www.flightradar24.com/data/flights/ek30" });
  if (aircraft.position?.source?.includes("adsb.lol")) {
    sources.push({ name: "adsb.lol", url: "https://api.adsb.lol/" });
  } else if (aircraft.position?.source?.includes("airplanes.live")) {
    sources.push({ name: "airplanes.live", url: "https://api.airplanes.live/" });
  } else if (aircraft.position?.source === "opensky") {
    sources.push({ name: "OpenSky", url: "https://opensky-network.org/" });
  }

  const trackingAvailable = Boolean(flight.isTracking) || Boolean(aircraft.position);
  let trackingMessage =
    note.message ||
    (flight.isTracking
      ? "Live tracking active"
      : "Positional tracking not available yet. Tracking will begin after departure.");
  if (aircraft.position && !flight.isTracking) {
    trackingMessage = aircraft.registration
      ? `Live ADS-B on hull ${aircraft.registration} (airframe position; may not yet be operating EK030).`
      : "Live ADS-B position available for assigned airframe.";
  } else if (aircraft.registration && !aircraft.position) {
    trackingMessage = `Assigned hull ${aircraft.registration} — waiting for ADS-B / aircraft not yet transmitting.`;
  }

  const payload = {
    airlineCode: flight.ticketHeader?.carrier?.fs || "EK",
    flightNumber: String(flight.ticketHeader?.flightNumber || "30").padStart(3, "0"),
    airlineName: flight.ticketHeader?.carrier?.name || "Emirates",
    flightId: flight.flightId,
    status: note.canceled ? "Cancelled" : st.status || "Status unavailable",
    statusDetail: st.statusDescription || st.delayStatus?.wording || "",
    statusCode: st.statusCode || null,
    date: flightDate,
    departure: {
      city: dep.city || "London",
      region: [dep.state, dep.country].filter(Boolean).join(", "),
      airportName: dep.name || "London Heathrow Airport",
      airport: dep.fs || "LHR",
      dateLabel: fmtDateLabel(dep.date) || "09-Sep-2026",
      scheduled: dep.times?.scheduled?.time24 || null,
      estimated: dep.times?.estimatedActual?.time24 || null,
      actual: dep.times?.estimatedActual?.title === "Actual" ? dep.times?.estimatedActual?.time24 : null,
      timezoneLabel: dep.times?.scheduled?.timezone || "BST",
      timezone: dep.timeZoneRegionName || "Europe/London",
      terminal: dep.terminal || null,
      gate: dep.gate || null,
    },
    arrival: {
      city: arr.city || "Dubai",
      region: [arr.state, arr.country].filter(Boolean).join(", ") || arr.country || "AE",
      airportName: arr.name || "Dubai International Airport",
      airport: arr.fs || "DXB",
      dateLabel: fmtDateLabel(arr.date) || null,
      scheduled: arr.times?.scheduled?.time24 || null,
      estimated: arr.times?.estimatedActual?.time24 || null,
      actual: arr.times?.estimatedActual?.title === "Actual" ? arr.times?.estimatedActual?.time24 : null,
      timezoneLabel: arr.times?.scheduled?.timezone || "+04",
      timezone: arr.timeZoneRegionName || "Asia/Dubai",
      terminal: arr.terminal || null,
      gate: arr.gate || null,
    },
    tracking: {
      available: trackingAvailable,
      message: trackingMessage,
    },
    codeshares: (flight.codeshares || []).map((c) => ({
      airline: c.name,
      flight: `${c.fs} ${c.flightNumber}`,
    })),
    aircraft,
    otherDays: otherDays.map((d) => ({
      label: d.date1,
      day: d.day,
      year: d.year,
      flights: (d.flights || []).map((f) => ({
        dep: f.departureTime24,
        depTz: f.departureTimezone,
        arr: f.arrivalTime24,
        arrTz: f.arrivalTimezone,
        from: f.departureAirport?.fs,
        to: f.arrivalAirport?.fs,
        url: f.url ? `https://www.flightstats.com/v2${f.url}` : null,
      })),
    })),
    caution,
    news,
    updatedAt: new Date().toISOString(),
    sources,
  };

  await writeFile(out, JSON.stringify(payload, null, 2));
  await mkdir(join(root, "public/ek030"), { recursive: true });
  await writeFile(join(root, "public/ek030/status.json"), JSON.stringify(payload, null, 2));
  // Optional slim position feed for map clients
  const positionPayload = {
    registration: aircraft.registration,
    icao24: aircraft.icao24,
    position: aircraft.position,
    updatedAt: payload.updatedAt,
  };
  await writeFile(join(outDir, "position.json"), JSON.stringify(positionPayload, null, 2));

  console.log(
    "OK",
    payload.status,
    payload.statusDetail,
    payload.departure.scheduled,
    "→",
    payload.arrival.scheduled,
    "|",
    aircraft.registration || "no-reg",
    aircraft.icao24 || "no-hex",
    aircraft.position ? "pos" : "no-pos"
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
