// Loaded in <head>, before the page paints, so the chosen theme never flashes. The choice lives in the "mr-theme"
// cookie (light | dark; no cookie = follow the system), the same cookie the app pages read on the server.
(function () {
  "use strict";
  var KEY = "mr-theme";
  function get() {
    var m = document.cookie.match(/(?:^|;\s*)mr-theme=(light|dark)/);
    return m ? m[1] : "system";
  }
  function apply(t) {
    var root = document.documentElement;
    if (t === "system") root.removeAttribute("data-theme"); else root.setAttribute("data-theme", t);
  }
  function set(t) {
    document.cookie = t === "system"
      ? KEY + "=; path=/; max-age=0; samesite=lax"
      : KEY + "=" + t + "; path=/; max-age=31536000; samesite=lax";
    var go = function () { apply(t); window.dispatchEvent(new CustomEvent("mr-theme", { detail: t })); };
    // a quick cross-fade where the browser supports it; otherwise an instant switch
    if (document.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches) document.startViewTransition(go);
    else go();
  }
  apply(get());

  var ICONS = {
    system: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 20h8M12 16v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    light: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    dark: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
  };
  // A three-way switch: System, Light, Dark.
  function control() {
    var g = document.createElement("div");
    g.className = "theme-switch"; g.setAttribute("role", "radiogroup"); g.setAttribute("aria-label", "Theme");
    ["system", "light", "dark"].forEach(function (t) {
      var b = document.createElement("button");
      b.type = "button"; b.setAttribute("role", "radio"); b.dataset.t = t;
      b.title = t.charAt(0).toUpperCase() + t.slice(1); b.setAttribute("aria-label", b.title + " theme");
      b.innerHTML = ICONS[t];
      b.addEventListener("click", function () { set(t); });
      g.appendChild(b);
    });
    var paint = function () { var cur = get(); g.querySelectorAll("button").forEach(function (b) { b.setAttribute("aria-checked", String(b.dataset.t === cur)); }); };
    paint();
    window.addEventListener("mr-theme", paint);
    return g;
  }
  window.MRTheme = Object.freeze({ get: get, set: set, control: control });
})();
