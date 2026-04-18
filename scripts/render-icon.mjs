/**
 * Render assets/orka-icon.svg to PNGs at multiple sizes and build an ICNS.
 *
 * Usage: node scripts/render-icon.mjs
 */
import { chromium } from "playwright";
import { execSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { resolve, join } from "path";

const ROOT = resolve(".");
const SVG_PATH = join(ROOT, "assets/orka-icon.svg");
const OUT_ICONS = join(ROOT, "src-tauri/icons");
const TMP = join(ROOT, "assets/_icon_tmp");
const ICONSET = join(TMP, "orka.iconset");

if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true });
if (existsSync(ICONSET)) rmSync(ICONSET, { recursive: true, force: true });
mkdirSync(ICONSET, { recursive: true });

const svgData = readFileSync(SVG_PATH, "utf-8");

async function render(size) {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: size, height: size },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const html = `<!DOCTYPE html><html><head><style>
    html,body{margin:0;padding:0;width:${size}px;height:${size}px;background:transparent;}
    svg{display:block;width:${size}px;height:${size}px;}
  </style></head><body>${svgData.replace(/width="1024" height="1024"/,`width="${size}" height="${size}"`)}</body></html>`;
  await page.setContent(html);
  const png = await page.screenshot({ omitBackground: true, type: "png", clip: { x: 0, y: 0, width: size, height: size } });
  await browser.close();
  return png;
}

// Sizes needed:
//   iconset (for iconutil → icns): 16, 32, 64, 128, 256, 512, 1024 (and @2x = double each)
//   Tauri bundle: 32x32.png, 128x128.png, 128x128@2x.png (256), icon.png (1024)
const iconsetSpec = [
  { name: "icon_16x16.png",      size: 16 },
  { name: "icon_16x16@2x.png",   size: 32 },
  { name: "icon_32x32.png",      size: 32 },
  { name: "icon_32x32@2x.png",   size: 64 },
  { name: "icon_128x128.png",    size: 128 },
  { name: "icon_128x128@2x.png", size: 256 },
  { name: "icon_256x256.png",    size: 256 },
  { name: "icon_256x256@2x.png", size: 512 },
  { name: "icon_512x512.png",    size: 512 },
  { name: "icon_512x512@2x.png", size: 1024 },
];

console.log("🎨 Rendering PNGs at each size...");
for (const spec of iconsetSpec) {
  const buf = await render(spec.size);
  writeFileSync(join(ICONSET, spec.name), buf);
  console.log(`  ✓ ${spec.name} (${spec.size}x${spec.size})`);
}

// Tauri-required PNGs
console.log("\n🎨 Rendering Tauri bundle PNGs...");
const tauriSpec = [
  { name: "32x32.png",        size: 32 },
  { name: "128x128.png",      size: 128 },
  { name: "128x128@2x.png",   size: 256 },
  { name: "icon.png",         size: 1024 },
];
for (const spec of tauriSpec) {
  const buf = await render(spec.size);
  writeFileSync(join(OUT_ICONS, spec.name), buf);
  console.log(`  ✓ src-tauri/icons/${spec.name}`);
}

// Build ICNS via iconutil
console.log("\n📦 Building icon.icns...");
execSync(`iconutil -c icns -o "${join(OUT_ICONS, "icon.icns")}" "${ICONSET}"`, { stdio: "inherit" });
console.log("  ✓ src-tauri/icons/icon.icns");

// Also create a 1024 preview for README
const previewBuf = await render(512);
writeFileSync(join(ROOT, "assets/orka-icon-512.png"), previewBuf);
console.log("\n  ✓ assets/orka-icon-512.png (preview)");

console.log("\n✅ Done. ICO still needs a Windows tool — skipped.");
