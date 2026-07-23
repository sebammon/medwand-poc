package com.medwand.poc.device

import com.medwand.sdk_core.Core.MedWandReading

/**
 * The device operations and events the bridge drives and observes. [MedWandDevice]
 * is the production implementation backed by the SDK; tests supply a fake so the
 * bridge's protocol handling can be exercised without any hardware or Android SDK.
 *
 * Only the surface the bridge uses lives here — host-lifecycle calls such as USB
 * monitoring stay on the concrete [MedWandDevice].
 */
interface Device {

    /** Device activity, emitted on whatever thread produced it. */
    interface Listener {
        fun onStateChanged(snapshot: DeviceSnapshot)
        fun onReading(sensor: Sensor, reading: MedWandReading)
        fun onCapture(capture: Capture)
        fun onCameraFrame(frame: CameraFrame)
        fun onError(code: DeviceErrorCode, message: String)
    }

    var listener: Listener?

    fun snapshot(): DeviceSnapshot
    fun destroy()

    suspend fun connect()
    suspend fun disconnect()
    suspend fun startSensor(sensor: Sensor, options: SensorOptions?): Boolean
    suspend fun stopSensor(): Boolean
    suspend fun startRecording(): Boolean
    suspend fun stopRecording(): Boolean
    suspend fun captureCameraFrame()
    suspend fun setCameraLed(value: Int)
    suspend fun setCameraFocusManual(enabled: Boolean)
    suspend fun setCameraFocusValue(value: Int)
    suspend fun moveOtoscope(horizontal: Int?, vertical: Int?)
    suspend fun zoomOtoscope(direction: Int)
    suspend fun adjustOtoscopeRadius(direction: Int)
    suspend fun resetCamera()
}
