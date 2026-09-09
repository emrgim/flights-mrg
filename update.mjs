#!/usr/bin/env node
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const outDir = join(root, "public/flight-tracker/EK/030");
const out = join(outDir, "status.json");

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
  await mkdir(outDir, { recursive: true });
  let prev = {};
  try { prev = JSON.parse(await readFile(out, "utf8")); } catch {}

  let status = prev.status || "Status unavailable";
  let statusDetail = prev.statusDetail || "";
  let caution = null;
  let departure = prev.departure || {
    city: "London", region: "EN, GB", airportName: "London Heathrow Airport", airport: "LHR",
    timezoneLabel: "BST", timezone: "Europe/London", terminal: "3", gate: null,
  };
  let arrival = prev.arrival || {
    city: "Dubai", region: "AE", airportName: "Dubai International Airport", airport: "DXB",
    timezoneLabel: "+04", timezone: "Asia/Dubai", terminal: "3", gate: null,
  };
  const news = [];
  const sources = [];

  try {
    const html = await fetchText("https://www.flightstats.com/v2/flight-tracker/EK/030");
    sources.push({ name: "FlightStats", url: "https://www.flightstats.com/v2/flight-tracker/EK/030" });
    // Prefer the Flight Status panel; avoid matching other flights mentioned on the page
    const panel = pick(/Flight Status([\s\S]{0,1200}?)Flight Departure Times/i, html) || html.slice(0, 4000);
    if (/\bCancelled\b/i.test(panel) && !/On time/i.test(panel)) { status = "Cancelled"; statusDetail = ""; }
    else if (/\bDiverted\b/i.test(panel)) { status = "Diverted"; statusDetail = ""; }
    else if (/\b(?:Landed|Arrived)\b/i.test(panel)) { status = "Landed"; statusDetail = ""; }
    else if (/Delayed by\s+([^\n<]+)/i.test(panel)) { status = "Delayed"; statusDetail = pick(/Delayed by\s+([^\n<]+)/i, panel) || "Delayed"; }
    else if (/\bDelayed\b/i.test(panel) && !/On time/i.test(panel)) { status = "Delayed"; statusDetail = "Delayed"; }
    else if (/On time/i.test(panel)) { status = "Scheduled"; statusDetail = "On time"; }
    else if (/\bScheduled\b/i.test(panel)) { status = "Scheduled"; statusDetail = statusDetail || ""; }

    const depT = pick(/Flight Departure Times[\s\S]{0,200}?Estimated[\s\S]{0,40}?(\d{2}:\d{2})\s*BST/i, html)
      || pick(/Scheduled[\s\S]{0,40}?(\d{2}:\d{2})\s*BST/i, html);
    const depS = pick(/Flight Departure Times[\s\S]{0,120}?Scheduled[\s\S]{0,40}?(\d{2}:\d{2})\s*BST/i, html) || depT;
    const arrT = pick(/Flight Arrival Times[\s\S]{0,200}?Estimated[\s\S]{0,40}?(\d{2}:\d{2})\s*\+04/i, html)
      || pick(/Scheduled[\s\S]{0,40}?(\d{2}:\d{2})\s*\+04/i, html);
    const arrS = pick(/Flight Arrival Times[\s\S]{0,120}?Scheduled[\s\S]{0,40}?(\d{2}:\d{2})\s*\+04/i, html) || arrT;
    const depDate = pick(/Flight Departure Times[\s\S]{0,80}?(\d{2}-[A-Za-z]{3}-\d{4})/i, html);
    const arrDate = pick(/Flight Arrival Times[\s\S]{0,80}?(\d{2}-[A-Za-z]{3}-\d{4})/i, html);

    departure = {
      ...departure,
      scheduled: depS || departure.scheduled,
      estimated: depT || departure.estimated,
      dateLabel: depDate || departure.dateLabel,
      timezoneLabel: "BST",
    };
    arrival = {
      ...arrival,
      scheduled: arrS || arrival.scheduled,
      estimated: arrT || arrival.estimated,
      dateLabel: arrDate || arrival.dateLabel,
      timezoneLabel: "+04",
    };
  } catch (e) {
    statusDetail = (statusDetail ? statusDetail + " · " : "") + "FlightStats fetch failed";
  }

  try {
    const h = await fetchText("https://www.heathrow.com/departures/terminal-3/flight-details/EK030");
    sources.push({ name: "Heathrow", url: "https://www.heathrow.com/departures/terminal-3/flight-details/EK030" });
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
    sources.push({ name: "The National", url: nUrl });
    if (/EK030/i.test(n)) {
      news.push({
        title: "Dubai/Abu Dhabi delays after Heathrow outage",
        url: nUrl,
        source: "The National",
        summary: "EK030 from Heathrow listed among Emirates services running behind schedule.",
      });
      caution = (caution ? caution + " " : "") + "Press lists EK030 among delayed services — treat on-time cautiously.";
    }
  } catch {}

  const payload = {
    airlineCode: "EK",
    flightNumber: "030",
    airlineName: "Emirates",
    status,
    statusDetail,
    date: new Date().toISOString().slice(0, 10),
    departure,
    arrival,
    tracking: {
      available: false,
      message: "Positional tracking not available yet. Tracking will begin after departure.",
    },
    codeshares: [
      { airline: "Icelandair", flight: "FI 6036" },
      { airline: "Qantas", flight: "QF 8030" },
    ],
    aircraft: { code: "388", description: "Airbus A380-800 Passenger" },
    caution,
    news,
    updatedAt: new Date().toISOString(),
    sources,
  };

  await writeFile(out, JSON.stringify(payload, null, 2));
  // keep legacy ek030 status in sync for old bookmarks during redirect era
  await mkdir(join(root, "public/ek030"), { recursive: true });
  await writeFile(join(root, "public/ek030/status.json"), JSON.stringify(payload, null, 2));
  console.log("Wrote", out, status, statusDetail);
}

main().catch((e) => { console.error(e); process.exit(1); });
