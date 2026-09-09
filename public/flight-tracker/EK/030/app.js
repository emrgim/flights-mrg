(function () {
  const STATUS_URL = "./status.json";
  const REFRESH_MS = 45000;
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


  const LHR = [51.47, -0.4543];
  const DXB = [25.2532, 55.3657];

  let lastUpdatedAt = null;
  let latestTickTimer = null;

  function fmtLatestUpdate(iso) {
    if (!iso) return "Latest update —";
    const then = new Date(iso);
    if (Number.isNaN(then.getTime())) return "Latest update —";
    const now = Date.now();
    const diffMs = Math.max(0, now - then.getTime());
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 60) {
      const m = Math.max(1, diffMin || (diffMs < 15000 ? 0 : 1));
      if (m <= 0) return "Latest update · adesso";
      if (m === 1) return "Latest update · 1 minuto fa";
      return "Latest update · " + m + " minuti fa";
    }
    try {
      const clock = new Intl.DateTimeFormat("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "Asia/Dubai",
      }).format(then);
      return "Latest update · " + clock;
    } catch (e) {
      return "Latest update · " + then.toISOString();
    }
  }

  function paintLatestUpdate(iso) {
    if (iso) lastUpdatedAt = iso;
    const el = document.getElementById("latestUpdate");
    if (!el) return;
    el.textContent = fmtLatestUpdate(lastUpdatedAt);
    if (lastUpdatedAt) {
      try {
        el.title = new Intl.DateTimeFormat("en-GB", {
          dateStyle: "medium",
          timeStyle: "medium",
          timeZone: "Asia/Dubai",
        }).format(new Date(lastUpdatedAt)) + " GST";
      } catch (e) {
        el.title = String(lastUpdatedAt);
      }
    } else {
      el.title = "";
    }
    if (!latestTickTimer) {
      latestTickTimer = setInterval(function () {
        paintLatestUpdate(null);
      }, 30000);
    }
  }

  let map = null;
  let planeMarker = null;
  let routeLine = null;
  let lastPosKey = "";

  function planeSvg(heading) {
    // Outer div pulses; inner rotates with heading (don't fight transform)
    return (
      '<div class="plane-marker">' +
      '<div class="plane-rot" style="transform:rotate(' +
      (Number(heading) || 0) +
      'deg)">' +
      '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<path fill="#111" stroke="#fff" stroke-width="1.2" stroke-linejoin="round" ' +
      'd="M12 2 L14.2 9.5 L21 11 L14.2 12.2 L12 22 L9.8 12.2 L3 11 L9.8 9.5 Z"/>' +
      "</svg></div></div>"
    );
  }

  function ensureMap() {
    if (map) return map;
    if (typeof L === "undefined") return null;
    const el = document.getElementById("map");
    if (!el) return null;
    map = L.map(el, {
      zoomControl: true,
      attributionControl: true,
      scrollWheelZoom: false,
    });
    // Carto light tiles (OSM data) — more reliable than tile.openstreetmap.org on mobile CDNs
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
      maxZoom: 18,
      subdomains: "abcd",
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    }).addTo(map);
    routeLine = L.polyline([LHR, DXB], {
      color: "#111",
      weight: 1.5,
      opacity: 0.45,
      dashArray: "4 6",
    }).addTo(map);
    map.fitBounds(L.latLngBounds(LHR, DXB).pad(0.18));
    [80, 300, 800].forEach(function (ms) {
      setTimeout(function () {
        try {
          map.invalidateSize();
        } catch (e) {}
      }, ms);
    });
    return map;
  }

  function fmtSeen(iso) {
    if (!iso) return "";
    try {
      return new Intl.DateTimeFormat("en-GB", {
        timeStyle: "medium",
        timeZone: "Asia/Dubai",
      }).format(new Date(iso)) + " GST";
    } catch (e) {
      return String(iso);
    }
  }

  function updateMap(d) {
    d = d || {};
    const ac = d.aircraft || {};
    const pos = ac.position || null;
    const reg = ac.registration || null;
    const m = ensureMap();

    const regEl = document.getElementById("mapReg");
    const seenEl = document.getElementById("mapSeen");
    if (regEl) {
      regEl.textContent = reg
        ? "Hull " + reg + (ac.icao24 ? " · " + String(ac.icao24).toUpperCase() : "")
        : "Hull not yet assigned";
    }

    if (!m) {
      if (seenEl) seenEl.textContent = "Map library unavailable";
      return;
    }

    if (!pos || !Number.isFinite(Number(pos.lat)) || !Number.isFinite(Number(pos.lon))) {
      if (seenEl) {
        seenEl.textContent = reg
          ? "Waiting for ADS-B / aircraft not yet transmitting"
          : "Waiting for ADS-B / aircraft not yet assigned";
      }
      if (planeMarker) {
        try {
          m.removeLayer(planeMarker);
        } catch (e) {}
        planeMarker = null;
        lastPosKey = "";
      }
      if (routeLine) {
        try {
          m.fitBounds(L.latLngBounds(LHR, DXB).pad(0.18));
        } catch (e) {}
      } else {
        m.setView(LHR, 5);
      }
      return;
    }

    const lat = Number(pos.lat);
    const lon = Number(pos.lon);
    const heading = Number(pos.heading) || 0;
    const key = [lat.toFixed(4), lon.toFixed(4), heading.toFixed(0), reg || ""].join("|");

    const bits = [];
    if (pos.onGround) bits.push("on ground");
    else if (pos.altitude != null) bits.push(Math.round(pos.altitude) + " ft");
    if (pos.speed != null) bits.push(Math.round(pos.speed) + " kt");
    if (pos.source) bits.push(pos.source);
    if (pos.seenAt) bits.push("seen " + fmtSeen(pos.seenAt));
    if (seenEl) seenEl.textContent = bits.join(" · ") || "Live position";

    const icon = L.divIcon({
      className: "plane-icon",
      html: planeSvg(heading),
      iconSize: [96, 96],
      iconAnchor: [48, 48],
    });

    if (!planeMarker) {
      planeMarker = L.marker([lat, lon], { icon: icon, interactive: true }).addTo(m);
      if (reg) {
        planeMarker.bindTooltip(reg, {
          permanent: true,
          direction: "right",
          offset: [40, 0],
          className: "plane-label",
        });
      }
    } else if (key !== lastPosKey) {
      planeMarker.setLatLng([lat, lon]);
      planeMarker.setIcon(icon);
      if (reg) {
        planeMarker.bindTooltip(reg, {
          permanent: true,
          direction: "right",
          offset: [40, 0],
          className: "plane-label",
        });
      }
    }
    lastPosKey = key;

    try {
      const z = m.getZoom();
      if (z < 4 || z > 10) m.setView([lat, lon], 6, { animate: false });
      else m.panTo([lat, lon], { animate: true });
    } catch (e) {
      m.setView([lat, lon], 6);
    }
  }

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
    $("aircraft").textContent =
      [ac.registration, ac.code, ac.description].filter(Boolean).join(" · ") || "—";

    try {
      updateMap(d);
    } catch (mapErr) {
      console.error(mapErr);
      const seenEl = document.getElementById("mapSeen");
      if (seenEl) seenEl.textContent = "Map error: " + (mapErr && mapErr.message ? mapErr.message : mapErr);
    }

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

    paintLatestUpdate(d.updatedAt || null);
    try {
      $("updated").textContent =
        "Updated " +
        new Intl.DateTimeFormat("en-GB", {
          dateStyle: "medium",
          timeStyle: "short",
          timeZone: "Asia/Dubai",
        }).format(new Date(d.updatedAt)) +
        " GST · Auto-refresh 45s";
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
