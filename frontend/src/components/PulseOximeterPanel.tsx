import { parseNumeric } from "../bridge/protocol";
import type { MedWand } from "../hooks/useMedWand";
import { BigReading, Panel, StartStopButton } from "./ui";

export function PulseOximeterPanel({ mw }: { mw: MedWand }) {
  const running = mw.state?.activeSensor?.sensor === "pulseOximeter";
  const reading = mw.reading?.sensor === "pulseOximeter" ? mw.reading.reading : null;
  const spo2 = parseNumeric(reading?.spo2);
  const pulse = parseNumeric(reading?.pulseRate);

  return (
    <Panel title="Pulse Oximeter">
      <div className="reading-row">
        <BigReading label="SpO₂" value={spo2 != null ? String(spo2) : "--"} unit="%" />
        <BigReading label="Pulse" value={pulse != null ? String(pulse) : "--"} unit="bpm" />
      </div>
      <StartStopButton
        running={running}
        onStart={() => mw.startSensor("pulseOximeter")}
        onStop={mw.stopSensor}
      />
    </Panel>
  );
}
