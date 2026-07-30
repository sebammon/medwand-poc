import type { SdkReading } from "../protocol";

// One-shot readings are not paged, so both stay 0 on the wire; the ECG overrides
// `index`, which is the one stream the SDK numbers.
const READING_INDEX = 0;
const READING_COUNT = 0;

/**
 * Builds an SdkReading verbatim: every field present, nulls where not applicable,
 * and every scalar a string exactly as the SDK emits it.
 * @param sensorType The SDK's own name for the sensor, which is not always the
 * name used by the `startSensor` command.
 * @param fields The values this particular reading carries.
 * @returns The full reading, ready to put on the wire.
 */
export function makeReading(sensorType: string, fields: Partial<SdkReading>): SdkReading {
  return {
    sensorType,
    timeStamp: new Date().toISOString(),
    status: "",
    index: READING_INDEX,
    count: READING_COUNT,
    tempAmbient: null,
    tempObject: null,
    pulseRate: null,
    spo2: null,
    ecgData: null,
    ...fields,
  };
}
