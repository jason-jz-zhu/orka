// Two-tone "ping" notification played when a session transitions from
// generating → awaiting_user ("Claude just cooked"). Web Audio primary,
// HTMLAudioElement fallback with a generated WAV data-URI in case Tauri's
// WKWebView throttles the Web Audio path.

const ENABLED_KEY = "orka:soundEnabled";
let ctx: AudioContext | null = null;

function ensureCtx(): AudioContext | null {
  if (ctx && ctx.state !== "closed") return ctx;
  try {
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
    return ctx;
  } catch (e) {
    console.warn("[orka:sound] AudioContext create failed:", e);
    return null;
  }
}

function tone(c: AudioContext, freq: number, startAt: number, dur: number) {
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  osc.connect(gain);
  gain.connect(c.destination);
  gain.gain.setValueAtTime(0, startAt);
  gain.gain.linearRampToValueAtTime(0.18, startAt + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + dur);
  osc.start(startAt);
  osc.stop(startAt + dur);
}

/** Build a short two-tone sine WAV as a Blob URL. Used as a fallback when
 * WebAudio is blocked or silent in the current webview. Synth once, cache. */
let fallbackUrl: string | null = null;
function buildFallbackUrl(): string | null {
  if (fallbackUrl) return fallbackUrl;
  try {
    const sampleRate = 44100;
    const totalMs = 280;
    const numSamples = Math.floor((sampleRate * totalMs) / 1000);
    const buf = new ArrayBuffer(44 + numSamples * 2);
    const view = new DataView(buf);
    // RIFF header
    const writeStr = (offset: number, s: string) => {
      for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
    };
    writeStr(0, "RIFF");
    view.setUint32(4, 36 + numSamples * 2, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);      // fmt chunk size
    view.setUint16(20, 1, true);        // PCM
    view.setUint16(22, 1, true);        // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, "data");
    view.setUint32(40, numSamples * 2, true);

    // Two tones: G5 (784Hz) then C6 (1046Hz), quick attack/release.
    const f1 = 784, f2 = 1046.5;
    const split = Math.floor(numSamples * 0.36);
    for (let i = 0; i < numSamples; i++) {
      const t = i / sampleRate;
      const f = i < split ? f1 : f2;
      const localT = i < split ? t : t - split / sampleRate;
      const localDur = i < split ? split / sampleRate : (numSamples - split) / sampleRate;
      // envelope: attack 10ms, exponential decay
      const env =
        Math.min(1, localT / 0.01) *
        Math.exp(-localT / (localDur * 0.5));
      const sample = Math.sin(2 * Math.PI * f * localT) * env * 0.3;
      view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, sample)) * 0x7fff, true);
    }
    const blob = new Blob([buf], { type: "audio/wav" });
    fallbackUrl = URL.createObjectURL(blob);
    return fallbackUrl;
  } catch (e) {
    console.warn("[orka:sound] fallback wav build failed:", e);
    return null;
  }
}

async function playFallback(): Promise<boolean> {
  const url = buildFallbackUrl();
  if (!url) return false;
  try {
    const audio = new Audio(url);
    audio.volume = 0.5;
    await audio.play();
    return true;
  } catch (e) {
    console.warn("[orka:sound] fallback play failed:", e);
    return false;
  }
}

export async function playReadyPing() {
  if (!isSoundEnabled()) return;
  const c = ensureCtx();
  if (!c) {
    await playFallback();
    return;
  }
  try {
    if (c.state === "suspended") {
      await c.resume();
    }
    if (c.state !== "running") {
      console.warn("[orka:sound] audio ctx not running (state=", c.state, ") → fallback");
      await playFallback();
      return;
    }
    const now = c.currentTime;
    tone(c, 784.0, now, 0.12);
    tone(c, 1046.5, now + 0.09, 0.16);
  } catch (e) {
    console.warn("[orka:sound] webaudio failed:", e, "→ fallback");
    await playFallback();
  }
}

export function isSoundEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setSoundEnabled(on: boolean) {
  try {
    localStorage.setItem(ENABLED_KEY, on ? "1" : "0");
  } catch {}
}
