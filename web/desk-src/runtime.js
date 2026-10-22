// Stands in for the claude.ai runtime the desks were written for, backed by this app's own API.
// db:   documents by path, read as the signed-in user (world data, and the user's own data/users/<id>/...)
// user: the signed-in user's opaque id; nobody is "owner" here, holdings arrive with broker connections
// Live quotes (mcp) and Ask Claude (sample) are not connected in this version, so they resolve null.
//
// Speed: world documents (shared, the same for everyone) are kept in memory and in the browser's Cache Storage, so a
// desk paints from the last copy at once and then revalidates with the document's ETag (a 304 costs no body).
// Changes arrive on one server-sent event stream (/api/stream) instead of polling: when the pipeline uploads, only
// the documents that changed are fetched again; when the user saves in another tab, that tab's documents refresh.
// Personal documents are never written to disk here.
(function () {
  "use strict";
  var CACHE = "mr-world-v1";
  var FALLBACK_POLL_MS = 5 * 60 * 1000;   // only when the event stream cannot connect

  function url(path) {
    return "/api/docs/" + String(path).split("/").map(encodeURIComponent).join("/");
  }
  function isOwn(path) { return /^data\/users\//.test(path); }
  function isWorld(path) { return !isOwn(path) && path !== "owner/portfolio"; }
  function bounce(status) {
    if (status === 401) location.assign("/login");
    else if (status === 403) location.assign("/mfa");
  }
  function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
  function snap(entry) {
    var data = entry && entry.exists ? entry.data : null;
    return { exists: !!(entry && entry.exists), data: function () { return clone(data); } };
  }

  // ------------------------------------------------------------------ world cache: memory, then Cache Storage
  var mem = Object.create(null);        // path -> {exists, data, etag}
  var inflight = Object.create(null);   // path -> Promise
  var listeners = Object.create(null);  // path -> Set of callbacks
  var ownVersion = Object.create(null); // key -> last version this tab knows

  function store() {
    try { return window.caches ? caches.open(CACHE) : Promise.resolve(null); } catch (_) { return Promise.resolve(null); }
  }
  function diskGet(path) {
    return store().then(function (c) { return c ? c.match(url(path)) : null; }).then(function (r) {
      return r ? r.json().then(function (j) { return { exists: !!j.exists, data: j.data, etag: r.headers.get("x-etag") }; }) : null;
    }).catch(function () { return null; });
  }
  function diskPut(path, e) {
    store().then(function (c) {
      if (!c) return;
      return c.put(url(path), new Response(JSON.stringify({ exists: e.exists, data: e.data }),
        { headers: { "content-type": "application/json", "x-etag": e.etag || "" } }));
    }).catch(function () {});
  }
  function diskDrop(path) { store().then(function (c) { return c && c.delete(url(path)); }).catch(function () {}); }

  function fetchDoc(path, etag) {
    var headers = {};
    if (etag) headers["if-none-match"] = etag;
    return fetch(url(path), { credentials: "same-origin", cache: "no-store", headers: headers }).then(function (r) {
      if (r.status === 401 || (r.status === 403 && !/^data\//.test(path))) { bounce(r.status); throw new Error("signed out"); }
      if (r.status === 304) return null;   // unchanged
      if (!r.ok) throw new Error("read failed " + r.status);
      return r.json().then(function (j) { return { exists: !!j.exists, data: j.exists ? j.data : null, etag: r.headers.get("etag"), version: j.version }; });
    });
  }

  function notify(path) {
    var set = listeners[path];
    if (!set) return;
    var s = snap(mem[path]);
    set.forEach(function (cb) { try { cb(s); } catch (_) {} });
  }

  // Fetches a fresh copy (with the ETag when there is one) and tells the listeners when it changed.
  function revalidate(path) {
    if (inflight[path]) return inflight[path];
    var have = mem[path];
    var p = fetchDoc(path, isWorld(path) && have ? have.etag : null).then(function (e) {
      delete inflight[path];
      if (!e) return have;   // 304
      var changed = !have || have.etag !== e.etag || !e.etag || JSON.stringify(have.data) !== JSON.stringify(e.data);
      mem[path] = e;
      if (isOwn(path) && e.version) ownVersion[path.split("/")[3]] = e.version;
      if (isWorld(path)) diskPut(path, e);
      if (changed) notify(path);
      return e;
    }, function (err) { delete inflight[path]; throw err; });
    inflight[path] = p;
    return p;
  }

  // The fastest copy available: memory, then disk (world only), else the network. A cached copy is returned at once
  // and revalidated behind it.
  function read(path) {
    if (mem[path]) {
      if (isWorld(path)) revalidate(path).catch(function () {});
      else return revalidate(path).then(snap);
      return Promise.resolve(snap(mem[path]));
    }
    if (!isWorld(path)) return revalidate(path).then(snap);
    return diskGet(path).then(function (d) {
      if (d && !mem[path]) {
        mem[path] = d;
        revalidate(path).catch(function () {});
        return snap(d);
      }
      return revalidate(path).then(snap);
    });
  }

  function write(path, data, merge) {
    return fetch(url(path), {
      method: "PUT", credentials: "same-origin",
      headers: { "content-type": "application/json", "x-ripple": "1" },
      body: JSON.stringify({ data: data, merge: !!merge }),
    }).then(function (r) {
      if (r.status === 401) bounce(401);
      if (!r.ok) throw new Error("write failed " + r.status);
      return r.json();
    }).then(function (j) {
      // remember the version so this tab ignores the stream's echo of its own save
      if (j && j.version) ownVersion[path.split("/")[3]] = j.version;
      delete mem[path];
      return j;
    });
  }

  function doc(path) {
    return {
      path: path,
      get: function () { return read(path); },
      set: function (data) { return write(path, data, false); },
      update: function (data) { return write(path, data, true); },
      onSnapshot: function (cb, onErr) {
        var stopped = false;
        var wrapped = function (s) { if (!stopped) cb(s); };
        (listeners[path] = listeners[path] || new Set()).add(wrapped);
        read(path).then(wrapped, function (e) { if (!stopped && onErr) onErr(e); });
        return function () { stopped = true; listeners[path] && listeners[path].delete(wrapped); };
      },
    };
  }
  var db = Object.freeze({ doc: doc, collection: function (c) { return { doc: function (k) { return doc(c + "/" + k); } }; } });

  // ------------------------------------------------------------------ the event stream
  var es = null, cursor = "", pollTimer = null, failures = 0, live = "connecting";
  function setLive(s) {
    live = s;
    document.documentElement.dataset.live = s;
    window.dispatchEvent(new CustomEvent("mr-live", { detail: s }));
  }
  function onWorld(paths) {
    var names = [];
    paths.forEach(function (p) {
      if (listeners[p] && listeners[p].size) { revalidate(p).catch(function () {}); names.push(p.split("/")[0]); }
      else { delete mem[p]; diskDrop(p); }
    });
    if (names.length) toast("Updated " + Array.from(new Set(names)).slice(0, 4).join(", "));
  }
  function onOwn(d) {
    if (!d || ownVersion[d.key] === d.v) return;
    ownVersion[d.key] = d.v;
    Object.keys(listeners).forEach(function (p) {
      if (isOwn(p) && p.split("/")[3] === d.key && listeners[p].size) revalidate(p).catch(function () {});
    });
  }
  function connect() {
    if (es || !window.EventSource) { if (!window.EventSource) startPolling(); return; }
    es = new EventSource("/api/stream" + (cursor ? "?from=" + encodeURIComponent(cursor) : ""));
    es.addEventListener("ready", function (e) { failures = 0; cursor = e.lastEventId || cursor; stopPolling(); setLive("live"); });
    es.addEventListener("world", function (e) { cursor = e.lastEventId || cursor; try { onWorld(JSON.parse(e.data).paths || []); } catch (_) {} });
    es.addEventListener("own", function (e) { cursor = e.lastEventId || cursor; try { onOwn(JSON.parse(e.data)); } catch (_) {} });
    es.onerror = function () {
      // the server closes each connection after a while and the browser reconnects; only repeated failures count
      failures += 1;
      if (es && es.readyState === 2) { es = null; setTimeout(connect, Math.min(30000, 1000 * failures)); }
      if (failures >= 3) { setLive("offline"); startPolling(); }
      else setLive("connecting");
    };
  }
  function disconnect() { if (es) { es.close(); es = null; } }
  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(function () {
      Object.keys(listeners).forEach(function (p) { if (isWorld(p) && listeners[p].size) revalidate(p).catch(function () {}); });
    }, FALLBACK_POLL_MS);
  }
  function stopPolling() { clearInterval(pollTimer); pollTimer = null; }

  // a hidden tab lets its connection go; coming back reconnects from where it left off (no event is missed)
  var hideTimer = null;
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) hideTimer = setTimeout(function () { disconnect(); setLive("paused"); }, 60000);
    else { clearTimeout(hideTimer); connect(); }
  });
  connect();

  var meP = fetch("/api/me", { credentials: "same-origin" }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  var user = Object.freeze({
    // "owner" means: this user has a portfolio report from their connected platforms
    isOwner: function () { return read("owner/portfolio").then(function (s) { return s.exists; }, function () { return false; }); },
    canEdit: function () { return Promise.resolve(false); },
    can: function () { return Promise.resolve(false); },
    id: function () { return meP.then(function (j) { return j ? j.id : null; }); },
    me: function () { return meP.then(function (j) { return { id: j ? j.id : null, name: j ? j.name : "" }; }); },
    profiles: function () { return Promise.resolve({}); },
  });

  window.claude = Object.freeze({
    use: function (name) {
      return Promise.resolve(name === "db" ? db : name === "user" ? user : null);
    },
  });

  // ------------------------------------------------------------------ top bar: home, live status, theme, sign out
  function toast(text) {
    var t = document.getElementById("mrToast");
    if (!t) { t = document.createElement("div"); t.id = "mrToast"; t.className = "mr-toast"; t.setAttribute("role", "status"); document.body.appendChild(t); }
    t.textContent = text;
    t.classList.add("on");
    clearTimeout(toast.t);
    toast.t = setTimeout(function () { t.classList.remove("on"); }, 2600);
  }
  var LIVE_TEXT = { live: "Live", connecting: "Connecting", paused: "Paused", offline: "Offline: checking every 5 min" };

  function signOut() {
    disconnect();
    try { caches.delete(CACHE); } catch (_) {}
    fetch("/auth/signout", { method: "POST", headers: { "x-ripple": "1" }, credentials: "same-origin" })
      .finally(function () { location.assign("/login"); });
  }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; }
  function links(cls) {
    var wrap = el("div", cls);
    var home = el("a", "btn quiet", "Home"); home.href = "/";
    var out = el("button", "btn quiet", "Sign out"); out.type = "button"; out.addEventListener("click", signOut);
    wrap.appendChild(home); wrap.appendChild(out);
    return wrap;
  }

  // top bar: live status and the theme switch (plus Home and Sign out on phones, where the rail is hidden);
  // rail: Home and Sign out under the desk list
  document.addEventListener("DOMContentLoaded", function () {
    var bar = document.querySelector(".topbar");
    if (bar) {
      var tools = el("span", "mr-tools");
      var dot = el("span", "mr-live"); dot.setAttribute("role", "status");
      var paint = function () { dot.dataset.state = live; dot.title = "Updates: " + LIVE_TEXT[live]; dot.textContent = LIVE_TEXT[live].split(":")[0]; };
      paint();
      window.addEventListener("mr-live", paint);
      tools.appendChild(dot);
      if (window.MRTheme) tools.appendChild(window.MRTheme.control());
      tools.appendChild(links("mr-links mr-phone"));
      var player = bar.querySelector(".player");
      bar.insertBefore(tools, player || null);
    }
    var foot = document.querySelector(".rail-foot");
    if (foot) foot.parentNode.insertBefore(links("mr-links mr-rail"), foot);
  });
})();
