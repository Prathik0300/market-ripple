// Stands in for the claude.ai runtime the desks were written for, backed by this app's own API.
// db:   documents by path, read as the signed-in user (world data, and the user's own data/users/<id>/...)
// user: the signed-in user's opaque id; nobody is "owner" here, holdings arrive with broker connections
// Live quotes (mcp) and Ask Claude (sample) are not connected in this version, so they resolve null.
(function () {
  "use strict";
  var WORLD_REFRESH_MS = 5 * 60 * 1000;

  function url(path) {
    return "/api/docs/" + String(path).split("/").map(encodeURIComponent).join("/");
  }
  function bounce(status) {
    if (status === 401) location.assign("/login");
    else if (status === 403) location.assign("/mfa");
  }
  function read(path) {
    return fetch(url(path), { credentials: "same-origin", cache: "no-store" }).then(function (r) {
      if (r.status === 401 || (r.status === 403 && !/^data\//.test(path))) { bounce(r.status); throw new Error("signed out"); }
      if (!r.ok) throw new Error("read failed " + r.status);
      return r.json();
    }).then(function (j) {
      var data = j.exists ? j.data : null;
      return { exists: !!j.exists, data: function () { return data == null ? data : JSON.parse(JSON.stringify(data)); } };
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
    });
  }
  function doc(path) {
    var own = /^data\/users\//.test(path);
    return {
      path: path,
      get: function () { return read(path); },
      set: function (data) { return write(path, data, false); },
      update: function (data) { return write(path, data, true); },
      onSnapshot: function (cb, onErr) {
        var stopped = false, timer = null;
        function tick() {
          read(path).then(function (s) { if (!stopped) cb(s); }, function (e) { if (!stopped && onErr) onErr(e); });
          // world documents change every two hours when the job runs; own documents only change here
          if (!own && !stopped) timer = setTimeout(tick, WORLD_REFRESH_MS);
        }
        tick();
        return function () { stopped = true; clearTimeout(timer); };
      },
    };
  }
  var db = Object.freeze({ doc: doc, collection: function (c) { return { doc: function (k) { return doc(c + "/" + k); } }; } });

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

  // a sign-out control in the desk's top bar
  document.addEventListener("DOMContentLoaded", function () {
    var bar = document.querySelector(".topbar");
    if (!bar) return;
    var b = document.createElement("button");
    b.type = "button";
    b.className = "btn quiet";
    b.textContent = "Sign out";
    b.style.marginLeft = "8px";
    b.addEventListener("click", function () {
      fetch("/auth/signout", { method: "POST", headers: { "x-ripple": "1" }, credentials: "same-origin" })
        .finally(function () { location.assign("/login"); });
    });
    bar.appendChild(b);
  });
})();
