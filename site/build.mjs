import { buildReferences } from "./build-docs.mjs";
import { mkdir, rm, writeFile, copyFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build as bundle } from "esbuild";

const siteRoot = new URL("./", import.meta.url);
const outputRoot = new URL("../_site/", import.meta.url);

const cssFiles = ["styles/tokens.css", "styles/base.css", "styles/components.css", "styles/edgedock.css", "styles/sections.css"];
const jsFiles = ["scripts/i18n.js", "scripts/main.js"];
const assetVersion = "20261031-plugin-resources";
// Icons are the site's own copies under site/assets/icons/ (the app's assets/icons/ stay
// mask-only currentColor and must not be mutated to serve the web). Marks the app only
// draws as ink — the brands whose art renders black — are copied verbatim and flattened
// to white by the marquee rule in styles/components.css; the rest are brand-colored.
// tray-claude / tray-codex are the real tray glyphs, masked to monochrome in the surfaces section.
const iconNames = ["claude", "codex", "cursor", "antigravity", "hermes-agent", "opencode", "openclaw", "codebuddy", "workbuddy", "reasonix", "dsh", "openrouter", "newapi", "volcengine", "os-apple", "os-windows", "os-linux", "tray-claude", "tray-codex", "gemini", "xai", "deepseek", "qwen", "kimi", "mistral", "meta", "zai", "minimax", "cline", "copilot", "pi", "zed", "kilo", "kiro", "mimo", "devin", "amp", "droid", "omp", "senpi", "commandcode", "qoder", "trae", "cherrystudio", "lmstudio", "unsloth", "alibaba", "typesafe", "ollama", "proma", "catpaw", "fx", "stepfun", "spinner", "token-monitor"];
const viewIconNames = ["home", "limits", "tool", "model", "device", "session", "project", "trends", "status"];
const assets = [
  ["assets/app.png", "assets/app.png"], // full app icon used by the Discord mockup
  ["assets/icon.png", "assets/icon.png"], // nav brand mark (glass sigma)
  ["THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md"],
  ...iconNames.map((name) => [`assets/icons/${name}.svg`, `assets/icons/${name}.svg`]),
  ...viewIconNames.map((name) => [`assets/icons/views/${name}.svg`, `assets/icons/views/${name}.svg`]),
];

async function concat(files) {
  const parts = [];
  for (const f of files) parts.push(await readFile(new URL(f, siteRoot), "utf8"));
  return parts.join("\n");
}
function rewriteHtml(html) {
  // Collapse the 4 dev CSS links into one, then add the bundled React islands
  // beside the existing concatenated i18n/main script.
  return html
    .replace(/\s*<link rel="stylesheet" href="styles\/tokens\.css(?:\?[^"]*)?">[\s\S]*?<link rel="stylesheet" href="styles\/sections\.css(?:\?[^"]*)?">/, `\n    <link rel="stylesheet" href="styles.css?v=${assetVersion}">`)
    .replace(/\s*<script src="scripts\/i18n\.js(?:\?[^"]*)?" defer><\/script>[\s\S]*?<script src="scripts\/main\.js(?:\?[^"]*)?" defer><\/script>/, `\n    <script src="app.js?v=${assetVersion}" defer></script>\n    <script src="islands.js?v=${assetVersion}" defer></script>`)
    .replace(/url\((["']?)\.\.\/assets\//g, "url($1assets/");
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(new URL("assets/", outputRoot), { recursive: true }); // also creates _site/ root
await mkdir(new URL("assets/icons/", outputRoot), { recursive: true });
await mkdir(new URL("assets/icons/views/", outputRoot), { recursive: true });

const bundledCss = (await concat(cssFiles)).replace(/url\((["']?)\.\.\/assets\//g, "url($1assets/");
await writeFile(new URL("styles.css", outputRoot), bundledCss);
await writeFile(new URL("app.js", outputRoot), await concat(jsFiles));
// islands.jsx imports src/electron/tokenNumberAnimation.js so the site's token
// readings roll with the widget's own animation instead of a second copy. The
// module is bundled here, so it is not fetched from the site root: keep its
// exported names (normalize, beginRoll, capture, duration, layoutDuration) as
// the contract this build depends on.
await bundle({
  entryPoints: [fileURLToPath(new URL("scripts/islands.jsx", siteRoot))],
  outfile: fileURLToPath(new URL("islands.js", outputRoot)),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  jsx: "automatic",
  minify: true,
  legalComments: "inline"
});

const html = await readFile(new URL("index.html", siteRoot), "utf8");
await writeFile(new URL("index.html", outputRoot), rewriteHtml(html));

for (const [src, dest] of assets) await copyFile(new URL(src, siteRoot), new URL(dest, outputRoot));


// Documentation keeps the landing page's base styles and i18n, with a small
// page-specific sheet/script. Relative paths also work under a Pages project path.
await mkdir(new URL("docs/", outputRoot), { recursive: true });
await copyFile(new URL("styles/docs.css", siteRoot), new URL("docs.css", outputRoot));
await copyFile(new URL("scripts/docs.js", siteRoot), new URL("docs.js", outputRoot));
const docPages = ["index", "app", "plugins", "plugin-quickstart", "plugin-ui", "plugin-data", "plugin-share"];
for (const page of docPages) {
  const source = await readFile(new URL(`docs/${page}.html`, siteRoot), "utf8");
  const html = rewriteDocs(source);
  await writeFile(new URL(`docs/${page}.html`, outputRoot), html);
}

function rewriteDocs(source) {
  return source
    .replace(/\s*<link rel="stylesheet" href="\.\.\/styles\/tokens\.css[^"]*">[\s\S]*?<link rel="stylesheet" href="\.\.\/styles\/docs\.css[^"]*">/, `\n    <link rel="stylesheet" href="../styles.css?v=${assetVersion}">\n    <link rel="stylesheet" href="../docs.css?v=${assetVersion}">`)
    .replace(/\s*<script src="\.\.\/scripts\/i18n\.js[^"]*" defer><\/script>[\s\S]*?<script src="\.\.\/scripts\/docs\.js[^"]*" defer><\/script>/, `\n    <script src="../app.js?v=${assetVersion}" defer></script>\n    <script src="../docs.js?v=${assetVersion}" defer></script>`);
}

await buildReferences({ siteRoot, outputRoot, rewrite: rewriteDocs });

console.log(`Built GitHub Pages site at ${fileURLToPath(outputRoot)}`);
