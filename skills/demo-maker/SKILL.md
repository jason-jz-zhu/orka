---
name: demo-maker
description: >
  Create a complete product demo video from a description. Generates an
  animated HTML page, writes voiceover narration, synthesizes speech audio,
  records the animation, and produces a final MP4 with voice. Use when
  someone says "make a demo video", "create a product demo", "record a
  marketing video", or "demo for my app".
allowed-tools: Read, Write, Bash
examples:
  - "Make a demo for Orka, a Claude-wrapping desktop app. Show the trust modal and the skill runner."
  - "Demo for a side project called Moodboard — a Figma plugin that auto-generates palettes from a URL."
  - "Record a 30-second marketing video for my CLI tool that migrates Postgres schemas."
orka:
  schema: 1
  inputs:
    - name: product_name
      description: "Product name"
    - name: tagline
      description: "One-line tagline for the product"
    - name: features
      description: "Key features to showcase (comma-separated or bullet list)"
    - name: voice
      default: "en-US-AndrewMultilingualNeural"
      description: "Edge TTS voice name"
---

# Demo Maker

Create a complete product demo video with animation and voiceover.

This is a composite skill that orchestrates four sub-skills in sequence.

## Steps

1. **Plan scenes** — from the product description, design 7-9 scenes:
   - Scene 1: Title card (product name + tagline + hook)
   - Scenes 2-3: Problem → solution transition
   - Scenes 4-6: Key feature demonstrations
   - Scene 7-8: Results / social proof
   - Final scene: End card with CTA
   
   Create a scenes JSON array and save to `demo-output/scenes.json`.

2. **Generate HTML** — call the `demo-html-generator` skill with:
   - product_name: {{product_name}}
   - tagline: {{tagline}}
   - scenes: (the scenes JSON from step 1)
   - output_path: demo-output/demo-page.html

3. **Write voiceover** — call the `demo-script-writer` skill with:
   - product_name: {{product_name}}
   - scenes: (the scenes JSON from step 1)
   - tone: warm, confident, concise
   - output_path: demo-output/voiceover-script.json

4. **Generate audio** — call the `demo-voice-generator` skill with:
   - script_path: demo-output/voiceover-script.json
   - voice: {{voice}}
   - output_dir: demo-output/voice

5. **Assemble video** — call the `demo-video-assembler` skill with:
   - html_path: demo-output/demo-page.html
   - audio_path: demo-output/voice/mixed.aac
   - output_path: demo-output/final-demo.mp4

6. **Report** — show the user:
   - Final video path and file size
   - How to open: `open demo-output/final-demo.mp4`
   - How to re-run individual steps if they want to tweak something

<!-- orka:graph v1
{
  "nodes": [
    {"id":"n1","type":"agent","pos":[60,200],"data":{"prompt":"Plan 7-9 demo scenes for {{product_name}}. Tagline: {{tagline}}. Features: {{features}}. Output a JSON array to demo-output/scenes.json. Each scene: {title, duration_s, visual_description, text_overlay}."}},
    {"id":"n2","type":"skill_ref","pos":[380,100],"data":{"skill":"demo-html-generator","bind":{"product_name":"{{product_name}}","tagline":"{{tagline}}","scenes":"{{n1}}","output_path":"demo-output/demo-page.html"}}},
    {"id":"n3","type":"skill_ref","pos":[380,300],"data":{"skill":"demo-script-writer","bind":{"product_name":"{{product_name}}","scenes":"{{n1}}","output_path":"demo-output/voiceover-script.json"}}},
    {"id":"n4","type":"skill_ref","pos":[700,300],"data":{"skill":"demo-voice-generator","bind":{"script_path":"demo-output/voiceover-script.json","voice":"{{voice}}"}}},
    {"id":"n5","type":"skill_ref","pos":[1020,200],"data":{"skill":"demo-video-assembler","bind":{"html_path":"demo-output/demo-page.html","audio_path":"demo-output/voice/mixed.aac","output_path":"demo-output/final-demo.mp4"}}}
  ],
  "edges": [["n1","n2"],["n1","n3"],["n3","n4"],["n2","n5"],["n4","n5"]],
  "stepMap": {"n1":1,"n2":2,"n3":3,"n4":4,"n5":5},
  "proseHash": ""
}
-->
