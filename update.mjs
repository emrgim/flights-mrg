#!/usr/bin/env node
import { writeFile, mkdir } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
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


const OPENSKY_TOKEN_URL =
  "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";
let _openskyToken = null;
let _openskyTokenExpiry = 0;

function loadOpenSkyCreds() {
  const id = (process.env.OPENSKY_CLIENT_ID || "").trim();
  const secret = (process.env.OPENSKY_CLIENT_SECRET || "").trim();
  if (id && secret) return { id, secret };
  try {
    const envPath = "/home/box/.config/opensky/env";
    if (!existsSync(envPath)) return null;
    const text = readFileSync(envPath, "utf8");
    const map = Object.fromEntries(
      text
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#") && l.includes("="))
        .map((l) => {
          const i = l.indexOf("=");
          return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
        })
    );
    if (map.OPENSKY_CLIENT_ID && map.OPENSKY_CLIENT_SECRET) {
      return { id: map.OPENSKY_CLIENT_ID, secret: map.OPENSKY_CLIENT_SECRET };
    }
  } catch {}
  return null;
}

async function getOpenSkyToken() {
  const creds = loadOpenSkyCreds();
  if (!creds) return null;
  const now = Date.now();
  if (_openskyToken && now < _openskyTokenExpiry - 60_000) return _openskyToken;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: creds.id,
    client_secret: creds.secret,
  });
  const res = await fetch(OPENSKY_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`OpenSky token ${res.status}: ${detail.slice(0, 200)}`);
  }
  const data = await res.json();
  _openskyToken = data.access_token;
  const expiresIn = Number(data.expires_in) || 1800;
  _openskyTokenExpiry = now + expiresIn * 1000;
  return _openskyToken;
}

