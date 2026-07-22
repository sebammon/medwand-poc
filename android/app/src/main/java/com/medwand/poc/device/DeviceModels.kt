package com.medwand.poc.device

/** Stable error codes shared with the frontend (bridge doc §8). */
enum class DeviceErrorCode {
    SENSOR_BUSY,
    NOT_CONNECTED,
    USB_PERMISSION_DENIED,
    LICENSE_INVALID,
    DEVICE_ERROR,
}

/** A device operation that failed with one of the protocol's typed error codes. */
class DeviceException(
    val code: DeviceErrorCode,
    message: String,
) : Exception(message)

/** Immutable device/session snapshot (bridge doc §6). */
data class DeviceSnapshot(
    val device: String,
    val reading: String,
    val activeSensor: ActiveSensor?,
    val capabilities: Capabilities,
    val deviceInfo: DeviceInfo,
)

data class Capabilities(
    val thermometer: Boolean,
    val pulseOximeter: Boolean,
    val ecg: Boolean,
    val stethoscope: Boolean,
    val camera: Boolean,
)

/**
 * The currently-running sensor and the live, user-settable state that belongs to
 * it. Only one sensor runs at a time, so the snapshot carries a single tagged
 * value (or `null` when idle). The [sensor] wire name is the discriminator; the
 * frontend narrows on it. Sensors with nothing to set are [Plain]; the camera
 * and stethoscope carry their control state here rather than in a separate block.
 */
sealed class ActiveSensor(val sensor: String) {
    /**
     * Live camera control state, so the frontend can enable/disable and position
     * its controls the way the Developer Suite sample does. The ranges
     * (`ledMax`, `focusValueMax`, what's adjustable/available) live here with the
     * current values because they're only known while a preview runs and can
     * differ by mode — they're session state, not device capabilities.
     */
    data class Camera(
        val mode: String,            // off | dermatoscope | otoscope
        val monitoring: Boolean,
        val ledMax: Int,
        val ledIntensity: Int,
        val ledAdjustable: Boolean,
        val autoFocusAvailable: Boolean,
        val manualFocusAvailable: Boolean,
        val manualFocusEnabled: Boolean,
        val focusValue: Int,
        val focusValueMax: Int,
    ) : ActiveSensor("camera")

    /** Live auscultation: the only user-settable state is the mode. */
    data class Stethoscope(val mode: String) : ActiveSensor("stethoscope")

    /** Thermometer, pulse oximeter, ECG — running, with nothing to set. */
    class Plain(sensor: String) : ActiveSensor(sensor)
}

/**
 * A single live camera preview frame as compressed **JPEG bytes**. The transport
 * (bridge) decides how to ship it: raw over the WebView array-buffer channel when
 * supported, or base64 in a `frame` event as a fallback. Streamed (throttled),
 * distinct from the one-shot recorded still delivered as a `capture`.
 */
data class CameraFrame(
    val mode: String,
    val jpeg: ByteArray,
    val width: Int,
    val height: Int,
)

data class DeviceInfo(
    val udi: String?,
    val firmwareVersion: String?,
    val generation: String?,
    val comPort: String?,
    val vendorId: String?,
    val productId: String?,
)

/**
 * A recorded artifact ready to hand to the frontend: an ECG strip or a
 * stethoscope clip as the SDK's `data:<mime>;base64,...` URI, usable directly
 * as an <img>/<audio> source.
 */
data class Capture(
    val sensor: String,
    val mode: String?,
    val dataUri: String,
)
