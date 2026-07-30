/**
 * Recorded artifacts, synthesized in the browser. The device delivers these as
 * ready-to-use `data:` URIs (an ECG strip PNG, a stethoscope WAV), so the emulator
 * has to produce real images and real audio rather than placeholders: the panels
 * put them straight into an <img> / <audio>.
 */

/** 1x1 transparent PNG, for when there is no DOM to draw on. */
export const BLANK_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const STRIP_WIDTH = 900;
const STRIP_HEIGHT = 260;

const CLIP_SAMPLE_RATE = 8000;
const CLIP_SECONDS = 3;
const BEAT_PERIOD_S = 0.75;
const BEAT_HZ = 90;
const BEAT_DECAY = 6;
const BEAT_AMPLITUDE = 12000;

/**
 * Draws the recorded ECG strip.
 * @param samples The dimensionless waveform, oldest first.
 * @returns A PNG `data:` URI.
 */
export function ecgStripDataUri(samples: number[]): string {
  const canvas = document.createElement("canvas");
  canvas.width = STRIP_WIDTH;
  canvas.height = STRIP_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) return BLANK_PNG;

  ctx.fillStyle = "#fff5f5";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const shown = samples.slice(-canvas.width);
  if (shown.length < 2) return canvas.toDataURL("image/png");

  // Autoscale into the canvas so any value range (incl. negatives) fits.
  let min = Infinity;
  let max = -Infinity;
  for (const value of shown) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const range = max - min || 1;
  const pad = canvas.height * 0.1;

  ctx.strokeStyle = "#c0392b";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  shown.forEach((value, i) => {
    const y = canvas.height - pad - ((value - min) / range) * (canvas.height - pad * 2);
    if (i === 0) ctx.moveTo(i, y);
    else ctx.lineTo(i, y);
  });
  ctx.stroke();

  return canvas.toDataURL("image/png");
}

/**
 * Synthesizes the recorded auscultation clip: a soft "lub-dub" pulse, so the clip
 * is audibly non-trivial rather than silence.
 * @returns A WAV `data:` URI.
 */
export function stethoscopeClipDataUri(): string {
  const total = CLIP_SAMPLE_RATE * CLIP_SECONDS;
  const pcm = new Int16Array(total);
  for (let i = 0; i < total; i += 1) {
    const t = i / CLIP_SAMPLE_RATE;
    const envelope = Math.exp(-((t % BEAT_PERIOD_S) * BEAT_DECAY));
    pcm[i] = Math.round(Math.sin(2 * Math.PI * BEAT_HZ * t) * envelope * BEAT_AMPLITUDE);
  }

  const bytes = wavFromPcm(pcm, CLIP_SAMPLE_RATE);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return `data:audio/wav;base64,${btoa(binary)}`;
}

/** Wraps mono 16-bit PCM in a WAV container. */
function wavFromPcm(pcm: Int16Array, sampleRate: number): Uint8Array {
  const bytesPerSample = 2;
  const dataSize = pcm.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeStr = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);
  for (let i = 0; i < pcm.length; i += 1) {
    view.setInt16(44 + i * bytesPerSample, pcm[i], true);
  }

  return new Uint8Array(buffer);
}
