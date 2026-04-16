---
name: demo-script-writer
description: >
  Write voiceover scripts for a product demo video. Takes scene descriptions
  and produces timed narration text for each scene. Use when someone says
  "write voiceover", "narration script", or "demo script".
allowed-tools: Write
orka:
  schema: 1
  inputs:
    - { name: product_name, description: "Product name" }
    - { name: scenes, description: "JSON array of scenes with title and duration_s" }
    - { name: tone, default: "warm, confident, concise", description: "Voice tone" }
    - { name: output_path, default: "demo-output/voiceover-script.json", description: "Output JSON path" }
---

# Demo Script Writer

Write voiceover narration for each scene of a product demo.

## Rules

- Each segment must fit within its scene's duration (roughly 2-3 words per second)
- Tone: {{tone}}
- No filler words. Every sentence earns its place.
- First segment must name the product
- Last segment must be a memorable closing line
- Avoid technical jargon unless the audience is developers

## Steps

1. Read the scenes: `{{scenes}}`

2. For each scene, write a voiceover segment:
   - Must be speakable in the scene's `duration_s` seconds
   - Must match what's visually happening in that scene
   - Must flow naturally from the previous segment

3. Output a JSON file to `{{output_path}}` with this structure:
   ```json
   {
     "product": "{{product_name}}",
     "segments": [
       {
         "scene": 1,
         "start_s": 0,
         "duration_s": 5,
         "text": "The voiceover text for this scene."
       }
     ]
   }
   ```

4. Also output a plain-text summary showing each segment with its timing.
