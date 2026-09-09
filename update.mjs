#!/usr/bin/env node
/** Refresh public/ek030/status.json for EK030. Never invent times if fetch fails. */
import { writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const out = join(root, "public/ek030/status.json");

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; FlynnFlightWatch/1.0)",
      accept: "text/html,application/json",
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.text();
}

function pick(re, text) {
  const m = text.match(re);
  return m ? m[1].trim() : null;
}

async function main() {
  let prev = {};
  try { prev = JSON.parse(await readFile(out, "utf8")); } catch {}

  const news = [];
  let status = prev.status || "Status unavailable";
  let statusDetail = prev.statusDetail || "";
  let caution = prev.caution || null;
  let departure = prev.departure || null;
  let arrival = prev.arrival || null;
  let aircraft = prev.aircraft || null;
  const sources = [];

  try {
    const fsHtml = await fetchText("https://www.flightstats.com/v2/flight-tracker/EK/030");
    sources.push("https://www.flightstats.com/v2/flight-tracker/EK/030");
    if (/On time/i.test(fsHtml)) { status = "Scheduled"; statusDetail = "On time (FlightStats)"; }
    else if (/Delayed/i.test(fsHtml)) { status = "Delayed"; statusDetail = "Delayed (FlightStats)"; }
    else if (/Landed|Arrived/i.test(fsHtml)) { status = "Landed"; statusDetail = "Arrived (FlightStats)"; }
    else if (/Cancelled/i.test(fsHtml)) { status = "Cancelled"; statusDetail = "Cancelled (FlightStats)"; }
    const depSched = pick(/Scheduled[\s\S]{0,40}?(\d{2}:\d{2})\s*BST/i, fsHtml);
    const arrSched = pick(/Scheduled[\s\S]{0,40}?(\d{2}:\d{2})\s*\+04/i, fsHtml);
    if (depSched) {
      departure = {
        airport: "LHR", terminal: "3", gate: null,
        scheduledLocal: `2026-09-09T${depSched}:00+01:00`,
        estimatedLocal: `2026-09-09T${depSched}:00+01:00`,
        timezone: "Europe/London",
      };
    }
    if (arrSched) {
      arrival = {
        airport: "DXB", terminal: "3", gate: null,
        scheduledLocal: `2026-09-10T${arrSched}:00+04:00`,
        estimatedLocal: `2026-09-10T${arrSched}:00+04:00`,
        timezone: "Asia/Dubai",
      };
    }
    if (/A380|388/i.test(fsHtml)) aircraft = "Airbus A380-800";
  } catch (e) {
    statusDetail = (statusDetail ? statusDetail + " · " : "") + "FlightStats fetch failed";
  }

  try {
    const h = await fetchText("https://www.heathrow.com/departures/terminal-3/flight-details/EK030");
    sources.push("https://www.heathrow.com/departures/terminal-3/flight-details/EK030");
    if (/NATS|knock-on disruption|technical issue/i.test(h)) {
      caution = "Heathrow recovering from NATS ATC issue; knock-on disruption possible. Confirm with Emirates before going to the airport.";
      news.push({
        title: "NATS air traffic control technical issue — Heathrow",
        url: "https://www.heathrow.com/departures/terminal-3/flight-details/EK030",
        source: "Heathrow Airport",
        summary: "Operations recovering; some knock-on disruption expected as airlines reposition aircraft and crew.",
      });
    }
  } catch {}

  try {
    const nUrl = "https://www.thenationalnews.com/travel/2026/09/09/dubai-abu-dhabi-flight-delays-cancellations/";
    const n = await fetchText(nUrl);
    sources.push(nUrl);
    if (/EK030/i.test(n)) {
      news.push({
        title: "Dubai/Abu Dhabi delays after Heathrow outage",
        url: nUrl,
        source: "The National",
        summary: "EK030 from Heathrow listed among Emirates services running behind schedule; check live status.",
      });
      if (status === "Scheduled") {
        caution = (caution ? caution + " " : "") + "Press reports list EK030 among delayed services — treat on-time cautiously.";
      }
    }
  } catch {}

  const payload = {
    flight: "EK030",
    airline: "Emirates",
    route: { from: "LHR", to: "DXB", fromName: "London Heathrow", toName: "Dubai International" },
    status,
    statusDetail,
    caution,
    departure,
    arrival,
    aircraft,
    codeshares: ["FI6036", "QF8030"],
    updatedAt: new Date().toISOString(),
    news,
    sources,
  };
  await writeFile(out, JSON.stringify(payload, null, 2));
  console.log("Wrote", out, status, statusDetail);
}

main().catch((e) => { console.error(e); process.exit(1); });
