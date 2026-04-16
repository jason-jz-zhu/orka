---
name: demo-video-assembler
description: >
  Record an HTML demo page as video using Playwright, merge with voiceover
  audio, and produce a final MP4. Use when someone says "record the demo",
  "capture video", or "assemble the final mp4".
allowed-tools: Bash, Read, Write
orka:
  schema: 1
  inputs:
    - { name: html_path, default: "demo-output/demo-page.html", description: "Path to HTML demo page" }
    - { name: audio_path, default: "demo-output/voice/mixed.aac", description: "Path to mixed voiceover audio" }
    - { name: duration_s, default: "55", description: "Recording duration in seconds" }
    - { name: output_path, default: "demo-output/final-demo.mp4", description: "Final video output path" }
---

# Demo Video Assembler

Record an HTML animation page and merge it with voiceover audio into a final MP4.

## Prerequisites

- Node.js + Playwright: `npm install playwright && npx playwright install chromium`
- ffmpeg: `brew install ffmpeg`

## Steps

1. Record the HTML page using Playwright:
   ```javascript
   const { chromium } = require('playwright');
   const browser = await chromium.launch({ headless: false });
   const context = await browser.newContext({
     viewport: { width: 1440, height: 900 },
     deviceScaleFactor: 2,
     recordVideo: { dir: 'demo-output', size: { width: 2880, height: 1800 } },
   });
   const page = await context.newPage();
   await page.goto('file://' + require('path').resolve('{{html_path}}'));
   await page.waitForTimeout({{duration_s}} * 1000 + 3000);
   await page.close();
   await context.close();
   await browser.close();
   ```

2. Find the recorded .webm file (newest in demo-output/).

3. Convert webm to mp4 (silent):
   ```bash
   ffmpeg -y -i <webm> -vf scale=1440:900 \
     -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -r 30 \
     demo-output/silent.mp4
   ```

4. If `{{audio_path}}` exists, merge video + audio:
   ```bash
   ffmpeg -y -i demo-output/silent.mp4 -i {{audio_path}} \
     -c:v copy -c:a aac -b:a 128k -shortest \
     {{output_path}}
   ```
   If no audio, just rename silent.mp4 to the output path.

5. Report:
   - Final file path and size
   - Duration
   - Resolution
