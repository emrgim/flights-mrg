(function () {
  const STATUS_URL = "./status.json";
  const REFRESH_MS = 60000;
  const $ = (id) => document.getElementById(id);

  let depNewsItems = [];
  let depNewsIndex = 0;
  let expanded = false;

  function departureNews(d) {
    const airport = (d.departure?.airport || "LHR").toUpperCase();
    const news = Array.isArray(d.news) ? d.news.slice() : [];
    const tagged = news.filter((n) => (n.airport || "").toUpperCase() === airport);
    const matchers = [
      /heathrow/i,
      /\bLHR\b/i,
      /NATS/i,
      /London/i,
      /UK air/i,
      /air traffic/i,
    ];
    const scored = news.filter((n) => {
      const blob = `${n.title || ""} ${n.summary || ""} ${n.source || ""}`;
      return matchers.some((re) => re.test(blob));
    });
    const list = (tagged.length ? tagged : scored.length ? scored : news).filter(
      (n) => n && (n.title || n.summary)
    );
    return { airport, list };
  }

  function tickerText() {
    if (!depNewsItems.length) return "No departure-airport headlines right now.";
    return depNewsItems
      .map((n) => `${n.source ? n.source + ": " : ""}${n.title || "Untitled"}`)
      .join("   ·   ");
  }

  function paintTicker() {
    const text = tickerText();
    $("tickerItemA").textContent = text;
    $("tickerItemB").textContent = text;
  }

  function paintExpanded() {
    if (!depNewsItems.length) {
      $("newsExpandSource").textContent = "—";
      $("newsExpandTitle").textContent = "No news";
      $("newsExpandBody").textContent = "No departure-airport headlines in the latest update.";
      $("newsOpen").hidden = true;
      return;
    }
    const n = depNewsItems[depNewsIndex % depNewsItems.length];
    $("newsExpandSource").textContent = n.source || "News";
    $("newsExpandTitle").textContent = n.title || "Untitled";
    $("newsExpandBody").textContent =
      n.summary || n.body || "No article body in feed — open the source for the full story.";
    if (n.url) {
      $("newsOpen").hidden = false;
      $("newsOpen").href = n.url;
    } else {
      $("newsOpen").hidden = true;
    }
  }

  function setExpanded(on) {
    expanded = on;
    const card = $("newsTickerCard");
    card.classList.toggle("is-expanded", on);
    $("newsTickerToggle").setAttribute("aria-expanded", on ? "true" : "false");
    $("newsExpand").hidden = !on;
    $("newsTickerHint").textContent = on ? "Tap header to collapse" : "Tap to expand";
    if (on) paintExpanded();
  }

  function wireNewsControls(once) {
    if (once._wired) return;
    once._wired = true;
    $("newsTickerToggle").addEventListener("click", () => setExpanded(!expanded));
    $("newsPrev").addEventListener("click", (e) => {
      e.preventDefault();
      if (!depNewsItems.length) return;
      depNewsIndex = (depNewsIndex - 1 + depNewsItems.length) % depNewsItems.length;
      paintExpanded();
    });
    $("newsNext").addEventListener("click", (e) => {
      e.preventDefault();
      if (!depNewsItems.length) return;
      depNewsIndex = (depNewsIndex + 1) % depNewsItems.length;
      paintExpanded();
    });
  }

  function startDepNews(d) {
    const { airport, list } = departureNews(d);
    $("depNewsAirport").textContent = airport;
    depNewsItems = list.slice(0, 12);
    if (depNewsIndex >= depNewsItems.length) depNewsIndex = 0;
    paintTicker();
    if (expanded) paintExpanded();
    wireNewsControls(startDepNews);
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

    startDepNews(d);

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
      (tr.available ? "Live tracking active" : "Tracking will begin after departure");

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
    $("aircraft").textContent =
      [ac.code, ac.description].filter(Boolean).join(" · ") || "—";

    const tabs = $("dayTabs");
    const panel = $("dayPanel");
    tabs.innerHTML = "";
    panel.innerHTML = "";
    const days = d.otherDays || [];
    let selected = days.findIndex(
      (x) =>
        x.label &&
        d.departure?.dateLabel &&
        d.departure.dateLabel.startsWith(x.label.slice(0, 6))
    );
    if (selected < 0) selected = Math.max(0, days.findIndex((x) => (x.flights || []).length));
    if (selected < 0) selected = 0;

    function showDay(idx) {
      [...tabs.querySelectorAll(".tab")].forEach((b, i) =>
        b.setAttribute("aria-selected", i === idx ? "true" : "false")
      );
      const day = days[idx];
      if (!day) {
        panel.innerHTML = '<p class="day-empty">No schedule data.</p>';
        return;
      }
      let html = `<p class="day-title">${
        day.day ? "Flights for " + day.day + ", " + day.label + "-" + day.year : day.label
      }</p>`;
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
      b.textContent = day.label || "Day " + (idx + 1);
      b.addEventListener("click", () => showDay(idx));
      tabs.appendChild(b);
    });
    if (days.length) showDay(selected);

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
        departure: {
          city: "London",
          region: "EN, GB",
          airport: "LHR",
          airportName: "London Heathrow Airport",
        },
        arrival: {
          city: "Dubai",
          region: "AE",
          airport: "DXB",
          airportName: "Dubai International Airport",
        },
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
