// Builds public/desk/ from the single-file dashboard (../map/index.html, the claude.ai version), so both stay
// one source. Splits the inline <style> and <script> into files, because the app's Content-Security-Policy
// allows no inline script, and swaps a few lines of copy that only made sense for the single-owner page.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "..", "map");
const out = join(here, "..", "public", "desk");
if (!existsSync(join(src, "index.html"))) {
  // on the build server only web/ is uploaded: deploy the desk files generated on the owner's Mac
  if (!existsSync(join(out, "index.html"))) throw new Error("no desk source and no built desk");
  console.log("desk: using the files already in public/desk");
  process.exit(0);
}
mkdirSync(out, { recursive: true });

let html = readFileSync(join(src, "index.html"), "utf8");

const styleStart = html.indexOf("<style>"), styleEnd = html.indexOf("</style>");
const css = html.slice(styleStart + 7, styleEnd);
html = html.slice(0, styleStart) + '<link rel="stylesheet" href="/desk/app.css">' + html.slice(styleEnd + 8);

const dataTag = '<script src="data.js"></script>';
const scriptStart = html.indexOf("<script>", html.indexOf(dataTag));
const scriptEnd = html.lastIndexOf("</script>");
let js = html.slice(scriptStart + 8, scriptEnd);
html = html.slice(0, scriptStart) + html.slice(scriptEnd + 9);
if (/<script(?![^>]*src)/.test(html.replace(dataTag, ""))) throw new Error("an inline <script> is left; the CSP would block it");

// the single-owner setup steps (keys typed into a file on the owner's Mac) become a pointer to /connect
const cStart = js.indexOf("  const CONNECT = {"), cEnd = js.indexOf("  function brokerCard");
if (cStart < 0 || cEnd < cStart) throw new Error("CONNECT block not found");
const webStep = ["Use <a href=\"/connect\">Connect investing platforms</a> at the top of this desk."];
js = js.slice(0, cStart) + `  const CONNECT = ${JSON.stringify({ groww: webStep, coindcx: webStep, mf: ["Upload your CAMS statement on <a href=\"/connect\">Connect investing platforms</a>."] })};\n` + js.slice(cEnd);

// copy that assumed one owner viewing their own Robinhood account
const swaps = [
  ["The owner&rsquo;s Robinhood holdings are private to them. Paste your own tickers below to see their exposure to the news.",
   "Connect your platforms or upload a mutual fund statement with the button above to see your holdings, trades and the events behind your gains and losses here. Meanwhile, paste tickers below to see their exposure to the news."],
  ['<span class="tag" id="pfAsof">private</span>',
   '<span class="row" style="gap:8px;flex-wrap:wrap"><a class="btn" href="/connect">Connect investing platforms</a><a class="btn quiet" href="/activity">Trades and events</a><a class="btn quiet" href="/connectors">Connectors</a><span class="tag" id="pfAsof">private</span></span>'],
  ["and Claude is blocked from opening your keys file. A fund statement is read only on your Mac, and only fund names, units and costs are kept.",
   "and each key is sealed so this site cannot read it back."],
  ["Live prices work when this page is open in Claude; showing the morning snapshot.",
   "Live prices are not connected yet; showing the latest close."],
];
for (const [from, to] of swaps) {
  if (!js.includes(from) && !html.includes(from)) throw new Error("copy to swap not found: " + from.slice(0, 50));
  js = js.split(from).join(to);
  html = html.split(from).join(to);
}

const head = html.slice(0, html.indexOf("<svg"));          // title, metas, font links, stylesheet
const body = html.slice(html.indexOf("<svg")).replace(dataTag, "");
const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex">
<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui}img{max-width:100%}[hidden]{display:none!important}</style>
${head}
</head><body>
${body}
<script src="/desk/runtime.js"></script>
<script src="/desk/data.js"></script>
<script src="/desk/app.js"></script>
</body></html>
`;
// the reset above is a style element, which the CSP allows ('unsafe-inline' for styles only)
writeFileSync(join(out, "index.html"), page);
writeFileSync(join(out, "app.css"), css);
writeFileSync(join(out, "app.js"), js);
copyFileSync(join(src, "data.js"), join(out, "data.js"));
copyFileSync(join(here, "..", "desk-src", "runtime.js"), join(out, "runtime.js"));
console.log(`desk built: index ${(page.length / 1024).toFixed(0)} kB, app.js ${(js.length / 1024).toFixed(0)} kB, app.css ${(css.length / 1024).toFixed(0)} kB`);