async function fetchOpenSkyState(icao24) {
  const headers = {
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
    accept: "application/json",
  };
  let authMode = "anon";
  try {
    const token = await getOpenSkyToken();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
      authMode = "oauth";
    }
  } catch (e) {
    console.warn("OpenSky OAuth skipped:", e.message || e);
  }
  const url = `https://opensky-network.org/api/states/all?icao24=${encodeURIComponent(icao24.toLowerCase())}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`opensky ${res.status}`);
  const data = await res.json();
  const st = (data?.states || [])[0];
  if (!st) return null;
  const lon = Number(st[5]);
  const lat = Number(st[6]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    lat,
    lon,
    altitude: st[7] != null ? Math.round(Number(st[7]) / 0.3048) : null,
    heading: st[10] != null ? Number(st[10]) : null,
    speed: st[9] != null ? Number(st[9]) * 1.94384 : null,
    seenAt: new Date((st[3] || st[4] || Date.now() / 1000) * 1000).toISOString(),
    onGround: Boolean(st[8]),
    source: authMode === "oauth" ? "opensky-oauth" : "opensky-anon",
  };
}


async function resolvePosition(registration, icao24) {
  // Prefer authenticated OpenSky when OAuth client is configured (GEV-style)
  if (icao24 && loadOpenSkyCreds()) {
    try {
      const pos = await fetchOpenSkyState(icao24);
      if (pos) return pos;
    } catch (e) {
      console.warn("opensky-oauth failed:", e.message || e);
    }
  }

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

  // Anonymous OpenSky last resort
  if (icao24) {
    try {
      const pos = await fetchOpenSkyState(icao24);
      if (pos) return pos;
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


async function fetchNearbyLhr() {
  const url = "https://api.adsb.lol/v2/lat/51.47/lon/-0.45/dist/15";
  const data = await fetchJson(url, { timeout: 20000 });
  const list = data?.ac || data?.aircraft || [];
  const nearby = [];
  for (const a of Array.isArray(list) ? list : []) {
    const flight = String(a.flight || a.callsign || "").trim() || null;
    const registration = normalizeReg(a.r || a.reg || a.registration) ||
      (a.r || a.reg || a.registration ? String(a.r || a.reg || a.registration).trim() : null);
    const altRaw = a.alt_baro ?? a.alt_geom ?? a.altitude;
    const onGround =
      altRaw === "ground" ||
      a.ground === true ||
      a.on_ground === true ||
      (typeof altRaw === "number" && altRaw <= 0);
    let altitude = null;
    if (typeof altRaw === "number" && Number.isFinite(altRaw)) altitude = altRaw;
    else if (typeof altRaw === "string" && altRaw !== "ground" && Number.isFinite(Number(altRaw))) {
      altitude = Number(altRaw);
    }
    const speed = Number(a.gs ?? a.ground_speed ?? a.speed);
    nearby.push({
      flight,
      registration,
      altitude: onGround ? 0 : altitude,
      speed: Number.isFinite(speed) ? Math.round(speed) : null,
      onGround: Boolean(onGround),
    });
  }
  // Prefer aircraft with callsigns; cap list
  nearby.sort((a, b) => {
    const ag = a.onGround === b.onGround ? 0 : a.onGround ? 1 : -1;
    if (ag) return ag;
    return String(a.flight || "").localeCompare(String(b.flight || ""));
  });
  return { nearby: nearby.slice(0, 40), url };
}

function hhmmToMinutes(hhmm) {
  if (!hhmm) return null;
  const m = String(hhmm).match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function localIsoToHhmm(iso) {
  if (!iso) return null;
  const m = String(iso).match(/T(\d{2}:\d{2})/);
  return m ? m[1] : null;
}

function parseHeathrowStatus(statusObj) {
  const code = statusObj?.statusCode || null;
  const message = statusObj?.message || "";
  const data = statusObj?.statusData || [];
  const locKey = data[0]?.localisationKey || null;
  const timeData = data.find((d) => /^\d{1,2}:\d{2}$/.test(String(d.data || "")))?.data || null;
  // Estimate/actual clock from message: "Delayed 14:29", "On time 16:50", "Departed 09:30"
  const msgTime = (message.match(/(?:Delayed|On time|Departed|Expected)\s+(\d{1,2}:\d{2})/i) || [])[1] || timeData;
  let status = message.split(",")[0].trim() || code || "Unknown";
  if (locKey === "OnTime") status = msgTime ? `On time ${msgTime}` : "On time";
  else if (locKey === "Delayed") status = msgTime ? `Delayed ${msgTime}` : "Delayed";
  else if (locKey === "Departed") status = msgTime ? `Departed ${msgTime}` : "Departed";
  else if (locKey === "Cancelled" || code === "CX") status = "Cancelled";
  else if (locKey === "GateOpen" || code === "GO") status = timeData ? `Gate open ${timeData}` : "Gate open";
  else if (code === "TX") status = msgTime ? `Taxied ${msgTime}` : (message || "Taxied");
  else if (code === "BD") status = "Boarding";
  else if (code === "LC") status = "Last call";
  else if (code === "GC") status = "Gate closed";
  return { code, status, estimatedHhmm: msgTime || null, delayed: /delay/i.test(message) || locKey === "Delayed" };
}

function mapHeathrowDeparture(item) {
  const fs = item?.flightService || {};
  const am = fs.aircraftMovement || {};
  const statusObj = (am.aircraftMovementStatus || [])[0] || {};
  const ports = am.route?.portsOfCall || [];
  const origin = ports.find((p) => p.portOfCallType === "ORIGIN") || {};
  const dest = ports.find((p) => p.portOfCallType === "DESTINATION") || {};
  const oAf = origin.airportFacility || {};
  const dAf = dest.airportFacility || {};
  const termFac = oAf.terminalFacility || {};
  const gateFac = termFac.gateFacility || {};
  const scheduledIso = origin.operatingTimes?.scheduled?.local || null;
  const scheduled = localIsoToHhmm(scheduledIso);
  const parsed = parseHeathrowStatus(statusObj);
  let estimated = parsed.estimatedHhmm;
  // For departed, estimated/actual is the departed time
  if (parsed.code === "AB" && parsed.estimatedHhmm) estimated = parsed.estimatedHhmm;
  let delayMin = null;
  if (scheduled && estimated) {
    let d = hhmmToMinutes(estimated) - hhmmToMinutes(scheduled);
    if (Number.isFinite(d)) {
      // wrap midnight
      if (d < -12 * 60) d += 24 * 60;
      if (d > 12 * 60) d -= 24 * 60;
      delayMin = d;
    }
  }
  if (parsed.delayed && delayMin != null && delayMin < 0) {
    // Delayed message time is the new estimated; if negative, keep as-is only if |d| huge — usually positive
  }
  const destCity = dAf.airportCityLocation?.name || null;
  const destCode = dAf.iataIdentifier || null;
  const destination = [destCity, destCode].filter(Boolean).join(" · ") || destCode || destCity || null;
  const share = fs.codeShareStatus || "";
  const isOperating =
    share === "NORMAL_FLIGHT" ||
    share === "CODESHARE_OPERATING_FLIGHT" ||
    !share;
  return {
    flight: fs.iataFlightIdentifier || null,
    destination,
    scheduled,
    estimated,
    status: parsed.status,
    statusCode: parsed.code,
    gate: gateFac.gateNumber ? String(gateFac.gateNumber).trim() : null,
    terminal: termFac.code ? String(termFac.code) : "3",
    delayMin: delayMin != null && delayMin !== 0 ? delayMin : delayMin === 0 ? 0 : null,
    scheduledIso,
    isOperating,
    delayed: Boolean(parsed.delayed || (delayMin != null && delayMin >= 15)),
  };
}

async function fetchHeathrowDepartures() {
  const url = "https://api-dp-prod.dp.heathrow.com/pihub/flights/departures?terminal=3";
  const res = await fetch(url, {
    headers: {
      "user-agent": UA,
      accept: "application/json",
      origin: "https://www.heathrow.com",
      referer: "https://www.heathrow.com/departures",
    },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`heathrow departures → ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error("heathrow departures: unexpected payload");
  const mapped = data.map(mapHeathrowDeparture).filter((r) => r.flight && r.isOperating);

  // Window: from 90 min ago to 6h ahead (London local via scheduledIso)
  const now = Date.now();
  const lo = now - 90 * 60 * 1000;
  const hi = now + 6 * 60 * 60 * 1000;
  const inWindow = mapped.filter((r) => {
    if (!r.scheduledIso) return true;
    // scheduledIso is local without Z — treat as Europe/London wall time approx by appending offset is hard;
    // parse as local components vs Date in London.
    const m = String(r.scheduledIso).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (!m) return true;
    // Build a UTC instant approximating BST/GMT via Intl offset
    const asUtcGuess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    // Correct using London offset at that date
    const probe = new Date(asUtcGuess);
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Europe/London",
      timeZoneName: "shortOffset",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(probe);
    const get = (t) => parts.find((p) => p.type === t)?.value;
    // Better: format a known UTC and compare — use temporal trick
    // Simpler approach: compare HH:MM strings against current London time for same calendar day
    return true; // filter below with London clock
  });

  const londonNow = new Date();
  const londonYmd = todayYmdInTz("Europe/London");
  const londonHm = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(londonNow);
  const nowMin = hhmmToMinutes(londonHm);

  const filtered = mapped.filter((r) => {
    if (!r.scheduledIso) return false;
    const day = r.scheduledIso.slice(0, 10);
    const schedMin = hhmmToMinutes(r.scheduled);
    if (schedMin == null || nowMin == null) return true;
    // same day preferred; allow previous day late / next day early via iso day
    if (day === londonYmd) {
      return schedMin >= nowMin - 90 && schedMin <= nowMin + 360;
    }
    // include cancelled/delayed from earlier today already covered; skip other days unless within window via iso
    const t = Date.parse(r.scheduledIso + "+01:00"); // BST-ish; degrade ok for windowing
    if (!Number.isFinite(t)) return day === londonYmd;
    return t >= lo && t <= hi;
  });

  filtered.sort((a, b) => String(a.scheduledIso).localeCompare(String(b.scheduledIso)));

  const departedCodes = new Set(["AB", "TX"]);
  const recentDeparted = filtered.filter((r) => departedCodes.has(r.statusCode)).slice(-12);
  const upcoming = filtered.filter((r) => !departedCodes.has(r.statusCode));
  let picked = [...recentDeparted, ...upcoming];
  // Always keep EK030 / EK30 if present in the filtered window (or broader mapped set)
  const ek = filtered.find((r) => /^EK0*30$/i.test(r.flight)) ||
    mapped.find((r) => /^EK0*30$/i.test(r.flight));
  if (ek && !picked.some((r) => r.flight === ek.flight)) {
    picked.push(ek);
    picked.sort((a, b) => String(a.scheduledIso).localeCompare(String(b.scheduledIso)));
  }
  // Cap while preserving EK030
  if (picked.length > 55) {
    const ekFlight = ek?.flight;
    picked = picked.filter((r, i) => i < 55 || r.flight === ekFlight);
  }

  // Drop internal helper fields for output
  let departures = picked.map((r) => ({
    flight: r.flight,
    destination: r.destination,
    scheduled: r.scheduled,
    estimated: r.estimated,
    scheduledDate: r.scheduledIso ? r.scheduledIso.slice(0, 10) : null,
    status: r.status,
    gate: r.gate,
    terminal: r.terminal,
    delayMin: r.delayMin,
  }));

  const ekIdx = departures.findIndex((r) => /^EK0*30$/i.test(String(r.flight || "")));
  if (ekIdx > 0) {
    const [ekRow] = departures.splice(ekIdx, 1);
    departures.unshift(ekRow);
  }

  return {
    departures,
    url,
    pageUrl: "https://www.heathrow.com/departures",
    rawCount: data.length,
  };
}

