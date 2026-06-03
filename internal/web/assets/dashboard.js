/* Companion fleet dashboard — Variant A.
   Vanilla JS. Polls /api/status, renders a dense agent list, opens a
   client-side slide-over drawer per row. XSS-safe: every value reaches the
   DOM via textContent or is escaped; no innerHTML interpolation of data. */
(function () {
  "use strict";

  var body = document.body;
  var serverInterval = parseInt(body.getAttribute("data-interval"), 10) || 30;
  // Poll a little ahead of the server refresh, but clamp 5..15s.
  var pollMs = Math.max(5, Math.min(serverInterval, 15)) * 1000;
  var workspaceAttr = body.getAttribute("data-workspace") || "";

  var els = {
    workspace: document.getElementById("workspace-name"),
    connPill: document.getElementById("conn-pill"),
    connText: document.getElementById("conn-text"),
    updated: document.getElementById("updated"),
    refreshNote: document.getElementById("refresh-note"),
    listBody: document.getElementById("services-body"),
    countAll: document.getElementById("count-all"),
    countHealthy: document.getElementById("count-healthy"),
    countDegraded: document.getElementById("count-degraded"),
    countDown: document.getElementById("count-down"),
    filterStatus: document.getElementById("filter-status"),
    driftToggle: document.getElementById("drift-toggle"),
    driftPanel: document.getElementById("drift-panel"),
    driftBadge: document.getElementById("drift-badge"),
    scrim: document.getElementById("scrim"),
    drawer: document.getElementById("drawer"),
    drawerTitle: document.getElementById("drawer-title"),
    drawerPill: document.getElementById("drawer-pill"),
    drawerPillText: document.getElementById("drawer-pill-text"),
    drawerBody: document.getElementById("drawer-body"),
    drawerFoot: document.getElementById("drawer-foot"),
    drawerClose: document.getElementById("drawer-close"),
  };

  els.workspace.textContent = workspaceAttr;
  els.refreshNote.textContent = "auto-refresh " + Math.round(pollMs / 1000) + "s";

  var state = {
    services: [],
    filter: "all",
    selectedId: null,
    lastFocused: null,
    open: false,
    hadFirstPoll: false,   // true once any poll has succeeded
    lastGeneratedAt: 0,    // epoch ms of the latest payload's generated_at
  };

  // A successful-but-old payload is still stale: if the newest data we hold is
  // older than ~2x the poll interval, the control plane is reachable but
  // frozen. Floor at 30s so a slow tailnet does not flap the pill.
  var staleAfterMs = Math.max(pollMs * 2, 30000);
  var staleTimer = null;

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---- helpers ----------------------------------------------------------

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function healthOf(svc) {
    var h = svc && svc.health;
    return h === "ok" || h === "degraded" || h === "down" ? h : "unknown";
  }

  var STATUS_LABEL = { ok: "Healthy", degraded: "Degraded", down: "Down", unknown: "Unknown" };

  // Only http(s) URLs are safe to turn into a clickable href. A topology with a
  // "javascript:" or "data:" url would otherwise become a script-executing
  // link. Returns the trimmed url when it is openable, else "".
  function httpUrl(value) {
    if (typeof value !== "string") return "";
    var v = value.trim();
    return /^https?:\/\//i.test(v) ? v : "";
  }

  // Two stacked SVGs — clipboard (default) + checkmark (copied). The success
  // state swaps the glyph via .is-copied, so confirmation is not color-only.
  function copyIcons() {
    // Static markup only; no value interpolation, so innerHTML is XSS-safe.
    return (
      '<svg class="clip" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">' +
      '<rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.5" stroke="currentColor" stroke-width="1.3"/>' +
      '<path d="M3 10.5V4A1.5 1.5 0 0 1 4.5 2.5H10" stroke="currentColor" stroke-width="1.3"/>' +
      "</svg>" +
      '<svg class="check" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">' +
      '<path d="M3.5 8.5l3 3 6-6.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
      "</svg>"
    );
  }

  function makeCopyButton(value, label) {
    var btn = el("button", "copy");
    btn.type = "button";
    btn.setAttribute("aria-label", label || "Copy URL");
    btn.innerHTML = copyIcons();
    btn.addEventListener("click", function (ev) {
      ev.stopPropagation();
      doCopy(value, btn);
    });
    return btn;
  }

  function doCopy(value, btn) {
    var prevLabel = btn.getAttribute("aria-label") || "Copy URL";
    var done = function () {
      btn.classList.add("is-copied");
      btn.setAttribute("aria-label", "Copied");
      setTimeout(function () {
        btn.classList.remove("is-copied");
        btn.setAttribute("aria-label", prevLabel);
      }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(done, function () { fallbackCopy(value, done); });
    } else {
      fallbackCopy(value, done);
    }
  }

  function fallbackCopy(value, done) {
    var ta = document.createElement("textarea");
    ta.value = value;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); done(); } catch (e) { /* ignore */ }
    document.body.removeChild(ta);
  }

  // ---- row construction --------------------------------------------------

  function buildRow(svc) {
    var health = healthOf(svc);
    // The row is a div with role="button", not a <button> element: it contains
    // the copy <button>, and a button cannot legally nest another button.
    // tabindex + a keydown handler keep it keyboard-operable.
    var btn = el("div", "row");
    btn.setAttribute("role", "button");
    btn.tabIndex = 0;
    btn.dataset.id = svc.id || "";
    btn.dataset.health = health;
    if (svc.id === state.selectedId) btn.classList.add("is-selected");
    // Accessible name carries id, health, and tailnet presence ("online"/
    // "offline") so screen-reader users hear reachability without the dot.
    btn.setAttribute(
      "aria-label",
      (svc.id || "service") + ", " + STATUS_LABEL[health] + ", " + (svc.online ? "online" : "offline")
    );

    // status
    var status = el("span", "cell-status");
    status.appendChild(el("span", "dot dot--" + health));
    status.appendChild(el("span", "status-label", STATUS_LABEL[health]));
    btn.appendChild(status);

    // name + kind
    var name = el("span", "cell-name");
    name.appendChild(el("span", "svc-id", svc.id || "—"));
    name.appendChild(el("span", "svc-kind", svc.kind || ""));
    btn.appendChild(name);

    // url + copy
    var urlCell = el("span", "cell-url");
    if (svc.url) {
      urlCell.appendChild(el("span", "svc-url", svc.url));
      urlCell.appendChild(makeCopyButton(svc.url, "Copy URL for " + (svc.id || "service")));
    } else {
      urlCell.appendChild(el("span", "svc-url svc-url--none", "—"));
    }
    btn.appendChild(urlCell);

    // tailnet
    var net = el("span", "cell-net");
    if (svc.online) net.appendChild(el("span", "tag tag--online", "online"));
    else net.appendChild(el("span", "tag tag--offline", "offline"));
    btn.appendChild(net);

    // machine
    var machine = el("span", "cell-machine");
    machine.appendChild(machineNode(svc.machine_state));
    btn.appendChild(machine);

    // http
    var http = el("span", "cell-http");
    http.appendChild(httpNode(svc.http_status));
    btn.appendChild(http);

    // model
    var model = el("span", "cell-model");
    if (svc.model) model.appendChild(el("span", "svc-model", svc.model));
    else model.appendChild(el("span", "svc-model muted", "—"));
    btn.appendChild(model);

    btn.addEventListener("click", function () { openDrawer(svc, btn); });
    btn.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" || ev.key === " " || ev.key === "Spacebar") {
        ev.preventDefault();
        openDrawer(svc, btn);
      }
    });
    return btn;
  }

  function machineNode(stateVal) {
    if (!stateVal) return el("span", "state-text muted", "—");
    var cls = stateVal === "started" ? "state-text--started" : stateVal === "stopped" ? "state-text--stopped" : "";
    return el("span", "state-text " + cls, stateVal);
  }

  function httpNode(code) {
    if (!code) return el("span", "http http--none", "—");
    var ok = code >= 200 && code < 300;
    return el("span", "http " + (ok ? "http--ok" : "http--bad"), String(code));
  }

  // ---- render ------------------------------------------------------------

  function applyFilter(svc) {
    if (state.filter === "all") return true;
    return healthOf(svc) === state.filter;
  }

  // Problems-first ordering: a DOWN agent surfaces at the top of the single
  // flat list at a glance (the brief's core scene). Secondary sort is a
  // stable pass on the incoming order so equal-health rows keep their order.
  var HEALTH_RANK = { down: 0, degraded: 1, unknown: 2, ok: 3 };

  function sortProblemsFirst(list) {
    return list
      .map(function (svc, i) { return { svc: svc, i: i }; })
      .sort(function (a, b) {
        var ra = HEALTH_RANK[healthOf(a.svc)];
        var rb = HEALTH_RANK[healthOf(b.svc)];
        if (ra !== rb) return ra - rb;
        return a.i - b.i; // stable secondary sort
      })
      .map(function (w) { return w.svc; });
  }

  function renderList() {
    var bodyEl = els.listBody;
    bodyEl.textContent = "";

    // Empty state — distinct from the loading skeleton. Only reached once a
    // poll has succeeded with zero services (the skeleton is replaced here,
    // never stacked, because textContent above clears the node first).
    if (!state.services.length) {
      var empty = el("div", "state state--empty");
      empty.appendChild(el("p", "state__text", "No services in this fleet yet."));
      bodyEl.appendChild(empty);
      return;
    }

    var shown = sortProblemsFirst(state.services.filter(applyFilter));
    if (!shown.length) {
      var none = el("div", "state state--empty");
      none.appendChild(el("p", "state__text", "No " + (STATUS_LABEL[state.filter] || "matching").toLowerCase() + " services."));
      bodyEl.appendChild(none);
      return;
    }

    var frag = document.createDocumentFragment();
    shown.forEach(function (svc) { frag.appendChild(buildRow(svc)); });
    bodyEl.appendChild(frag);
  }

  function renderCounts() {
    // Count by exact health so each chip equals the rows its filter shows. The
    // server summary folds "unknown" into "degraded", which would make the
    // Degraded chip disagree with the Degraded filter (and skew "All" never).
    els.countAll.textContent = state.services.length;
    els.countHealthy.textContent = countBy("ok");
    els.countDegraded.textContent = countBy("degraded");
    els.countDown.textContent = countBy("down");
  }

  function countBy(h) {
    return state.services.reduce(function (n, svc) { return n + (healthOf(svc) === h ? 1 : 0); }, 0);
  }

  function renderDrift(data) {
    var count = data.drift_count || 0;
    if (count > 0) {
      els.driftBadge.textContent = count + (count === 1 ? " issue" : " issues");
      els.driftBadge.className = "drift__badge is-drift";
    } else {
      els.driftBadge.textContent = "clean";
      els.driftBadge.className = "drift__badge";
    }
    var text = data.drift_text && data.drift_text.trim() ? data.drift_text : "No drift. Fleet matches plan.";
    els.driftPanel.textContent = text;
  }

  function render(data) {
    state.hadFirstPoll = true;
    state.services = Array.isArray(data.services) ? data.services : [];
    var ws = data.workspace || workspaceAttr;
    if (ws) els.workspace.textContent = ws;

    renderCounts();
    renderList();
    announceFilter();
    renderDrift(data);

    var genMs = 0;
    if (data.generated_at) {
      var when = new Date(data.generated_at);
      if (!isNaN(when.getTime())) {
        genMs = when.getTime();
        els.updated.textContent = "updated " + when.toLocaleTimeString();
      }
    }
    // Fall back to receipt time if the payload carries no usable timestamp,
    // so the staleness clock still advances.
    state.lastGeneratedAt = genMs || Date.now();

    // If a drawer is open, refresh its contents from the latest data.
    if (state.open && state.selectedId) {
      var fresh = state.services.filter(function (s) { return s.id === state.selectedId; })[0];
      if (fresh) fillDrawer(fresh);
    }

    setConn(true);
    scheduleStaleCheck();
  }

  function setConn(live) {
    if (live) {
      els.connPill.className = "conn is-live";
      els.connText.textContent = "live";
    } else {
      els.connPill.className = "conn is-stale";
      els.connText.textContent = "stale";
    }
  }

  // Mark the pill stale once the freshest payload we hold ages past
  // staleAfterMs, even if the control plane stays reachable (frozen state).
  function scheduleStaleCheck() {
    if (staleTimer) clearTimeout(staleTimer);
    staleTimer = setTimeout(function () {
      if (Date.now() - state.lastGeneratedAt >= staleAfterMs) setConn(false);
    }, staleAfterMs + 250);
  }

  // ---- drawer ------------------------------------------------------------

  function dlRow(key, valNode) {
    var row = el("div", "dl__row");
    row.appendChild(el("dt", "dl__key", key));
    var dd = el("dd", "dl__val");
    if (typeof valNode === "string" || valNode == null) {
      dd.textContent = valNode == null || valNode === "" ? "—" : valNode;
      if (valNode == null || valNode === "") dd.classList.add("muted");
    } else {
      dd.appendChild(valNode);
    }
    row.appendChild(dd);
    return row;
  }

  function monoVal(value) {
    if (!value) { var m = el("span", "muted", "—"); return m; }
    return el("span", "dl__val--mono", value);
  }

  function fillDrawer(svc) {
    var health = healthOf(svc);
    els.drawerTitle.textContent = svc.id || "Service";
    els.drawerPill.className = "status-pill status-pill--" + health;
    els.drawerPillText.textContent = STATUS_LABEL[health];

    // body
    els.drawerBody.textContent = "";
    var dl = el("dl", "dl");

    // URL row: link + copy. Only http(s) urls become a clickable link; a
    // non-openable url is shown as plain text (still copyable). No url => muted.
    var urlNode;
    var safeUrl = httpUrl(svc.url);
    if (safeUrl) {
      urlNode = el("span", "dl__url");
      var link = el("a", "dl__link", safeUrl);
      link.href = safeUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      urlNode.appendChild(link);
      urlNode.appendChild(makeCopyButton(safeUrl, "Copy URL"));
    } else if (svc.url) {
      urlNode = el("span", "dl__url");
      urlNode.appendChild(el("span", "dl__val--mono", svc.url));
      urlNode.appendChild(makeCopyButton(svc.url, "Copy URL"));
    } else {
      urlNode = el("span", "muted", "—");
    }
    // Field order matches the brief exactly: URL, host, fly_app,
    // machine_state, tailnet, model, vault, http_status, health. Kind is not
    // in the brief's list, so it trails after Health rather than sitting
    // second. Missing values render an em-dash, never "undefined".
    dl.appendChild(dlRow("URL", urlNode));
    dl.appendChild(dlRow("Host", monoVal(svc.host)));
    dl.appendChild(dlRow("Fly app", monoVal(svc.fly_app)));
    dl.appendChild(dlRow("Machine", machineNode(svc.machine_state)));
    dl.appendChild(dlRow("Tailnet", svc.online ? "online" : "offline"));
    dl.appendChild(dlRow("Model", monoVal(svc.model)));
    dl.appendChild(dlRow("Vault", monoVal(svc.vault)));
    dl.appendChild(dlRow("HTTP", httpNode(svc.http_status)));
    dl.appendChild(dlRow("Health", STATUS_LABEL[health]));
    dl.appendChild(dlRow("Kind", svc.kind || "—"));
    els.drawerBody.appendChild(dl);

    if (svc.error) {
      var block = el("div", "error-block");
      block.appendChild(el("div", "error-block__label", "Probe error"));
      block.appendChild(el("div", "error-block__text", svc.error));
      els.drawerBody.appendChild(block);
    }

    // footer: only offer "Open" for an http(s) url.
    els.drawerFoot.textContent = "";
    if (safeUrl) {
      var open = el("a", "btn-primary");
      // Inline external-link glyph (arrow out of box) reads as "open in new
      // tab". Static markup only — the label is appended via textContent.
      open.innerHTML =
        '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">' +
        '<path d="M6 3.5h6.5V10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>' +
        '<path d="M12 4 4 12" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>' +
        "</svg>";
      open.appendChild(document.createTextNode("Open service"));
      open.href = safeUrl;
      open.target = "_blank";
      open.rel = "noopener noreferrer";
      els.drawerFoot.appendChild(open);
    } else {
      var disabled = el("span", "btn-primary", "No URL to open");
      disabled.setAttribute("aria-disabled", "true");
      els.drawerFoot.appendChild(disabled);
    }
  }

  function focusable() {
    return Array.prototype.slice.call(
      els.drawer.querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')
    ).filter(function (n) { return n.offsetParent !== null || n === document.activeElement; });
  }

  function openDrawer(svc, originRow) {
    state.selectedId = svc.id;
    state.lastFocused = originRow || document.activeElement;
    state.open = true;

    // selection highlight
    var rows = els.listBody.querySelectorAll(".row");
    Array.prototype.forEach.call(rows, function (r) {
      r.classList.toggle("is-selected", r.dataset.id === svc.id);
    });

    fillDrawer(svc);

    els.scrim.hidden = false;
    els.drawer.hidden = false;
    // force reflow so the transform transition runs
    void els.drawer.offsetWidth;
    els.scrim.classList.add("is-open");
    els.drawer.classList.add("is-open");
    document.body.style.overflow = "hidden";

    var target = els.drawerClose;
    if (reduceMotion) {
      target.focus();
    } else {
      setTimeout(function () { target.focus(); }, 60);
    }
  }

  function closeDrawer() {
    if (!state.open) return;
    state.open = false;
    els.scrim.classList.remove("is-open");
    els.drawer.classList.remove("is-open");
    document.body.style.overflow = "";

    var finish = function () {
      els.drawer.hidden = true;
      els.scrim.hidden = true;
    };
    if (reduceMotion) finish();
    else setTimeout(finish, 200);

    var rows = els.listBody.querySelectorAll(".row.is-selected");
    Array.prototype.forEach.call(rows, function (r) { r.classList.remove("is-selected"); });

    // Return focus to the originating row. A poll may have rebuilt the list
    // while the drawer was open, so the original node can be detached; fall
    // back to the row with the same id, then to the list itself.
    var prev = state.lastFocused;
    var prevId = state.selectedId;
    state.selectedId = null;
    state.lastFocused = null;
    if (prev && document.contains(prev) && typeof prev.focus === "function") {
      prev.focus();
    } else if (prevId) {
      var rebuilt = els.listBody.querySelector('.row[data-id="' + (window.CSS && CSS.escape ? CSS.escape(prevId) : prevId) + '"]');
      if (rebuilt) rebuilt.focus();
    }
  }

  function onKeydown(ev) {
    if (!state.open) return;
    if (ev.key === "Escape") { ev.preventDefault(); closeDrawer(); return; }
    if (ev.key === "Tab") {
      var items = focusable();
      if (!items.length) { ev.preventDefault(); return; }
      var first = items[0], last = items[items.length - 1];
      if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
      else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
      else if (!els.drawer.contains(document.activeElement)) { ev.preventDefault(); first.focus(); }
    }
  }

  els.drawerClose.addEventListener("click", closeDrawer);
  els.scrim.addEventListener("click", closeDrawer);
  document.addEventListener("keydown", onKeydown);

  // ---- filters -----------------------------------------------------------

  // These four filters are mutually exclusive, so they are a single-select
  // radiogroup (role=radio + aria-checked), not four ambiguous toggles. The
  // active filter and its result count are also announced via a live region.
  function announceFilter() {
    if (!els.filterStatus) return;
    var shown = state.services.filter(applyFilter).length;
    var label = STATUS_LABEL[state.filter];
    var name = state.filter === "all" ? "all" : (label ? label.toLowerCase() : state.filter);
    els.filterStatus.textContent =
      "Showing " + shown + " " + name + (shown === 1 ? " service" : " services");
  }

  var segs = Array.prototype.slice.call(document.querySelectorAll(".seg"));

  // Select a filter and update the radiogroup state. Roving tabindex: only the
  // checked radio is in the tab order (tabindex 0); the rest are -1 and reached
  // with arrow keys, per the WAI-ARIA radiogroup pattern.
  function selectFilter(seg, focusIt) {
    state.filter = seg.dataset.filter || "all";
    segs.forEach(function (s) {
      var active = s === seg;
      s.classList.toggle("is-active", active);
      s.setAttribute("aria-checked", active ? "true" : "false");
      s.tabIndex = active ? 0 : -1;
    });
    if (focusIt) seg.focus();
    renderList();
    announceFilter();
  }

  segs.forEach(function (seg, i) {
    seg.tabIndex = seg.classList.contains("is-active") ? 0 : -1;
    seg.addEventListener("click", function () { selectFilter(seg, false); });
    seg.addEventListener("keydown", function (ev) {
      var next = null;
      if (ev.key === "ArrowRight" || ev.key === "ArrowDown") next = segs[(i + 1) % segs.length];
      else if (ev.key === "ArrowLeft" || ev.key === "ArrowUp") next = segs[(i - 1 + segs.length) % segs.length];
      else if (ev.key === "Home") next = segs[0];
      else if (ev.key === "End") next = segs[segs.length - 1];
      if (next) { ev.preventDefault(); selectFilter(next, true); }
    });
  });

  // ---- drift toggle ------------------------------------------------------

  els.driftToggle.addEventListener("click", function () {
    var expanded = els.driftToggle.getAttribute("aria-expanded") === "true";
    els.driftToggle.setAttribute("aria-expanded", expanded ? "false" : "true");
    els.driftPanel.hidden = expanded;
  });

  // ---- polling -----------------------------------------------------------

  function poll() {
    fetch("/api/status", { headers: { Accept: "application/json" }, cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("status " + r.status);
        return r.json();
      })
      .then(render)
      .catch(function () {
        // Reachability failed: mark stale. On a failed FIRST poll we leave the
        // loading skeleton ("Waiting for first poll") in place — it is never
        // replaced by the empty state until a poll has actually succeeded.
        setConn(false);
      });
  }

  poll();
  setInterval(poll, pollMs);
})();
