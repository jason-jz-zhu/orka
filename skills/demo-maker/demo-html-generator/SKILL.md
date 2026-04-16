---
name: demo-html-generator
description: >
  Generate a self-contained HTML demo animation page for a product.
  Use when someone says "make a demo page", "create a product animation",
  or "build a marketing HTML for my app".
allowed-tools: Read, Write, Bash
orka:
  schema: 1
  inputs:
    - { name: product_name, description: "Product name (e.g. Orka)" }
    - { name: tagline, description: "One-line tagline" }
    - { name: scenes, description: "JSON array of scenes, each with: title, duration_s, visual_description, text_overlay" }
    - { name: output_path, default: "demo-output/demo-page.html", description: "Where to write the HTML file" }
---

# Demo HTML Generator

Generate a single self-contained HTML file that auto-plays an animated product demo.

## Requirements

- Viewport: 1440x900
- Dark theme: background #0a0d14, text #c5cdda, accent blue #3b82f6, purple #8b5cf6, green #4ade80
- Font: -apple-system, system-ui, sans-serif
- Zero external dependencies — all CSS + JS inline
- Auto-plays on page load, no user interaction needed
- Smooth transitions (ease-out, 0.4-0.6s)

## Input

Product name: `{{product_name}}`
Tagline: `{{tagline}}`
Scenes (JSON): `{{scenes}}`

## Steps

1. Parse the scenes JSON. Each scene should have: title, duration in seconds, visual description (what to animate), and text overlay.

2. Generate the HTML with:
   - A title card scene (product name + tagline + first typed line)
   - Each provided scene rendered as animated UI elements
   - An end card with the product name + "orka.dev" or similar CTA
   - CSS keyframe animations for typing effects, fade-ins, slide-ins, badge state changes
   - JS async timeline using setTimeout/delay for scene sequencing

3. Design the UI to look like a real desktop app:
   - Top toolbar with tabs and action buttons
   - Left sidebar with list items
   - Main canvas area with node cards connected by SVG bezier edges
   - Bottom status bar
   - Node cards with headers, content areas, and status badges

4. Write the complete HTML to `{{output_path}}`.

5. Report the file path and total animation duration.