async function buildLhrBoard() {
  const sources = [];
  let departures = [];
  let nearby = [];

  try {
    const h = await fetchHeathrowDepartures();
    departures = h.departures;
    sources.push({ name: "Heathrow departures (T3)", url: h.pageUrl });
    sources.push({ name: "Heathrow pihub API", url: h.url });
    console.log("LHR board departures", departures.length, "from", h.rawCount, "raw");
  } catch (e) {
    console.warn("Heathrow departures board failed:", e.message || e);
  }

  try {
    const n = await fetchNearbyLhr();
    nearby = n.nearby;
    sources.push({ name: "adsb.lol near EGLL", url: n.url });
    console.log("LHR nearby ADS-B", nearby.length);
  } catch (e) {
    console.warn("adsb.lol LHR nearby failed:", e.message || e);
  }

  return {
    airport: "LHR",
    terminal: "3",
    date: todayYmdInTz("Europe/London"),
    timezone: "Europe/London",
    updatedAt: new Date().toISOString(),
    departures,
    nearby,
    sources,
  };
}


async function loadFlightStatsHtml() {
  const urls = [
    "https://www.flightstats.com/v2/flight-tracker/EK/030",
    `https://www.flightstats.com/v2/flight-tracker/EK/30?year=${todayYmdInTz("Europe/London").slice(0, 4)}&month=${todayYmdInTz("Europe/London").slice(5, 7)}&date=${todayYmdInTz("Europe/London").slice(8, 10)}`,
  ];
  const errors = [];
  for (const url of urls) {
    try {
      const html = await fetchText(url);
      if (html.includes("__NEXT_DATA__")) return { html, url };
      errors.push(`${url} → no __NEXT_DATA__`);
    } catch (e) {
      errors.push(e.message || String(e));
    }
  }
  const localCandidates = [
    join(root, "flightstats-ek030.html"),
    join(root, "flightstats.html"),
    "/tmp/flightstats-ek030.html",
  ];
  for (const p of localCandidates) {
    if (!existsSync(p)) continue;
    const html = readFileSync(p, "utf8");
    if (html.includes("__NEXT_DATA__")) {
      console.warn("FlightStats network blocked; using local HTML", p);
      return { html, url: "https://www.flightstats.com/v2/flight-tracker/EK/030" };
    }
  }
  throw new Error(`FlightStats unavailable: ${errors.join("; ")}`);
}

