import { makeReading } from "./reading";
import type { EmitReading, EmulatorPhysical, Timer } from "./types";

const TICK_MS = 1005;
const FIRST_MS = 1050;
const WARMUP_MS = 3000; // reads "Low" this long after finding a target

/**
 * The thermometer is a clock. While active it fires unconditionally, its status is
 * always "success", and it never goes silent. The only thing that varies is the
 * value, which is a function of what the probe is pointed at.
 */
export class Thermometer {
  private timer: Timer | null = null;

  private tick = 0;

  /**
   * When the probe last found or lost a target. The probe stabilizes thermally, so
   * it reads "Low" for a moment after acquiring one. This survives stop/start,
   * which is why a restarted sensor reads out immediately when the probe never
   * moved.
   */
  private targetSince = Date.now();

  constructor(
    private readonly physical: EmulatorPhysical,
    private readonly emit: EmitReading,
  ) {}

  start(): void {
    this.tick = 0;
    this.timer = setTimeout(() => {
      this.read();
      this.every(TICK_MS);
    }, FIRST_MS);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** The probe moved, so it has to settle thermally all over again. */
  retarget(): void {
    this.targetSince = Date.now();
  }

  private every(ms: number): void {
    this.timer = setTimeout(() => {
      this.read();
      this.every(ms);
    }, ms);
  }

  private read(): void {
    this.tick += 1;
    const settled = Date.now() - this.targetSince >= WARMUP_MS;

    let tempObject = "Low";
    if (this.physical.target === "high") tempObject = "High";
    else if (this.physical.target === "on" && settled) {
      tempObject = (96.7 + (this.tick % 4) * 0.1).toFixed(1);
    }

    this.emit(
      "thermometer",
      makeReading("thermometer", {
        status: "success",
        tempAmbient: (84.7 + (this.tick % 6) * 0.1).toFixed(1),
        tempObject,
      }),
    );
  }
}
