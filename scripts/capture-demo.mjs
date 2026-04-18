/**
 * Capture the HTML demo page as MP4 video using Playwright.
 *
 * Usage: node scripts/capture-demo.mjs
 * Output: demo-output/orka-demo.mp4
 */

import { chromium } from "playwright";
import { execSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { join, resolve } from "path";

const OUT = resolve("demo-output");
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

async function main() {
  console.log("🎬 Recording Orka demo...\n");

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    recordVideo: {
      dir: OUT,
      size: { width: 2880, height: 1800 },
    },
  });

  const page = await context.newPage();
  const htmlPath = resolve("scripts/demo-page.html");
  console.log(`📄 Loading ${htmlPath}`);
  await page.goto(`file://${htmlPath}`);

  // Wait for the full animation to play
  console.log("⏳ Waiting for animation to complete (67s)...");
  await page.waitForTimeout(67000);

  // Take a final screenshot
  await page.screenshot({ path: join(OUT, "demo-final-frame.png") });
  console.log("📸 Final frame captured");

  await page.close();
  await context.close();
  await browser.close();

  // Find the recorded webm and convert to mp4
  const { readdirSync } = await import("fs");
  const files = readdirSync(OUT).filter((f) => f.endsWith(".webm"));
  if (files.length === 0) {
    console.log("⚠️  No .webm file found. Check demo-output/ manually.");
    return;
  }

  const webm = join(OUT, files[files.length - 1]);
  const mp4 = join(OUT, "orka-demo.mp4");
  console.log(`\n🔄 Converting ${webm} → ${mp4}`);

  try {
    execSync(
      `ffmpeg -y -i "${webm}" -vf "scale=1440:900" -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -r 30 "${mp4}"`,
      { stdio: "inherit" }
    );
    console.log(`\n✅ Demo video saved: ${mp4}`);
  } catch (e) {
    console.log(`\n⚠️  ffmpeg conversion failed. Raw recording at: ${webm}`);
  }
}

main().catch(console.error);
