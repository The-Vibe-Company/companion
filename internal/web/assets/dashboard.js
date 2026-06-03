(function () {
  "use strict";

  var body = document.body;
  var serverInterval = parseInt(body.getAttribute("data-interval"), 10) || 30;
  // Poll the API a touch faster than the server's own refresh, but never
  // hammer it: clamp between 5s and the server interval.
  var pollMs = Math.max(5, Math.min(serverInterval, 15)) * 1000;

  var els = {
    workspace: document.getElementById("workspace-name"),
    connPill: document.getElementById("conn-pill"),
    connText: document.getElementById("conn-text"),
    total: document.getElementById("stat-total"),
    healthy: document.getElementById("stat-healthy"),
    degraded: document.getElementById("stat-degraded"),
    down: document.getElementById("stat-down"),
    body: document.getElementById("services-body"),
    updated: document.getElementById("updated"),
    driftBadge: document.getElementById("drift-badge"),
    driftText: document.getElementById("drift-text"),
    refreshNote: document.getElementById("refresh-note"),
  };

  els.refreshNote.textContent = "auto-refresh " + Math.round(pollMs / 1000) + "s";

  function esc(value) {
    var div = document.createElement("div");
    div.textContent = value == null ? "" : String(value);
    return div.innerHTML;
  }

  function healthClass(health) {
    switch (health) {
      case "ok": return "dot--ok";
      case "degraded": return "dot--degraded";
      case "down": return "dot--down";
      default: return "dot--unknown";
    }
  }

  function machineCell(state) {
    if (!state) return '<span class="state">—</span>';
    var cls = state === "started" ? "state--started" : state === "stopped" ? "state--stopped" : "";
    return '<span class="state ' + cls + '">' + esc(state) + "</span>";
  }

  function httpCell(svc) {
    if (!svc.http_status) {
      return '<span class="http http--none">—</span>';
    }
    var ok = svc.http_status >= 200 && svc.http_status < 300;
    return '<span class="http ' + (ok ? "http--ok" : "http--bad") + '">' + esc(svc.http_status) + "</span>";
  }

  function row(svc) {
    var online = svc.online
      ? '<span class="tag tag--up">online</span>'
      : '<span class="tag tag--off">—</span>';
    var host = svc.host ? '<span class="svc-host">' + esc(svc.host) + "</span>" : '<span class="svc-host">—</span>';
    var model = svc.model ? '<span class="svc-model">' + esc(svc.model) + "</span>" : '<span class="svc-model">—</span>';
    var title = svc.error ? ' title="' + esc(svc.error) + '"' : "";
    var health = svc.health || "unknown";
    return (
      "<tr" + title + ">" +
      '<td><span class="dot ' + healthClass(svc.health) + '" role="img" aria-label="' + esc(health) + '"></span></td>' +
      '<td><span class="svc-id">' + esc(svc.id) + "</span></td>" +
      '<td><span class="kind">' + esc(svc.kind) + "</span></td>" +
      "<td>" + host + "</td>" +
      "<td>" + machineCell(svc.machine_state) + "</td>" +
      '<td class="col-center">' + online + "</td>" +
      "<td>" + model + "</td>" +
      '<td class="col-center">' + httpCell(svc) + "</td>" +
      "</tr>"
    );
  }

  function render(data) {
    var ws = data.workspace || body.getAttribute("data-workspace") || "";
    els.workspace.textContent = ws ? ws : "";

    var s = data.summary || {};
    els.total.textContent = s.total != null ? s.total : 0;
    els.healthy.textContent = s.healthy != null ? s.healthy : 0;
    els.degraded.textContent = s.degraded != null ? s.degraded : 0;
    els.down.textContent = s.down != null ? s.down : 0;

    var services = data.services || [];
    if (services.length === 0) {
      els.body.innerHTML = '<tr class="empty"><td colspan="8">No services in this fleet yet.</td></tr>';
    } else {
      els.body.innerHTML = services.map(row).join("");
    }

    if (data.generated_at) {
      var when = new Date(data.generated_at);
      els.updated.textContent = "updated " + when.toLocaleTimeString();
    }

    var count = data.drift_count || 0;
    if (count > 0) {
      els.driftBadge.textContent = count + (count === 1 ? " issue" : " issues");
      els.driftBadge.className = "badge badge--drift";
    } else {
      els.driftBadge.textContent = "clean";
      els.driftBadge.className = "badge badge--clean";
    }
    els.driftText.textContent = data.drift_text && data.drift_text.trim() ? data.drift_text : "= no-op";

    els.connPill.className = "pill live";
    els.connText.textContent = "live";
  }

  function markStale() {
    els.connPill.className = "pill stale";
    els.connText.textContent = "stale";
  }

  function poll() {
    fetch("/api/status", { headers: { Accept: "application/json" }, cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("status " + r.status);
        return r.json();
      })
      .then(render)
      .catch(markStale);
  }

  poll();
  setInterval(poll, pollMs);
})();
