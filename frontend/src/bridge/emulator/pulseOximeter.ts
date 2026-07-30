import { makeReading } from "./reading";
import type { EmitReading, EmulatorPhysical, Timer } from "./types";

const TICK_MS = 860;
const CONFIGURED_MS = 50; // "sensor configured", right after the reply
const CONTACT_MS = 800; // "something on sensor" once a finger is on it
const LOCK_MS = 6000; // contact to "pulseOx success" (traces: 5-9s)
const RELOCK_MS = 2700; // after motion clears
const SPO2_LAG = 2; // readings with spo2 "--" before it reads out

/**
 * The pulse oximeter is a mode machine whose clock stops in some modes.
 *
 * Its status is a sticky mode, not a per-reading flag: a non-empty status replaces
 * the data stream until the sensor locks on again. An empty string means data is
 * flowing, and null means the sensor is not running.
 */
export class PulseOximeter {
  private timers: Timer[] = [];

  private mode: string | null = null;

  private tick = 0;

  /** Readings since the last lock, which is what the spo2 lag counts. */
  private sinceLock = 0;

  constructor(
    private readonly physical: EmulatorPhysical,
    private readonly emit: EmitReading,
    private readonly publish: () => void,
  ) {}

  start(): void {
    this.tick = 0;
    this.later(CONFIGURED_MS, () => {
      this.setMode("sensor configured");
      this.settle(true);
    });
  }

  stop(): void {
    this.clear();
    this.mode = null;
  }

  /** The finger arrived, left, or started moving. */
  onFingerChange(): void {
    this.settle(false);
  }

  /**
   * The current sticky mode, for the panel's readout.
   * @returns The mode, or null when the sensor is not running.
   */
  status(): string | null {
    return this.mode;
  }

  private clear(): void {
    this.timers.forEach(clearTimeout);
    this.timers = [];
  }

  private later(ms: number, run: () => void): void {
    this.timers.push(setTimeout(run, ms));
  }

  private every(ms: number, run: () => void): void {
    this.later(ms, () => {
      run();
      this.every(ms, run);
    });
  }

  private setMode(mode: string): void {
    this.mode = mode;
    this.emit("pulseOximeter", makeReading("spo2", { status: mode }));
    this.publish();
  }

  /**
   * Re-evaluates against the current finger state. Called on start and on every
   * physical change, and it is what produces the silences: with nothing on the
   * sensor it emits one status reading and then stops entirely.
   * @param fromStart Whether this is the initial settle after `startSensor`, which
   * waits for contact rather than reacting to it immediately.
   */
  private settle(fromStart: boolean): void {
    this.clear();

    if (this.physical.finger === "out") {
      this.setMode("ready to measure");
      return; // then nothing at all, until a finger arrives
    }

    if (this.physical.finger === "moving") {
      this.setMode("excessive motion");
      this.lockOn(RELOCK_MS);
      return;
    }

    this.later(fromStart ? CONTACT_MS : 0, () => {
      this.setMode("something on sensor");
      this.lockOn(LOCK_MS);
    });
  }

  private lockOn(delay: number): void {
    this.later(delay, () => {
      this.emit("pulseOximeter", makeReading("spo2", { status: "pulseOx success" }));
      // The lock hands straight over to the data stream, whose wire status is the
      // empty string.
      this.mode = "";
      this.sinceLock = 0;
      this.publish();
      this.stream();
      this.every(TICK_MS, () => this.stream());
    });
  }

  private stream(): void {
    this.tick += 1;
    this.sinceLock += 1;
    this.emit(
      "pulseOximeter",
      makeReading("spo2", {
        status: "",
        pulseRate: String(66 + (this.tick % 5)),
        // Saturation trails the rate by a couple of readings after every lock.
        spo2: this.sinceLock > SPO2_LAG ? String(95 + (this.tick % 2)) : "--",
      }),
    );
  }
}
