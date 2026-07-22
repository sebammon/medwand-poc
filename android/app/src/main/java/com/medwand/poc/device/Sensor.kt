package com.medwand.poc.device

import com.medwand.sdk_core.Core.EnumSensor
import com.medwand.sdk_core.Internal.CameraHelper
import com.medwand.sdk_core.Internal.StethoscopeHelpers.MicrophoneModes

/**
 * Sensors the app exposes, mapping the web protocol's wire names to the SDK
 * enum. The `wire` values are the strings the frontend sends in `startSensor`.
 */
enum class Sensor(val wire: String, val sdk: EnumSensor) {
    Thermometer("thermometer", EnumSensor.Thermometer),
    PulseOximeter("pulseOximeter", EnumSensor.PulseOximeter),
    Ecg("ecg", EnumSensor.Ecg),
    Stethoscope("stethoscope", EnumSensor.Stethoscope),
    Camera("camera", EnumSensor.Otoscope);

    companion object {
        fun fromWire(value: String?): Sensor? = entries.firstOrNull { it.wire == value }
    }
}

/** Camera preview modes exposed over the bridge (SDK `CameraModes`, minus Off). */
enum class CameraMode(val wire: String, val sdk: CameraHelper.CameraModes) {
    Dermatoscope("dermatoscope", CameraHelper.CameraModes.Dermatoscope),
    Otoscope("otoscope", CameraHelper.CameraModes.Otoscope);

    companion object {
        fun fromWire(value: String?): CameraMode? = entries.firstOrNull { it.wire == value }

        /** The wire string for any SDK camera mode, including `Off`. */
        fun wireOf(sdk: CameraHelper.CameraModes): String = when (sdk) {
            CameraHelper.CameraModes.Off -> "off"
            CameraHelper.CameraModes.Dermatoscope -> Dermatoscope.wire
            CameraHelper.CameraModes.Otoscope -> Otoscope.wire
        }
    }
}

/** Stethoscope auscultation modes exposed over the bridge. */
enum class StethMode(val wire: String, val sdk: MicrophoneModes) {
    Heart("heart", MicrophoneModes.Heart),
    Lungs("lungs", MicrophoneModes.Lungs),
    Bowel("bowel", MicrophoneModes.Bowel);

    companion object {
        fun fromWire(value: String?): StethMode? = entries.firstOrNull { it.wire == value }
    }
}

/**
 * Per-sensor start options, built by the bridge from the wire `mode`. Only the
 * stethoscope and camera need one — the others start with `null`.
 */
data class SensorOptions(
    val stethMode: StethMode? = null,
    val cameraMode: CameraMode? = null,
)
