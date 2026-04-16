---
name: demo-voice-generator
description: >
  Generate voiceover audio files from a script using Microsoft Edge Neural TTS.
  Use when someone says "generate voice", "text to speech", "create narration audio",
  or "make voiceover files".
allowed-tools: Bash, Read, Write
orka:
  schema: 1
  inputs:
    - { name: script_path, default: "demo-output/voiceover-script.json", description: "Path to voiceover script JSON" }
    - { name: voice, default: "en-US-AndrewMultilingualNeural", description: "Edge TTS voice name" }
    - { name: rate, default: "-3%", description: "Speech rate adjustment" }
    - { name: output_dir, default: "demo-output/voice", description: "Directory for mp3 files" }
---

# Demo Voice Generator

Generate high-quality voiceover audio from a script JSON file using edge-tts.

## Prerequisites

edge-tts must be installed: `pip3 install edge-tts`

## Steps

1. Read the script from `{{script_path}}`. It should contain:
   ```json
   {
     "segments": [
       { "scene": 1, "start_s": 0, "duration_s": 5, "text": "..." }
     ]
   }
   ```

2. Create the output directory: `mkdir -p {{output_dir}}`

3. For each segment, generate an mp3:
   ```bash
   edge-tts --voice "{{voice}}" --rate="{{rate}}" \
     --text "<segment text>" \
     --write-media {{output_dir}}/XX.mp3
   ```
   where XX is the zero-padded scene number.

4. Verify each file was created and report its duration:
   ```bash
   ffprobe -v error -show_entries format=duration -of csv=p=0 <file>
   ```

5. Mix all segments into a single audio track with correct timing using ffmpeg:
   - Use `adelay` filter to position each segment at its `start_s` timestamp
   - Use `amix` with `normalize=0` to prevent volume drops
   - Apply `volume=1.8,alimiter=limit=0.95` for consistent loudness
   - Output to `{{output_dir}}/mixed.aac`

6. Report:
   - Number of segments generated
   - Total audio duration
   - Path to mixed file
