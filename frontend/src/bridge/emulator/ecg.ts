import { ecgStripDataUri } from "./artifacts";
import { makeReading } from "./reading";
import type { Capture } from "../protocol";
import type { EmitReading, Timer } from "./types";

const TICK_MS = 250; // cadence of streamed readings
const SAMPLES_PER_READING = 12;
const PHASE_STEP = 0.28;
/** Samples kept for the recorded strip, which is only this many pixels wide. */
const HISTORY_MAX = 900;

/**
 * A synthetic ECG. Unlike the thermometer and pulse oximeter, this waveform was
 * never captured from hardware: it is a dimensionless beat generator, shaped to
 * look like a trace rather than to reproduce one. The device streams unconditionally
 * once started, so there is no physical input to react to.
 */
export class Ecg {
  private timer: Timer | null = null;

  private phase = 0;

  private index = 0;

  /** The rolling waveform, which is also what a recording writes out. */
  private readonly history: number[] = [];

  constructor(private readonly emit: EmitReading) {}

  start(): void {
    this.stop();
    this.index = 0;
    this.history.length = 0;
    this.timer = setInterval(() => this.read(), TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * The recorded strip, as the SDK would deliver it.
   * @returns The capture, carrying a PNG `data:` URI.
   */
  capture(): Capture {
    return { sensor: "ecg", dataUri: ecgStripDataUri(this.history) };
  }

  private read(): void {
    this.index += 1;

    const samples: number[] = [];
    for (let i = 0; i < SAMPLES_PER_READING; i += 1) {
      this.phase += PHASE_STEP;
      // A dimensionless synthetic beat centered on zero: baseline wander that
      // swings both ways, plus a periodic QRS spike (up) with a small S dip (down).
      const beat = Math.sin(this.phase) * 40;
      const phaseInBeat = this.phase % (Math.PI * 2);
      const spike = phaseInBeat < 0.3 ? 320 : phaseInBeat < 0.5 ? -120 : 0;
      samples.push(Math.round(beat + spike));
    }

    this.history.push(...samples);
    if (this.history.length > HISTORY_MAX) {
      this.history.splice(0, this.history.length - HISTORY_MAX);
    }

    this.emit(
      "ecg",
      makeReading("ecg", { index: this.index, ecgData: samples.join(" ") }),
    );
  }
}
