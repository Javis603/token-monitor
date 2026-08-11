import { mkdir, rm, writeFile, copyFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build as bundle } from "esbuild";

const siteRoot = new URL("./", import.meta.url);
const outputRoot = new URL("../_site/", import.meta.url);

const cssFiles = ["styles/tokens.css", "styles/base.css", "styles/components.css", "styles/sections.css"];
const jsFiles = ["scripts/i18n.js", "scripts/main.js"];
const assetVersion = "20260730-story29";
// Icons are the site's own brand-colored copies under site/assets/icons/ (the app's
// assets/icons/ stay mask-only currentColor and must not be mutated to serve the web).
// tray-claude / tray-codex are the real tray glyphs, masked to monochrome in the surfaces section.
const iconNames = ["claude", "codex", "cursor", "antigravity", "hermes-agent", "opencode", "openclaw", "codebuddy", "workbuddy", "reasonix", "openrouter", "newapi", "volcengine", "os-apple", "os-windows", "os-linux", "tray-claude", "tray-codex", "gemini", "xai", "deepseek", "qwen", "kimi", "mistral", "meta", "zai", "minimax", "cline", "copilot", "pi", "zed", "kilocode", "kiro", "mimo-code"];
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
    .replace(/url\(([\"']?)\.\.\/assets\//g, "url($1assets/");
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(new URL("assets/", outputRoot), { recursive: true }); // also creates _site/ root
await mkdir(new URL("assets/icons/", outputRoot), { recursive: true });
await mkdir(new URL("assets/icons/views/", outputRoot), { recursive: true });

const bundledCss = (await concat(cssFiles)).replace(/url\(([\"']?)\.\.\/assets\//g, "url($1assets/");
await writeFile(new URL("styles.css", outputRoot), bundledCss);
await writeFile(new URL("app.js", outputRoot), await concat(jsFiles));
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

console.log(`Built GitHub Pages site at ${fileURLToPath(outputRoot)}`);
