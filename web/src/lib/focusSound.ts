// Focus sounds, generated in the browser (no audio files to download or license). Each sound is a short
// seamless loop played through one <audio> element: phones only show lock-screen controls for media
// elements, and iPhones only allow playback on an element that was first started by a tap.
import type { FocusSound } from './focusSettings';

const RATE = 22_050;
const SECONDS = 12;

let audio: HTMLAudioElement | null = null;
let loaded: FocusSound | null = null;
const urls = new Map<FocusSound, string>();

/** A seeded random source, so a sound is the same every time. */
function random(seed: number) {
  return () => {
    seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
    return seed / 2 ** 31 - 1;
  };
}

function generate(kind: Exclude<FocusSound, 'off'>): Float32Array {
  const fade = RATE; // one second, crossfaded so the loop has no seam
  const n = RATE * SECONDS + fade;
  const out = new Float32Array(n);
  const rnd = random(kind.length * 7919);
  if (kind === 'brown') {
    let last = 0;
    for (let i = 0; i < n; i++) {
      last = (last + 0.02 * rnd()) / 1.02;
      out[i] = last * 3.5;
    }
  } else if (kind === 'rain') {
    // Soft pink-ish noise, plus scattered drops.
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < n; i++) {
      const w = rnd();
      b0 = 0.997 * b0 + w * 0.029591;
      b1 = 0.985 * b1 + w * 0.032534;
      b2 = 0.95 * b2 + w * 0.048056;
      out[i] = (b0 + b1 + b2 + w * 0.05) * 0.9;
    }
    for (let d = 0; d < SECONDS * 40; d++) {
      const at = Math.floor(((rnd() + 1) / 2) * (n - 400));
      const level = 0.05 + 0.1 * Math.abs(rnd());
      for (let k = 0; k < 400; k++) out[at + k] += rnd() * level * Math.exp(-k / 60);
    }
    for (let i = 0; i < n; i++) out[i] *= 0.45;
  } else {
    // Waves: brown noise swelling and settling, twice per loop.
    let last = 0;
    for (let i = 0; i < n; i++) {
      last = (last + 0.02 * rnd()) / 1.02;
      const t = (i % (RATE * SECONDS)) / (RATE * SECONDS);
      const swell = 0.25 + 0.75 * Math.pow(Math.sin(Math.PI * 2 * t), 2);
      out[i] = last * 4 * swell;
    }
  }
  const loop = new Float32Array(RATE * SECONDS);
  for (let i = 0; i < loop.length; i++) {
    if (i < fade) {
      const a = (i / fade) * (Math.PI / 2);
      loop[i] = out[i] * Math.sin(a) + out[RATE * SECONDS + i] * Math.cos(a);
    } else loop[i] = out[i];
  }
  return loop;
}

function wav(samples: Float32Array): Blob {
  const data = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const text = (at: number, s: string) => [...s].forEach((c, i) => data.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  data.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVEfmt ');
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true);
  data.setUint16(22, 1, true);
  data.setUint32(24, RATE, true);
  data.setUint32(28, RATE * 2, true);
  data.setUint16(32, 2, true);
  data.setUint16(34, 16, true);
  text(36, 'data');
  data.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) data.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
  return new Blob([data.buffer], { type: 'audio/wav' });
}

function element(): HTMLAudioElement {
  if (!audio) {
    audio = new Audio();
    audio.loop = true;
    audio.preload = 'auto';
  }
  return audio;
}

/** Start (or keep) playing a sound. Returns false if the browser blocked it until the next tap. */
export async function playSound(kind: FocusSound, volume: number): Promise<boolean> {
  if (kind === 'off') {
    stopSound();
    return true;
  }
  const el = element();
  if (loaded !== kind) {
    if (!urls.has(kind)) urls.set(kind, URL.createObjectURL(wav(generate(kind))));
    el.src = urls.get(kind)!;
    loaded = kind;
  }
  el.volume = Math.max(0, Math.min(1, volume));
  if (!el.paused) return true;
  try {
    await el.play();
    return true;
  } catch {
    return false;
  }
}

export function pauseSound() {
  audio?.pause();
}

export function stopSound() {
  if (!audio) return;
  audio.pause();
  audio.currentTime = 0;
}

export const soundPlaying = () => Boolean(audio && !audio.paused);
