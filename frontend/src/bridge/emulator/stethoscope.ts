import { stethoscopeClipDataUri } from "./artifacts";
import type { Capture, StethMode } from "../protocol";

/**
 * Live auscultation. The device plays the audio through its own speaker and puts
 * nothing on the wire, so the mode it is running in and the clip a recording
 * produces are the only observable state.
 */
export class Stethoscope {
  private mode: StethMode | null = null;

  start(mode: StethMode): void {
    this.mode = mode;
  }

  stop(): void {
    this.mode = null;
  }

  /**
   * The recorded clip, as the SDK would deliver it.
   * @returns The capture, carrying a WAV `data:` URI.
   */
  capture(): Capture {
    return {
      sensor: "stethoscope",
      mode: this.mode ?? "heart",
      dataUri: stethoscopeClipDataUri(),
    };
  }
}
