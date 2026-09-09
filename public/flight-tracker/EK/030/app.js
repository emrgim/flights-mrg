(function () {
  const STATUS_URL = "./status.json";
  const REFRESH_MS = 60000;
  const ROTATE_MS = 5500;
  const $ = (id) => document.getElementById(id);
  let depNewsItems = [];
  let depNewsIndex = 0;
  let depNewsTimer = null;

  function departureNews(d) {
    const airport = (d.departure?.airport || "LHR").toUpperCase();
    const keys = {
      LHR: [/heathrow/i, /\bLHR\b/i, /NATS/i, /London.*airport/i, /UK air/i],
      DXB: [/dubai/i, /\bDXB\b/i],
    };
    const matchers = keys[airport] || [/./];
    const news = Array.isArray(d.news) ? d.news : [];
    const tagged = news.filter((n) => (n.airport || "").toUpperCase() === airport);
    const scored = news.filter((n) => {
      const blob = `${n.title || ""} ${n.summary || ""} ${n.source || ""}`;
      return matchers.some((re) => re.test(blob));
    });
    const list = tagged.length ? tagged : scored.length ? scored : news;
    return { airport, list };
  }

  function paintDepNews(i) {
    if (!depNewsItems.length) {
      $("depNewsSource").textContent = "—";
      $("depNewsTitle").textContent = "No departure-airport headlines right now.";
      $("depNewsSlide").removeAttribute("href");
      $("depNewsDots").innerHTML = "";
      return;
    }
    const n = depNewsItems[i % depNewsItems.length];
    const slide = $("depNewsSlide");
    slide.classList.add("is-fading");
    slide.classList.remove("is-shown");
    setTimeout(() => {
      $("depNewsSource").textContent = n.source || "News";
      $("depNewsTitle").textContent = n.title || "Untitled";
      if (n.url) {
        slide.href = n.url;
      } else {
        slide.removeAttribute("href");
      }
      [...$("depNewsDots").children].forEach((dot, di) => {
        dot.setAttribute("aria-current", di === i % depNewsItems.length ? "true" : "false");
      });
      slide.classList.remove("is-fading");
      slide.classList.add("is-shown");
    }, 180);
  }

  function startDepNewsRotation(d) {
    const { airport, list } = departureNews(d);
    $("depNewsAirport").textContent = airport;
    depNewsItems = list.slice(0, 8);
    depNewsIndex = 0;
    const dots = $("depNewsDots");
    dots.innerHTML = "";
    depNewsItems.forEach((_, i) => {
      const s = document.createElement("span");
      if (i === 0) s.setAttribute("aria-current", "true");
      dots.appendChild(s);
    });
    paintDepNews(0);
    if (depNewsTimer) clearInterval(depNewsTimer);
    if (depNewsItems.length > 1) {
      depNewsTimer = setInterval(() => {
        depNewsIndex = (depNewsIndex + 1) % depNewsItems.length;
        paintDepNews(depNewsIndex);
      }, ROTATE_MS);
    }
  }


  function timeWithTz(t, tzLabel) {
    if (!t) return "—";
    return tzLabel ? `${t} ${tzLabel}` : t;
  }

  function render(d) {
    const code = d.airlineCode || "EK";
    const num = String(d.flightNumber || "030").replace(/^0+(?=\d)/, "") || "30";
    const padded = String(d.flightNumber || "030");
    $("title").textContent = `(${code}) ${d.airlineName || "Emirates"} ${num}`;
    $("flightNum").textContent = `${code} ${num}`;
    $("airline").textContent = d.airlineName || "Emirates";
    $("depCity").textContent = d.departure?.city || "London";
    $("arrCity").textContent = d.arrival?.city || "Dubai";
    $("status").textContent = d.status || "Status unavailable";
    $("statusDetail").textContent = d.statusDetail || "";

    if (d.caution) {
      $("caution").hidden = false;
      $("caution").textContent = d.caution;
    } else {
      $("caution").hidden = true;
    }

    startDepNewsRotation(d);

    const dep = d.departure || {};
    const arr = d.arrival || {};
    $("depPlace").textContent = [dep.city, dep.region].filter(Boolean).join(", ");
    $("depAirport").textContent = dep.airportName || "London Heathrow Airport";
    $("depDate").textContent = dep.dateLabel || "";
    $("depSched").textContent = timeWithTz(dep.scheduled, dep.timezoneLabel);
    $("depEst").textContent = timeWithTz(dep.estimated, dep.timezoneLabel);
    $("depAct").textContent = timeWithTz(dep.actual, dep.timezoneLabel);
    $("depTerm").textContent = dep.terminal || "N/A";
    $("depGate").textContent = dep.gate || "N/A";

    $("arrPlace").textContent = [arr.city, arr.region].filter(Boolean).join(", ");
    $("arrAirport").textContent = arr.airportName || "Dubai International Airport";
    $("arrDate").textContent = arr.dateLabel || "";
    $("arrSched").textContent = timeWithTz(arr.scheduled, arr.timezoneLabel);
    $("arrEst").textContent = timeWithTz(arr.estimated, arr.timezoneLabel);
    $("arrAct").textContent = timeWithTz(arr.actual, arr.timezoneLabel);
    $("arrTerm").textContent = arr.terminal || "N/A";
    $("arrGate").textContent = arr.gate || "N/A";

    const tr = d.tracking || {};
    $("trackerMsg").textContent =
      tr.message ||
      (tr.available
        ? "Live tracking active"
        : "Tracking will begin after departure");

    const cs = $("codeshares");
    cs.innerHTML = "";
    (d.codeshares || []).forEach((c) => {
      const li = document.createElement("li");
      li.textContent = `${c.airline} · ${c.flight}`;
      cs.appendChild(li);
    });
    if (!(d.codeshares || []).length) {
      const li = document.createElement("li");
      li.className = "muted";
      li.textContent = "—";
      cs.appendChild(li);
    }

    const ac = d.aircraft || {};
    $("aircraft").textContent = [ac.code, ac.description].filter(Boolean).join(" · ") || "—";


    // Past / upcoming days
    const tabs = $("dayTabs");
    const panel = $("dayPanel");
    tabs.innerHTML = "";
    panel.innerHTML = "";
    const days = d.otherDays || [];
    let selected = days.findIndex((x) => (x.flights || []).length && (d.date && (x.label || "").startsWith(d.date.slice(8,10) === undefined ? "" : "")));
    // Prefer today's label match, else first with flights, else 0
    selected = Math.max(0, days.findIndex((x) => x.label && d.departure?.dateLabel && d.departure.dateLabel.startsWith(x.label.slice(0,6))));
    if (selected < 0) selected = Math.max(0, days.findIndex((x) => (x.flights || []).length));
    if (selected < 0) selected = 0;

    function showDay(idx) {
      [...tabs.querySelectorAll(".tab")].forEach((b, i) => b.setAttribute("aria-selected", i === idx ? "true" : "false"));
      const day = days[idx];
      if (!day) { panel.innerHTML = '<p class="day-empty">No schedule data.</p>'; return; }
      const title = `Flights for ${day.day || ""}${day.year ? ", " + (day.label || "") + "-" + day.year : ""}`.replace(/,\s*-/, ",");
      let html = `<p class="day-title">${day.day ? "Flights for " + day.day + ", " + day.label + "-" + day.year : day.label}</p>`;
      const flights = day.flights || [];
      if (!flights.length) {
        html += '<p class="day-empty">No flight information available for this date.</p>';
      } else {
        for (const f of flights) {
          html += `<div class="day-row">
            <div><div class="day-time">${f.dep || "—"} ${f.depTz || ""}</div><div class="day-air">${f.from || ""}</div></div>
            <div class="arrow" aria-hidden="true">→</div>
            <div style="text-align:right"><div class="day-time">${f.arr || "—"} ${f.arrTz || ""}</div><div class="day-air">${f.to || ""}</div></div>
          </div>`;
        }
      }
      panel.innerHTML = html;
    }

    days.forEach((day, idx) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "tab";
      b.textContent = day.label || ("Day " + (idx + 1));
      b.addEventListener("click", () => showDay(idx));
      tabs.appendChild(b);
    });
    if (days.length) showDay(selected);

    const news = $("news");
    news.innerHTML = "";
    const items = d.news || [];
    if (!items.length) {
      const li = document.createElement("li");
      li.className = "muted";
      li.textContent = "No recent airport traffic headlines.";
      news.appendChild(li);
    } else {
      items.forEach((n) => {
        const li = document.createElement("li");
        const a = document.createElement("a");
        a.href = n.url || "#";
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = n.title || "Untitled";
        li.appendChild(a);
        const src = document.createElement("span");
        src.className = "news-src";
        src.textContent = n.source || "";
        li.appendChild(src);
        if (n.summary) {
          const p = document.createElement("p");
          p.className = "news-sum";
          p.textContent = n.summary;
          li.appendChild(p);
        }
        news.appendChild(li);
      });
    }

    try {
      $("updated").textContent =
        "Updated " +
        new Intl.DateTimeFormat("en-GB", {
          dateStyle: "medium",
          timeStyle: "short",
          timeZone: "Asia/Dubai",
        }).format(new Date(d.updatedAt)) +
        " GST · Auto-refresh 60s";
    } catch {
      $("updated").textContent = "Updated " + (d.updatedAt || "—");
    }

    const sources = (d.sources || [])
      .filter((s) => s && s.name)
      .map((s) =>
        s.url
          ? `<a href="${s.url}" target="_blank" rel="noopener">${s.name}</a>`
          : s.name
      );
    $("sources").innerHTML = sources.length ? "Sources: " + sources.join(" · ") : "";

    document.title = `${code}${padded} · ${d.airlineName || "Emirates"} Flight Tracker`;
  }

  async function load() {
    try {
      const res = await fetch(STATUS_URL + "?t=" + Date.now(), { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      render(await res.json());
    } catch (e) {
      render({
        airlineCode: "EK",
        flightNumber: "030",
        airlineName: "Emirates",
        status: "Status unavailable",
        statusDetail: String(e.message || e),
        departure: { city: "London", region: "EN, GB", airportName: "London Heathrow Airport" },
        arrival: { city: "Dubai", region: "AE", airportName: "Dubai International Airport" },
        tracking: { available: false, message: "Live feed offline" },
        codeshares: [],
        aircraft: {},
        news: [],
        sources: [],
        updatedAt: null,
      });
    }
  }

  load();
  setInterval(load, REFRESH_MS);
})();
