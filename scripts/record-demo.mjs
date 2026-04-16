/**
 * Automated demo recording for Orka.
 *
 * Prerequisites:
 *   - Orka dev server running: npm run tauri dev
 *   - demo-daily-digest skill installed in ~/.claude/skills/
 *   - ffmpeg installed: brew install ffmpeg
 *
 * Usage:
 *   node scripts/record-demo.mjs
 *
 * Output:
 *   demo-output/orka-demo.mp4
 */

import { chromium } from "playwright";
import { execSync } from "child_process";
import { mkdirSync, existsSync } from "fs";
import { join } from "path";

const OUT = join(process.cwd(), "demo-output");
const SCREENSHOTS = join(OUT, "frames");
const DELAY = (ms) => new Promise((r) => setTimeout(r, ms));

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
if (!existsSync(SCREENSHOTS)) mkdirSync(SCREENSHOTS, { recursive: true });

let frameNum = 0;
async function snap(page, label) {
  const name = `${String(frameNum++).padStart(4, "0")}-${label}.png`;
  await page.screenshot({ path: join(SCREENSHOTS, name), fullPage: false });
  console.log(`  📸 ${name}`);
}

async function main() {
  console.log("\n🎬 Orka Demo Recording\n");

  const browser = await chromium.launch({
    headless: false,
    args: ["--window-size=1440,900"],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  console.log("📍 Connecting to Orka at localhost:1420...");
  await page.goto("http://localhost:1420", { waitUntil: "networkidle" });
  await DELAY(2000);

  // ─── Scene 1: Show Studio tab with existing pipeline ───
  console.log("\n🎬 Scene 1: Studio overview");

  // Click Studio tab if not already there
  const studioTab = page.locator("button:has-text('Studio')");
  if (await studioTab.isVisible()) {
    await studioTab.click();
    await DELAY(1000);
  }
  await snap(page, "studio-overview");

  // ─── Scene 2: Click + New to clear canvas ───
  console.log("\n🎬 Scene 2: New pipeline");

  const newBtn = page.locator("button:has-text('+ New')");
  if (await newBtn.isVisible()) {
    await newBtn.click();
    await DELAY(500);
    // Handle confirm dialog if present
    const confirmBtn = page.locator("button:has-text('OK'), button:has-text('Yes'), button:has-text('Discard')");
    if (await confirmBtn.first().isVisible({ timeout: 1000 }).catch(() => false)) {
      await confirmBtn.first().click();
    }
    await DELAY(1000);
  }
  await snap(page, "blank-canvas");

  // ─── Scene 3: Add Agent node 1 ───
  console.log("\n🎬 Scene 3: Add first Agent node");

  const agentBtn = page.locator("button:has-text('+ Agent')");
  await agentBtn.click();
  await DELAY(800);

  // Type in the prompt
  const textareas = page.locator("textarea");
  const firstTextarea = textareas.last();
  if (await firstTextarea.isVisible()) {
    await firstTextarea.click();
    await firstTextarea.fill("List files in ~/Documents modified in the last 48 hours. Read the top 5 and summarize their key content.");
    await DELAY(500);
  }
  await snap(page, "agent-1-typed");

  // ─── Scene 4: Add Agent node 2 ───
  console.log("\n🎬 Scene 4: Add second Agent node");

  await agentBtn.click();
  await DELAY(800);

  const allTextareas = page.locator("textarea");
  const lastTextarea = allTextareas.last();
  if (await lastTextarea.isVisible()) {
    await lastTextarea.click();
    await lastTextarea.fill("Produce a daily digest: 5 bullet points, under 150 words.");
    await DELAY(500);
  }
  await snap(page, "agent-2-typed");

  // ─── Scene 5: Add Output node ───
  console.log("\n🎬 Scene 5: Add Output node");

  const outputBtn = page.locator("button:has-text('+ Output')");
  await outputBtn.click();
  await DELAY(800);

  // Select Apple Notes destination
  const destSelect = page.locator("select").last();
  if (await destSelect.isVisible()) {
    await destSelect.selectOption("notes");
    await DELAY(500);
  }
  await snap(page, "output-notes");

  // ─── Scene 6: Show the full canvas ───
  console.log("\n🎬 Scene 6: Full canvas view");

  // Click "fit view" button (the square icon in ReactFlow controls)
  const fitBtn = page.locator(".react-flow__controls-fitview, button[title='fit view']");
  if (await fitBtn.first().isVisible({ timeout: 1000 }).catch(() => false)) {
    await fitBtn.first().click();
    await DELAY(500);
  }
  await snap(page, "full-canvas");

  // ─── Scene 7: Take multiple frames for a "build" sequence ───
  console.log("\n🎬 Scene 7: Extra frames of the canvas");
  await DELAY(500);
  await snap(page, "canvas-ready");

  // ─── Scene 8: Show Skills palette ───
  console.log("\n🎬 Scene 8: Skills palette");
  await snap(page, "skills-visible");

  // ─── Scene 9: Show Runs tab ───
  console.log("\n🎬 Scene 9: Runs tab");

  const runsTab = page.locator("button:has-text('Runs')");
  if (await runsTab.isVisible()) {
    await runsTab.click();
    await DELAY(1000);
  }
  await snap(page, "runs-tab");

  // ─── Scene 10: Show Live tab ───
  console.log("\n🎬 Scene 10: Live tab");

  const liveTab = page.locator("button:has-text('Live')");
  if (await liveTab.isVisible()) {
    await liveTab.click();
    await DELAY(1000);
  }
  await snap(page, "live-tab");

  // ─── Scene 11: Back to Studio ───
  console.log("\n🎬 Scene 11: Back to Studio");
  await studioTab.click();
  await DELAY(1000);
  await snap(page, "studio-final");

  // ─── Done ───
  console.log("\n✅ Screenshots captured in demo-output/frames/");
  console.log(`   Total frames: ${frameNum}`);

  await browser.close();

  // ─── Stitch into video ───
  console.log("\n🎬 Stitching frames into video...");
  try {
    // Each frame shows for 3 seconds, 30fps
    execSync(
      `ffmpeg -y -framerate 0.4 -pattern_type glob -i '${SCREENSHOTS}/*.png' ` +
      `-vf "scale=1440:900:force_original_aspect_ratio=decrease,pad=1440:900:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p" ` +
      `-c:v libx264 -preset slow -crf 18 -r 30 ` +
      `${OUT}/orka-demo.mp4`,
      { stdio: "inherit" }
    );
    console.log(`\n✅ Video saved: demo-output/orka-demo.mp4`);
  } catch (e) {
    console.log(`\n⚠️  ffmpeg failed. Screenshots are in demo-output/frames/ — stitch manually.`);
    console.log(`   Try: ffmpeg -framerate 0.4 -pattern_type glob -i 'demo-output/frames/*.png' -vf 'scale=1440:900,format=yuv420p' -c:v libx264 demo-output/orka-demo.mp4`);
  }
}

main().catch(console.error);