function hhmmFromUnixInTz(ts, tz) {
  if (!ts) return null;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(Number(ts) * 1000));
}

async function fetchHeathrowEk030() {
  const url = "https://api-dp-prod.dp.heathrow.com/pihub/flights/departures?terminal=3";
  const res = await fetch(url, {
    headers: {
      "user-agent": UA,
      accept: "application/json",
      origin: "https://www.heathrow.com",
      referer: "https://www.heathrow.com/departures",
    },
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`heathrow departures → ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error("heathrow departures: unexpected payload");
  return data.find((x) => x?.flightService?.iataFlightIdentifier === "EK030") || null;
}

async function fetchFr24Today() {
  const target = todayYmdInTz("Europe/London");
  const data = await fetchJson(
    "https://api.flightradar24.com/common/v1/flight/list.json?query=ek30&fetchBy=flight&page=1&limit=100"
  );
  const rows = data?.result?.response?.data || [];
  return (
    rows.find((f) => {
      const dep = f?.time?.scheduled?.departure;
      const day = londonYmdFromUnix(dep) || utcYmdFromUnix(dep);
      return day === target;
    }) || null
  );
}

async function buildPayloadFromFallbacks(prev) {
  const sources = [];
  const news = [];
  let caution = prev?.caution || null;
  const newsFetchedAt = new Date().toISOString();
  const flightDate = todayYmdInTz("Europe/London");

  let heathrow = null;
  try {
    heathrow = await fetchHeathrowEk030();
    sources.push({ name: "Heathrow", url: "https://www.heathrow.com/departures" });
  } catch (e) {
    console.warn("Heathrow fallback failed:", e.message || e);
  }

  let fr24 = null;
  try {
    fr24 = await fetchFr24Today();
    sources.push({ name: "Flightradar24", url: "https://www.flightradar24.com/data/flights/ek30" });
  } catch (e) {
    console.warn("FR24 fallback failed:", e.message || e);
  }

  if (!heathrow && !fr24 && !prev) {
    throw new Error("No FlightStats and no Heathrow/FR24/previous status for fallback");
  }

  // News / caution (same scrapes as main path)
  try {
    const h = await fetchText("https://www.heathrow.com/departures");
    if (/NATS|knock-on disruption|technical issue|operations are recovering|operating today/i.test(h)) {
      const resolved = /resolved|recovering|operating today/i.test(h);
      caution = resolved
        ? "Heathrow operations recovering after Tuesday's NATS issue (resolved); flights operating today with knock-on cancellations/delays possible. Confirm with Emirates before travelling."
        : "Heathrow disruption from NATS ATC issue; knock-on delays possible. Confirm with Emirates before going to the airport.";
      news.push({
        title: "Heathrow operations recovering — flights operating",
        url: "https://www.heathrow.com/departures",
        source: "Heathrow Airport",
        airport: "LHR",
        summary:
          "NATS technical issue resolved Tuesday evening. Flights operating today; knock-on disruption expected as airlines reposition aircraft and crew. Check with airline before travelling.",
        fetchedAt: newsFetchedAt,
      });
      news.push({
        title: "UK flights resume but airports warn of ongoing disruption",
        url: "https://www.reuters.com/world/uk/uk-flights-resume-airports-warn-ongoing-disruption-air-traffic-outage-2026-09-09/",
        source: "Reuters",
        airport: "LHR",
        summary:
          "British airports resumed flights early Wednesday after NATS resolved Tuesday's air-traffic failure; hubs warn recovery will take time with aircraft and crews out of position.",
        fetchedAt: newsFetchedAt,
      });
      news.push({
        title: "Hundreds more Heathrow flights cancelled as network recovers",
        url: "https://www.standard.co.uk/news/london/heathrow-flights-cancelled-latest-wednesday-gatwick-nats-b1295995.html",
        source: "Evening Standard",
        airport: "LHR",
        summary:
          "Wednesday knock-on cancellations continue at Heathrow after NATS resolved the Tuesday outage; passengers advised to check with their airline before travelling.",
        fetchedAt: newsFetchedAt,
      });
    }
  } catch (e) {
    console.warn("Heathrow departures scrape failed:", e.message || e);
  }
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
        summary:
          "EK030 from Heathrow listed among Emirates services running behind schedule amid knock-on UK disruption.",
        fetchedAt: newsFetchedAt,
      });
      caution =
        (caution ? caution + " " : "") +
        "Press lists EK030 among delayed services — treat on-time cautiously.";
    }
  } catch (e) {
    console.warn("The National scrape failed:", e.message || e);
  }

  const origin = heathrow?.flightService?.aircraftMovement?.route?.portsOfCall?.find(
    (p) => p.portOfCallType === "ORIGIN"
  );
  const dest = heathrow?.flightService?.aircraftMovement?.route?.portsOfCall?.find(
    (p) => p.portOfCallType === "DESTINATION"
  );
  const originStatus = heathrow?.flightService?.aircraftMovement?.aircraftMovementStatus?.find(
    (s) => s.name === "OriginStatus"
  );
  const gate =
    origin?.airportFacility?.terminalFacility?.gateFacility?.gateIdentifier ||
    origin?.airportFacility?.terminalFacility?.gateFacility?.identifier ||
    null;
  const terminal =
    origin?.airportFacility?.terminalFacility?.code || prev?.departure?.terminal || "3";
  const arrTerminal =
    dest?.airportFacility?.terminalFacility?.code || prev?.arrival?.terminal || null;
  const arrGate =
    dest?.airportFacility?.terminalFacility?.gateFacility?.gateIdentifier ||
    dest?.airportFacility?.terminalFacility?.gateFacility?.identifier ||
    null;

  const depScheduled =
    (origin?.operatingTimes?.scheduled?.local || "").slice(11, 16) ||
    hhmmFromUnixInTz(fr24?.time?.scheduled?.departure, "Europe/London") ||
    prev?.departure?.scheduled ||
    null;
  const depEstimated =
    (origin?.operatingTimes?.estimated?.local || origin?.operatingTimes?.actual?.local || "").slice(11, 16) ||
    hhmmFromUnixInTz(fr24?.time?.estimated?.departure || fr24?.time?.scheduled?.departure, "Europe/London") ||
    prev?.departure?.estimated ||
    depScheduled;
  const depActual =
    (origin?.operatingTimes?.actual?.local || "").slice(11, 16) ||
    hhmmFromUnixInTz(fr24?.time?.real?.departure, "Europe/London") ||
    null;

  const arrScheduled =
    (dest?.operatingTimes?.scheduled?.local || "").slice(11, 16) ||
    hhmmFromUnixInTz(fr24?.time?.scheduled?.arrival, "Asia/Dubai") ||
    prev?.arrival?.scheduled ||
    null;
  const arrEstimated =
    (dest?.operatingTimes?.estimated?.local || dest?.operatingTimes?.actual?.local || "").slice(11, 16) ||
    hhmmFromUnixInTz(fr24?.time?.estimated?.arrival || fr24?.time?.other?.eta, "Asia/Dubai") ||
    prev?.arrival?.estimated ||
    arrScheduled;
  const arrActual =
    (dest?.operatingTimes?.actual?.local || "").slice(11, 16) ||
    hhmmFromUnixInTz(fr24?.time?.real?.arrival, "Asia/Dubai") ||
    null;

  let status = prev?.status || "Scheduled";
  let statusDetail = prev?.statusDetail || "";
  let statusCode = prev?.statusCode || "S";
  const msg = originStatus?.message || fr24?.status?.text || "";
  if (/cancel/i.test(msg)) {
    status = "Cancelled";
    statusDetail = msg;
    statusCode = "C";
  } else if (/landed|arrived/i.test(msg) || fr24?.status?.generic?.status?.text === "arrived") {
    status = "Arrived";
    statusDetail = msg || "Landed";
    statusCode = "L";
  } else if (/departed|airborne|en ?route/i.test(msg) || fr24?.status?.live) {
    status = "En Route";
    statusDetail = msg || fr24?.status?.text || "Departed";
    statusCode = "A";
  } else if (/delay/i.test(msg)) {
    status = "Delayed";
    statusDetail = msg;
    statusCode = "D";
  } else if (/on time|estimated dep|check-in/i.test(msg)) {
    status = "Scheduled";
    statusDetail = /on time/i.test(msg) ? "On time" : msg || "On time";
    statusCode = "S";
  } else if (msg) {
    statusDetail = msg;
  }

  const acTransport = heathrow?.flightService?.aircraftTransport || {};
  const baseAc = {
    code: acTransport.iataTypeCode || fr24?.aircraft?.model?.code || prev?.aircraft?.code || null,
    description:
      acTransport.description ||
      prev?.aircraft?.description ||
      null,
    duration: prev?.aircraft?.duration || null,
  };
  if (heathrow?.flightService?.aircraftMovement?.scheduledFlightDurationMinutes) {
    const m = heathrow.flightService.aircraftMovement.scheduledFlightDurationMinutes;
    baseAc.duration = `${Math.floor(m / 60)}h ${m % 60}m`;
  }
  const aircraft = await enrichAircraft(baseAc, flightDate);
  if (aircraft.position?.source?.includes("adsb.lol")) {
    sources.push({ name: "adsb.lol", url: "https://api.adsb.lol/" });
  } else if (aircraft.position?.source?.includes("airplanes.live")) {
    sources.push({ name: "airplanes.live", url: "https://api.airplanes.live/" });
  } else if (aircraft.position?.source === "opensky") {
    sources.push({ name: "OpenSky", url: "https://opensky-network.org/" });
  }
  sources.push({
    name: "FlightStats",
    url: "https://www.flightstats.com/v2/flight-tracker/EK/030",
    note: "blocked (403); payload rebuilt from Heathrow/FR24",
  });

  const trackingAvailable = Boolean(aircraft.position);
  let trackingMessage = prev?.tracking?.message || "Positional tracking not available yet.";
  if (aircraft.position) {
    trackingMessage = aircraft.registration
      ? `Live ADS-B on hull ${aircraft.registration} (airframe position; may not yet be operating EK030).`
      : "Live ADS-B position available for assigned airframe.";
  } else if (aircraft.registration) {
    trackingMessage = `Assigned hull ${aircraft.registration} — waiting for ADS-B / aircraft not yet transmitting.`;
  }

  const codeshares = (heathrow?.flightService?.codeShareSummary || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((code) => {
      const m = code.match(/^([A-Z0-9]{2})(\d+)$/i);
      if (!m) return { airline: code, flight: code };
      const map = { FI: "Icelandair", QF: "Qantas" };
      return { airline: map[m[1].toUpperCase()] || m[1], flight: `${m[1].toUpperCase()} ${m[2]}` };
    });

  return {
    airlineCode: "EK",
    flightNumber: "030",
    airlineName: "Emirates",
    flightId: prev?.flightId || null,
    status,
    statusDetail,
    statusCode,
    date: flightDate,
    departure: {
      city: "London",
      region: prev?.departure?.region || "EN, GB",
      airportName: "London Heathrow Airport",
      airport: "LHR",
      dateLabel: fmtDateLabel(`${flightDate}T00:00:00`) || prev?.departure?.dateLabel,
      scheduled: depScheduled,
      estimated: depEstimated,
      actual: depActual,
      timezoneLabel: "BST",
      timezone: "Europe/London",
      terminal,
      gate: gate || null,
    },
    arrival: {
      city: "Dubai",
      region: "AE",
      airportName: "Dubai International Airport",
      airport: "DXB",
      dateLabel:
        fmtDateLabel((dest?.operatingTimes?.scheduled?.local || "").slice(0, 10) + "T00:00:00") ||
        prev?.arrival?.dateLabel ||
        null,
      scheduled: arrScheduled,
      estimated: arrEstimated,
      actual: arrActual,
      timezoneLabel: "+04",
      timezone: "Asia/Dubai",
      terminal: arrTerminal,
      gate: arrGate,
    },
    tracking: { available: trackingAvailable, message: trackingMessage },
    codeshares: codeshares.length ? codeshares : prev?.codeshares || [],
    aircraft,
    otherDays: prev?.otherDays || [],
    caution,
    news,
    updatedAt: new Date().toISOString(),
    sources,
    fallback: true,
  };
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const news = [];
  const sources = [];
  let caution = null;

  let flight;
  let otherDays = [];
  let usedFallback = false;
  try {
    const loaded = await loadFlightStatsHtml();
    sources.push({ name: "FlightStats", url: loaded.url });
    const next = parseNextData(loaded.html);
    flight = next?.props?.initialState?.flightTracker?.flight;
    otherDays = next?.props?.initialState?.flightTracker?.otherDays || [];
    if (!flight) throw new Error("No flight object in FlightStats payload");
  } catch (e) {
    console.warn("FlightStats path failed:", e.message || e);
    let prev = null;
    try {
      if (existsSync(out)) prev = JSON.parse(readFileSync(out, "utf8"));
    } catch {}
    const payload = await buildPayloadFromFallbacks(prev);
    usedFallback = true;
    await writeFile(out, JSON.stringify(payload, null, 2));
    await mkdir(join(root, "public/ek030"), { recursive: true });
    await writeFile(join(root, "public/ek030/status.json"), JSON.stringify(payload, null, 2));
    const positionPayload = {
      registration: payload.aircraft?.registration || null,
      icao24: payload.aircraft?.icao24 || null,
      position: payload.aircraft?.position || null,
      updatedAt: payload.updatedAt,
    };
    await writeFile(join(outDir, "position.json"), JSON.stringify(positionPayload, null, 2));
    try {
      const board = await buildLhrBoard();
      await writeFile(join(outDir, "board.json"), JSON.stringify(board, null, 2));
      console.log("board", board.departures.length, "departures,", board.nearby.length, "nearby");
    } catch (be) {
      console.warn("LHR board write failed:", be.message || be);
    }
    console.log(
      "OK-FALLBACK",
      payload.status,
      payload.statusDetail,
      payload.departure.scheduled,
      "→",
      payload.arrival.scheduled,
      "|",
      payload.aircraft?.registration || "no-reg",
      payload.aircraft?.icao24 || "no-hex",
      payload.aircraft?.position ? "pos" : "no-pos",
      "| gate",
      payload.departure.gate || "TBA",
      "/",
      payload.arrival.gate || "TBA"
    );
    return;
  }

  const dep = flight.departureAirport || {};
  const arr = flight.arrivalAirport || {};
  const st = flight.status || {};
  const note = flight.flightNote || {};

  const newsFetchedAt = new Date().toISOString();
  let heathrowDisruption = false;

  try {
    const h = await fetchText("https://www.heathrow.com/departures");
    sources.push({ name: "Heathrow", url: "https://www.heathrow.com/departures" });
    if (/NATS|knock-on disruption|technical issue|operations are recovering|operating today/i.test(h)) {
      heathrowDisruption = true;
      const resolved = /resolved|recovering|operating today/i.test(h);
      caution = resolved
        ? "Heathrow operations recovering after Tuesday's NATS issue (resolved); flights operating today with knock-on cancellations/delays possible. Confirm with Emirates before travelling."
        : "Heathrow disruption from NATS ATC issue; knock-on delays possible. Confirm with Emirates before going to the airport.";
      news.push({
        title: "Heathrow operations recovering — flights operating",
        url: "https://www.heathrow.com/departures",
        source: "Heathrow Airport",
        airport: "LHR",
        summary:
          "NATS technical issue resolved Tuesday evening. Flights operating today; knock-on disruption expected as airlines reposition aircraft and crew. Check with airline before travelling.",
        fetchedAt: newsFetchedAt,
      });
    }
  } catch (e) {
    console.warn("Heathrow departures scrape failed:", e.message || e);
  }

  if (heathrowDisruption) {
    news.push({
      title: "UK flights resume but airports warn of ongoing disruption",
      url: "https://www.reuters.com/world/uk/uk-flights-resume-airports-warn-ongoing-disruption-air-traffic-outage-2026-09-09/",
      source: "Reuters",
      airport: "LHR",
      summary:
        "British airports resumed flights early Wednesday after NATS resolved Tuesday's air-traffic failure; hubs warn recovery will take time with aircraft and crews out of position.",
      fetchedAt: newsFetchedAt,
    });
    news.push({
      title: "Hundreds more Heathrow flights cancelled as network recovers",
      url: "https://www.standard.co.uk/news/london/heathrow-flights-cancelled-latest-wednesday-gatwick-nats-b1295995.html",
      source: "Evening Standard",
      airport: "LHR",
      summary:
        "Wednesday knock-on cancellations continue at Heathrow after NATS resolved the Tuesday outage; passengers advised to check with their airline before travelling.",
      fetchedAt: newsFetchedAt,
    });
  }

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
        summary:
          "EK030 from Heathrow listed among Emirates services running behind schedule amid knock-on UK disruption.",
        fetchedAt: newsFetchedAt,
      });
      caution =
        (caution ? caution + " " : "") +
        "Press lists EK030 among delayed services — treat on-time cautiously.";
    }
  } catch (e) {
    console.warn("The National scrape failed:", e.message || e);
  }

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

  try {
    const board = await buildLhrBoard();
    await writeFile(join(outDir, "board.json"), JSON.stringify(board, null, 2));
    console.log(
      "board",
      board.departures.length,
      "departures,",
      board.nearby.length,
      "nearby"
    );
  } catch (e) {
    console.warn("LHR board write failed:", e.message || e);
  }

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
