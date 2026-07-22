import { parseNumeric } from "../bridge/protocol";
import type { MedWand } from "../hooks/useMedWand";
import { BigReading, Panel, StartStopButton } from "./ui";

export function ThermometerPanel({ mw }: { mw: MedWand }) {
  const running = mw.state?.activeSensor?.sensor === "thermometer";
  const reading = mw.reading?.sensor === "thermometer" ? mw.reading.reading : null;
  const temp = parseNumeric(reading?.tempObject);

  return (
    <Panel title="Thermometer">
      <BigReading value={temp != null ? temp.toFixed(1) : "--"} unit="°F" />
      <StartStopButton
        running={running}
        onStart={() => mw.startSensor("thermometer")}
        onStop={mw.stopSensor}
      />
    </Panel>
  );
}
