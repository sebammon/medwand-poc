import type { DeviceState, SensorId } from "../bridge/protocol";

const SENSORS: { id: SensorId; label: string; icon: string }[] = [
  { id: "thermometer", label: "Thermometer", icon: "🌡️" },
  { id: "pulseOximeter", label: "Pulse Oximeter", icon: "🫀" },
  { id: "ecg", label: "ECG", icon: "📈" },
  { id: "stethoscope", label: "Stethoscope", icon: "🩺" },
  { id: "camera", label: "Camera", icon: "📷" },
];

export function SensorPicker({
  state,
  selected,
  onSelect,
}: {
  state: DeviceState;
  selected: SensorId | null;
  onSelect: (sensor: SensorId) => void;
}) {
  return (
    <nav className="picker">
      {SENSORS.map((sensor) => {
        const supported = state.capabilities[sensor.id];
        return (
          <button
            key={sensor.id}
            className={`picker__item${selected === sensor.id ? " picker__item--active" : ""}`}
            disabled={!supported}
            onClick={() => onSelect(sensor.id)}
          >
            <span className="picker__icon">{sensor.icon}</span>
            <span>{sensor.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
