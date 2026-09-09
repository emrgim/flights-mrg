(function () {
  const STATUS_URL = './status.json';
  const REFRESH_MS = 60000;

  const $ = (id) => document.getElementById(id);

  function fmtTime(iso, timeZone) {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return '—';
      return new Intl.DateTimeFormat(undefined, {
        timeZone: timeZone || undefined,
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(d);
    } catch {
      return iso;
    }
  }

  function fmtUpdated(iso) {
    if (!iso) return '—';
    try {
      return new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(iso));
    } catch {
      return iso;
    }
  }

  function terminalGate(terminal, gate) {
    const t = terminal ? `T${String(terminal).replace(/^T/i, '')}` : null;
    const g = gate ? `Gate ${gate}` : null;
    if (t && g) return `${t} · ${g}`;
    return t || g || '—';
  }

  function render(data) {
    const available = data && data.available !== false && data.statusCode !== 'unavailable';
    const statusEl = $('status');
    const code = (data && data.statusCode) || 'unavailable';

    statusEl.className = 'status-value ' + (available ? code : 'unavailable');
    statusEl.textContent =
      available || (data && data.status)
        ? data.status || 'Status unavailable'
        : 'Status unavailable';

    const sub = [];
    if (data?.aircraft) sub.push(data.aircraft);
    if (data?.delayMinutes != null && data.delayMinutes > 0) {
      sub.push(`${data.delayMinutes} min delay`);
    }
    if (!available && data?.error) sub.push('Live feed offline');
    if (data?.caution) sub.push(data.caution);
    else if (data?.statusDetail) sub.push(data.statusDetail);
    $('statusSub').textContent = sub.join(' · ');

    if (data?.route?.label) $('route').textContent = data.route.label;
    else $('route').textContent = 'LHR → DXB';

    const dep = data?.departure || {};
    const arr = data?.arrival || {};

    $('depCode').textContent = dep.airport || 'LHR';
    $('depName').textContent = dep.name || 'London Heathrow';
    $('depSched').textContent = fmtTime(dep.scheduled, dep.timezone);
    $('depEst').textContent = fmtTime(dep.estimated, dep.timezone);
    $('depAct').textContent = fmtTime(dep.actual, dep.timezone);
    $('depTG').textContent = terminalGate(dep.terminal, dep.gate);

    $('arrCode').textContent = arr.airport || 'DXB';
    $('arrName').textContent = arr.name || 'Dubai International';
    $('arrSched').textContent = fmtTime(arr.scheduled, arr.timezone);
    $('arrEst').textContent = fmtTime(arr.estimated, arr.timezone);
    $('arrAct').textContent = fmtTime(arr.actual, arr.timezone);
    $('arrTG').textContent = terminalGate(arr.terminal, arr.gate);

    $('meta').textContent =
      'Updated ' + fmtUpdated(data?.updatedAt) + ' · Auto-refresh 60s';

    const list = $('newsList');
    list.innerHTML = '';
    const news = data?.news || [];
    if (!news.length) {
      const li = document.createElement('li');
      li.className = 'muted';
      li.textContent = 'No recent traffic headlines right now.';
      list.appendChild(li);
    } else {
      for (const n of news) {
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.href = n.url || '#';
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = n.title || 'Untitled';
        li.appendChild(a);
        const meta = document.createElement('span');
        meta.className = 'news-meta';
        meta.textContent = n.source || 'News';
        li.appendChild(meta);
        if (n.summary) {
          const p = document.createElement('p');
          p.className = 'news-sum';
          p.textContent = n.summary;
          li.appendChild(p);
        }
        list.appendChild(li);
      }
    }

    const sources = (data?.sources || [])
      .filter((s) => s && s.name)
      .map((s) => (s.url ? `<a href="${s.url}" target="_blank" rel="noopener">${s.name}</a>` : s.name));
    $('sources').innerHTML = sources.length
      ? 'Sources: ' + sources.join(' · ')
      : '';
  }

  async function load() {
    try {
      const res = await fetch(STATUS_URL + '?t=' + Date.now(), {
        cache: 'no-store',
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      render(data);
    } catch (e) {
      render({
        status: 'Status unavailable',
        statusCode: 'unavailable',
        available: false,
        error: String(e.message || e),
        updatedAt: null,
        news: [],
        sources: [],
      });
    }
  }

  load();
  setInterval(load, REFRESH_MS);
})();
