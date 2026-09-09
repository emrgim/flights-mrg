(function () {
  const STATUS_URL = "./status.json";
  const REFRESH_MS = 60000;
  const $ = (id) => document.getElementById(id);

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
