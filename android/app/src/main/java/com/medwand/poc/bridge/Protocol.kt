package com.medwand.poc.bridge

import com.medwand.poc.device.ActiveSensor
import com.medwand.poc.device.Capture
import com.medwand.poc.device.CameraFrame
import com.medwand.poc.device.DeviceSnapshot
import com.medwand.sdk_core.Core.MedWandReading
import org.json.JSONObject

/**
 * Serialization for the bridge envelope (bridge doc §2). All web ↔ native JSON
 * passes through here; nothing else builds protocol strings by hand.
 */
object Protocol {

    /** Every native → web message is a uniform `{ event, data }` envelope. */
    fun event(event: String, data: JSONObject): String =
        JSONObject().apply {
            put("event", event)
            put("data", data)
        }.toString()

    /** A command reply is just a `reply` event whose data echoes the command id. */
    fun replyOk(id: String, result: JSONObject = JSONObject()): String =
        event("reply", JSONObject().put("id", id).put("ok", true).put("result", result))

    fun replyError(id: String, code: String, message: String): String =
        event(
            "reply",
            JSONObject().put("id", id).put("ok", false)
                .put("error", JSONObject().put("code", code).put("message", message)),
        )

    fun errorEvent(code: String, message: String): String =
        event("error", JSONObject().put("code", code).put("message", message))

    fun snapshotJson(snapshot: DeviceSnapshot): JSONObject = JSONObject().apply {
        put("device", snapshot.device)
        put("reading", snapshot.reading)
        put("activeSensor", snapshot.activeSensor?.let { activeSensorJson(it) } ?: JSONObject.NULL)
        put(
            "capabilities",
            JSONObject().apply {
                put("thermometer", snapshot.capabilities.thermometer)
                put("pulseOximeter", snapshot.capabilities.pulseOximeter)
                put("ecg", snapshot.capabilities.ecg)
                put("stethoscope", snapshot.capabilities.stethoscope)
                put("camera", snapshot.capabilities.camera)
            },
        )
        put(
            "deviceInfo",
            JSONObject().apply {
                put("udi", snapshot.deviceInfo.udi ?: JSONObject.NULL)
                put("firmwareVersion", snapshot.deviceInfo.firmwareVersion ?: JSONObject.NULL)
                put("generation", snapshot.deviceInfo.generation ?: JSONObject.NULL)
                put("comPort", snapshot.deviceInfo.comPort ?: JSONObject.NULL)
                put("vendorId", snapshot.deviceInfo.vendorId ?: JSONObject.NULL)
                put("productId", snapshot.deviceInfo.productId ?: JSONObject.NULL)
            },
        )
    }

    /**
     * The active sensor as `{ sensor, ...settings }`. `sensor` is the
     * discriminator the frontend narrows on; the camera and stethoscope add their
     * live control fields, plain sensors add nothing.
     */
    private fun activeSensorJson(active: ActiveSensor): JSONObject = JSONObject().apply {
        put("sensor", active.sensor)
        when (active) {
            is ActiveSensor.Camera -> {
                put("mode", active.mode)
                put("monitoring", active.monitoring)
                put("ledMax", active.ledMax)
                put("ledIntensity", active.ledIntensity)
                put("ledAdjustable", active.ledAdjustable)
                put("autoFocusAvailable", active.autoFocusAvailable)
                put("manualFocusAvailable", active.manualFocusAvailable)
                put("manualFocusEnabled", active.manualFocusEnabled)
                put("focusValue", active.focusValue)
                put("focusValueMax", active.focusValueMax)
            }
            is ActiveSensor.Stethoscope -> put("mode", active.mode)
            is ActiveSensor.Plain -> {}
        }
    }

    /**
     * A `reading` event: `{ sensor, reading }` where `sensor` is our sensor name
     * and `reading` is the SDK's `MedWandReading` (§5).
     */
    fun readingEventJson(sensor: String, reading: MedWandReading): JSONObject = JSONObject().apply {
        put("sensor", sensor)
        put("reading", readingJson(reading))
    }

    /**
     * The SDK's `MedWandReading` serialized **verbatim** — every field, including
     * empty strings and nulls — so the frontend (and debugging) see exactly what
     * the device emitted: `index`/`count` position, raw `ecgData`, and the rest.
     * Scalars stay as the SDK's own strings; the frontend parses them.
     */
    fun readingJson(reading: MedWandReading): JSONObject = JSONObject().apply {
        put("sensorType", reading.sensorType ?: JSONObject.NULL)
        put("timeStamp", reading.timeStamp?.toString() ?: JSONObject.NULL)
        put("status", reading.status ?: JSONObject.NULL)
        put("index", reading.index)
        put("count", reading.count)
        put("tempAmbient", reading.tempAmbient ?: JSONObject.NULL)
        put("tempObject", reading.tempObject ?: JSONObject.NULL)
        put("pulseRate", reading.pulseRate ?: JSONObject.NULL)
        put("spo2", reading.spo2 ?: JSONObject.NULL)
        put("ecgData", reading.ecgData ?: JSONObject.NULL)
    }

    /**
     * A recorded capture as a `capture` event. The SDK already produces a
     * base64 `data:` URI, so it is forwarded as-is for the frontend to use
     * directly as an <img>/<audio> source.
     */
    fun captureJson(capture: Capture): JSONObject = JSONObject().apply {
        put("sensor", capture.sensor)
        capture.mode?.let { put("mode", it) }
        put("dataUri", capture.dataUri)
    }

    /**
     * A live camera preview frame as a `frame` event: a JPEG `data:` URI plus the
     * frame dimensions. This is the **base64 fallback** used only when the WebView
     * lacks array-buffer support; the fast path ships the JPEG bytes raw over the
     * binary channel instead. High-frequency, so kept off the `reading`/`capture`
     * channels either way.
     */
    fun cameraFrameJson(frame: CameraFrame, dataUri: String): JSONObject = JSONObject().apply {
        put("sensor", "camera")
        put("mode", frame.mode)
        put("dataUri", dataUri)
        put("width", frame.width)
        put("height", frame.height)
    }
}
