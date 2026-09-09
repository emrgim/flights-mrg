(function () {
  const STATUS_URL = "./status.json";
  const REFRESH_MS = 60000;
  const FALLBACK_NEWS = [
    {
      title: "NATS air traffic control technical issue — Heathrow",
      url: "https://www.heathrow.com/departures/terminal-3/flight-details/EK030",
      source: "Heathrow Airport",
      airport: "LHR",
      summary:
        "Operations recovering after NATS issue; knock-on disruption expected as airlines reposition aircraft and crew.",
    },
    {
      title: "Dubai/Abu Dhabi delays after Heathrow outage",
      url: "https://www.thenationalnews.com/travel/2026/09/09/dubai-abu-dhabi-flight-delays-cancellations/",
      source: "The National",
      airport: "LHR",
      summary:
        "EK030 from Heathrow listed among Emirates services running behind schedule amid UK ATC disruption.",
    },
  ];

  const $ = (id) => {
    const el = document.getElementById(id);
    if (el) return el;
    // Null-safe stub so a missing node never kills the whole render
    return {
      textContent: "",
      innerHTML: "",
      hidden: false,
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      setAttribute() {},
      removeAttribute() {},
      addEventListener() {},
      querySelectorAll() { return []; },
      children: [],
      href: "",
      style: {},
    };
  };
  let depNewsItems = [];
  let depNewsIndex = 0;
  let expanded = false;
  let wired = false;

  function departureNews(d) {
    const airport = (d.departure && d.departure.airport ? d.departure.airport : "LHR").toUpperCase();
    const raw = Array.isArray(d.news) && d.news.length ? d.news : FALLBACK_NEWS;
    const tagged = raw.filter((n) => ((n.airport || "").toUpperCase() === airport));
    const matchers = [/heathrow/i, /\bLHR\b/i, /NATS/i, /London/i, /air traffic/i];
    const scored = raw.filter((n) => {
      const blob = (n.title || "") + " " + (n.summary || "") + " " + (n.source || "");
      return matchers.some((re) => re.test(blob));
    });
    let list = tagged.length ? tagged : scored.length ? scored : raw;
    list = list.filter((n) => n && (n.title || n.summary));
    if (!list.length) list = FALLBACK_NEWS.slice();
    return { airport, list };
  }

  function paintNewsUI() {
    const now = $("newsNow");
    const seq = $("tickerSeq");
    if (!depNewsItems.length) {
      now.textContent = "No departure-airport headlines right now.";
      seq.textContent = "No departure-airport headlines right now.   ";
      return;
    }
    const current = depNewsItems[depNewsIndex % depNewsItems.length];
    now.textContent = (current.source ? current.source + " · " : "") + (current.title || "Untitled");
    const joined = depNewsItems
      .map((n) => (n.source ? n.source + ": " : "") + (n.title || "Untitled"))
      .join("     ·     ");
    // duplicate for continuous feel
    seq.textContent = joined + "     ·     " + joined + "     ·     ";
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
    expanded = !!on;
    $("newsTickerCard").classList.toggle("is-expanded", expanded);
    $("newsTickerToggle").setAttribute("aria-expanded", expanded ? "true" : "false");
    $("newsExpand").hidden = !expanded;
    $("newsTickerHint").textContent = expanded ? "Tap header to collapse" : "Tap to expand & read";
    if (expanded) paintExpanded();
  }

  function wire() {
    if (wired) return;
    wired = true;
    $("newsTickerToggle").addEventListener("click", function () {
      setExpanded(!expanded);
    });
    $("newsPrev").addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (!depNewsItems.length) return;
      depNewsIndex = (depNewsIndex - 1 + depNewsItems.length) % depNewsItems.length;
      paintNewsUI();
      paintExpanded();
    });
    $("newsNext").addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (!depNewsItems.length) return;
      depNewsIndex = (depNewsIndex + 1) % depNewsItems.length;
      paintNewsUI();
      paintExpanded();
    });
  }

  function startDepNews(d) {
    const out = departureNews(d || {});
    $("depNewsAirport").textContent = out.airport;
    depNewsItems = out.list.slice(0, 12);
    if (depNewsIndex >= depNewsItems.length) depNewsIndex = 0;
    paintNewsUI();
    if (expanded) paintExpanded();
    wire();
  }

  function timeWithTz(t, tzLabel) {
    if (!t) return "—";
    return tzLabel ? t + " " + tzLabel : t;
  }

  function render(d) {
    d = d || {};
    // News first so a later crash still leaves headlines visible
    try {
      startDepNews(d);
    } catch (err) {
      console.error(err);
      depNewsItems = FALLBACK_NEWS.slice();
      paintNewsUI();
      wire();
    }

    const code = d.airlineCode || "EK";
    const num = String(d.flightNumber || "030").replace(/^0+(?=\d)/, "") || "30";
    const padded = String(d.flightNumber || "030");
    $("title").textContent = "(" + code + ") " + (d.airlineName || "Emirates") + " " + num;
    $("flightNum").textContent = code + " " + num;
    $("airline").textContent = d.airlineName || "Emirates";
    $("depCity").textContent = (d.departure && d.departure.city) || "London";
    $("arrCity").textContent = (d.arrival && d.arrival.city) || "Dubai";
    $("status").textContent = d.status || "Status unavailable";
    $("statusDetail").textContent = d.statusDetail || "";

    const statusPanel = document.getElementById("status-heading")
      ? document.getElementById("status-heading").closest(".status-panel")
      : document.querySelector(".status-panel");
    if (d.caution) {
      $("caution").hidden = false;
      $("caution").textContent = d.caution;
      $("emiratesContactWrap").hidden = false;
      if (statusPanel) statusPanel.classList.add("is-alert");
    } else {
      $("caution").hidden = true;
      $("emiratesContactWrap").hidden = true;
      if (statusPanel) statusPanel.classList.remove("is-alert");
    }

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
      tr.message || (tr.available ? "Live tracking active" : "Tracking will begin after departure");

    const cs = $("codeshares");
    cs.innerHTML = "";
    (d.codeshares || []).forEach(function (c) {
      const li = document.createElement("li");
      li.textContent = c.airline + " · " + c.flight;
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

    const tabs = $("dayTabs");
    const panel = $("dayPanel");
    tabs.innerHTML = "";
    panel.innerHTML = "";
    const days = d.otherDays || [];
    let selected = 0;
    for (let i = 0; i < days.length; i++) {
      if (days[i].label && dep.dateLabel && String(dep.dateLabel).indexOf(String(days[i].label).slice(0, 6)) === 0) {
        selected = i;
        break;
      }
    }

    function showDay(idx) {
      const buttons = tabs.querySelectorAll(".tab");
      for (let i = 0; i < buttons.length; i++) {
        buttons[i].setAttribute("aria-selected", i === idx ? "true" : "false");
      }
      const day = days[idx];
      if (!day) {
        panel.innerHTML = '<p class="day-empty">No schedule data.</p>';
        return;
      }
      let html =
        '<p class="day-title">' +
        (day.day ? "Flights for " + day.day + ", " + day.label + "-" + day.year : day.label) +
        "</p>";
      const flights = day.flights || [];
      if (!flights.length) {
        html += '<p class="day-empty">No flight information available for this date.</p>';
      } else {
        for (let fi = 0; fi < flights.length; fi++) {
          const f = flights[fi];
          html +=
            '<div class="day-row"><div><div class="day-time">' +
            (f.dep || "—") +
            " " +
            (f.depTz || "") +
            '</div><div class="day-air">' +
            (f.from || "") +
            '</div></div><div class="arrow" aria-hidden="true">→</div><div style="text-align:right"><div class="day-time">' +
            (f.arr || "—") +
            " " +
            (f.arrTz || "") +
            '</div><div class="day-air">' +
            (f.to || "") +
            "</div></div></div>";
        }
      }
      panel.innerHTML = html;
    }

    days.forEach(function (day, idx) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "tab";
      b.textContent = day.label || "Day " + (idx + 1);
      b.addEventListener("click", function () {
        showDay(idx);
      });
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
    } catch (e) {
      $("updated").textContent = "Updated " + (d.updatedAt || "—");
    }

    const sources = (d.sources || [])
      .filter(function (s) {
        return s && s.name;
      })
      .map(function (s) {
        return s.url
          ? '<a href="' + s.url + '" target="_blank" rel="noopener">' + s.name + "</a>"
          : s.name;
      });
    $("sources").innerHTML = sources.length ? "Sources: " + sources.join(" · ") : "";
    document.title = code + padded + " · " + (d.airlineName || "Emirates") + " Flight Tracker";
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
        departure: { city: "London", region: "EN, GB", airport: "LHR", airportName: "London Heathrow Airport" },
        arrival: { city: "Dubai", region: "AE", airport: "DXB", airportName: "Dubai International Airport" },
        tracking: { available: false, message: "Live feed offline" },
        codeshares: [],
        aircraft: {},
        news: FALLBACK_NEWS,
        sources: [],
        updatedAt: null,
      });
    }
  }

  // Paint fallback immediately so the card is never empty while fetch runs
  startDepNews({ departure: { airport: "LHR" }, news: FALLBACK_NEWS });
  load();
  setInterval(load, REFRESH_MS);
})();
