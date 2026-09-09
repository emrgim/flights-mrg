#!/usr/bin/env node
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const outDir = join(root, "public/flight-tracker/EK/030");
const out = join(outDir, "status.json");

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
      accept: "text/html,application/json",
    },
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.text();
}

function parseNextData(html) {
  const m = html.match(/__NEXT_DATA__\s*=\s*(\{[\s\S]*?\});?\s*(?:__NEXT_LOADED_PAGES__|<)/);
  if (!m) throw new Error("No __NEXT_DATA__");
  return JSON.parse(m[1]);
}

function fmtDateLabel(isoLocal) {
  if (!isoLocal) return null;
  const d = new Date(isoLocal);
  if (Number.isNaN(d.getTime())) return null;
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const dd = String(d.getUTCDate()).padStart(2, "0");
  // FlightStats date labels are local calendar dates already in the string
  const m = isoLocal.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const mon = months[Number(m[2]) - 1];
  return `${m[3]}-${mon}-${m[1]}`;
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

  const payload = {
    airlineCode: flight.ticketHeader?.carrier?.fs || "EK",
    flightNumber: String(flight.ticketHeader?.flightNumber || "30").padStart(3, "0"),
    airlineName: flight.ticketHeader?.carrier?.name || "Emirates",
    flightId: flight.flightId,
    status: note.canceled ? "Cancelled" : st.status || "Status unavailable",
    statusDetail: st.statusDescription || st.delayStatus?.wording || "",
    statusCode: st.statusCode || null,
    date: (dep.date || "").slice(0, 10),
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
      available: Boolean(flight.isTracking),
      message:
        note.message ||
        (flight.isTracking
          ? "Live tracking active"
          : "Positional tracking not available yet. Tracking will begin after departure."),
    },
    codeshares: (flight.codeshares || []).map((c) => ({
      airline: c.name,
      flight: `${c.fs} ${c.flightNumber}`,
    })),
    aircraft: {
      code: flight.additionalFlightInfo?.equipment?.iata || null,
      description: flight.additionalFlightInfo?.equipment?.name || null,
      duration: flight.additionalFlightInfo?.flightDuration || null,
    },
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
  console.log("OK", payload.status, payload.statusDetail, payload.departure.scheduled, "→", payload.arrival.scheduled);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
