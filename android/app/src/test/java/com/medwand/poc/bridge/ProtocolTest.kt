package com.medwand.poc.bridge

import com.medwand.poc.device.ActiveSensor
import com.medwand.poc.device.Capabilities
import com.medwand.poc.device.CameraFrame
import com.medwand.poc.device.Capture
import com.medwand.poc.device.DeviceInfo
import com.medwand.poc.device.DeviceSnapshot
import com.medwand.sdk_core.Core.MedWandReading
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.json.JSONObject
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.time.Instant

/**
 * Tests for the bridge wire contract ([Protocol]). Runs under Robolectric only
 * for a real `org.json.JSONObject` — the class is otherwise pure. Every message
 * the frontend receives is parsed back and asserted field-by-field (not by raw
 * string), so key ordering is irrelevant and `JSONObject.NULL` is checked via
 * `isNull(...)`.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ProtocolTest {

    @Test
    fun `event wraps the event name and data payload`() {
        val json = JSONObject(Protocol.event("state", JSONObject().put("k", "v")))
        assertEquals("state", json.getString("event"))
        assertEquals("v", json.getJSONObject("data").getString("k"))
    }

    @Test
    fun `replyOk echoes the id and carries no result`() {
        val data = replyData(Protocol.replyOk("cmd-1"))
        assertEquals("cmd-1", data.getString("id"))
        assertTrue(data.getBoolean("ok"))
        assertFalse(data.has("result"))
    }

    @Test
    fun `replyError is a not-ok reply with a typed code and message`() {
        val data =
            replyData(Protocol.replyError("cmd-3", "SENSOR_BUSY", "camera is already active."))
        assertEquals("cmd-3", data.getString("id"))
        assertFalse(data.getBoolean("ok"))
        val error = data.getJSONObject("error")
        assertEquals("SENSOR_BUSY", error.getString("code"))
        assertEquals("camera is already active.", error.getString("message"))
    }

    @Test
    fun `replyBusy is a not-ok reply with no error`() {
        val data = replyData(Protocol.replyBusy("cmd-4"))
        assertEquals("cmd-4", data.getString("id"))
        assertFalse(data.getBoolean("ok"))
        assertFalse(data.has("error"))
        assertFalse(data.has("result"))
    }

    @Test
    fun `errorEvent wraps the code and message`() {
        val json = JSONObject(Protocol.errorEvent("DEVICE_ERROR", "boom"))
        assertEquals("error", json.getString("event"))
        val data = json.getJSONObject("data")
        assertEquals("DEVICE_ERROR", data.getString("code"))
        assertEquals("boom", data.getString("message"))
    }

    @Test
    fun `snapshotJson serializes the full nested structure`() {
        val json = Protocol.snapshotJson(fullSnapshot())

        assertEquals("connected", json.getString("device"))
        assertEquals("active", json.getString("reading"))

        val active = json.getJSONObject("activeSensor")
        assertEquals("camera", active.getString("sensor"))
        assertEquals("otoscope", active.getString("mode"))
        assertTrue(active.getBoolean("monitoring"))
        assertEquals(100, active.getInt("ledMax"))
        assertEquals(40, active.getInt("ledIntensity"))
        assertTrue(active.getBoolean("ledAdjustable"))
        assertTrue(active.getBoolean("autoFocusAvailable"))
        assertTrue(active.getBoolean("manualFocusAvailable"))
        assertFalse(active.getBoolean("manualFocusEnabled"))
        assertEquals(12, active.getInt("focusValue"))
        assertEquals(255, active.getInt("focusValueMax"))

        val caps = json.getJSONObject("capabilities")
        assertTrue(caps.getBoolean("thermometer"))
        assertTrue(caps.getBoolean("pulseOximeter"))
        assertFalse(caps.getBoolean("ecg"))
        assertTrue(caps.getBoolean("stethoscope"))
        assertTrue(caps.getBoolean("camera"))

        val info = json.getJSONObject("deviceInfo")
        assertEquals("UDI-123", info.getString("udi"))
        assertEquals("1.2.3", info.getString("firmwareVersion"))
        assertEquals("2", info.getString("generation"))
        assertEquals("COM3", info.getString("comPort"))
        assertEquals("0x1234", info.getString("vendorId"))
        assertEquals("0x5678", info.getString("productId"))
    }

    @Test
    fun `snapshotJson emits JSON null for absent optional fields`() {
        val snapshot = fullSnapshot().copy(
            activeSensor = null,
            deviceInfo = DeviceInfo(
                udi = null,
                firmwareVersion = null,
                generation = null,
                comPort = null,
                vendorId = null,
                productId = null,
            ),
        )

        val json = Protocol.snapshotJson(snapshot)
        assertTrue(json.isNull("activeSensor"))

        val info = json.getJSONObject("deviceInfo")
        for (field in listOf(
            "udi",
            "firmwareVersion",
            "generation",
            "comPort",
            "vendorId",
            "productId"
        )) {
            assertTrue("expected deviceInfo.$field to be JSON null", info.isNull(field))
        }
    }

    @Test
    fun `readingJson serializes every reading field verbatim`() {
        val reading = MedWandReading().apply {
            sensorType = "Thermometer"
            timeStamp = Instant.ofEpochMilli(1_700_000_000_000)
            status = "OK"
            index = 3
            count = 10
            tempAmbient = "22.5"
            tempObject = "36.8"
            pulseRate = "72"
            spo2 = "98"
            ecgData = "1,2,3"
        }

        val json = Protocol.readingJson(reading)
        assertEquals("Thermometer", json.getString("sensorType"))
        assertEquals(reading.timeStamp.toString(), json.getString("timeStamp"))
        assertEquals("OK", json.getString("status"))
        assertEquals(3, json.getInt("index"))
        assertEquals(10, json.getInt("count"))
        assertEquals("22.5", json.getString("tempAmbient"))
        assertEquals("36.8", json.getString("tempObject"))
        assertEquals("72", json.getString("pulseRate"))
        assertEquals("98", json.getString("spo2"))
        assertEquals("1,2,3", json.getString("ecgData"))
    }

    @Test
    fun `readingJson emits JSON null for absent scalars but keeps index and count`() {
        // Every nullable string explicitly null exercises each `?: JSONObject.NULL`
        // branch. The primitive index/count stay at their 0 default and must
        // survive as real numbers, not null; timeStamp is a non-null Instant that
        // defaults to EPOCH, so it serializes rather than nulling out.
        val reading = MedWandReading().apply {
            sensorType = null
            status = null
            tempAmbient = null
            tempObject = null
            pulseRate = null
            spo2 = null
            ecgData = null
        }

        val json = Protocol.readingJson(reading)
        for (field in listOf(
            "sensorType", "status", "tempAmbient", "tempObject", "pulseRate", "spo2", "ecgData",
        )) {
            assertTrue("expected reading.$field to be JSON null", json.isNull(field))
        }
        assertEquals(Instant.EPOCH.toString(), json.getString("timeStamp"))
        assertEquals(0, json.getInt("index"))
        assertEquals(0, json.getInt("count"))
    }

    @Test
    fun `readingEventJson pairs the sensor wire name with the reading`() {
        val reading = MedWandReading().apply { spo2 = "97" }
        val json = Protocol.readingEventJson("pulseOximeter", reading)
        assertEquals("pulseOximeter", json.getString("sensor"))
        assertEquals("97", json.getJSONObject("reading").getString("spo2"))
    }

    @Test
    fun `captureJson includes the mode when present`() {
        val capture =
            Capture(sensor = "stethoscope", mode = "heart", dataUri = "data:audio/wav;base64,AAAA")
        val json = Protocol.captureJson(capture)
        assertEquals("stethoscope", json.getString("sensor"))
        assertEquals("heart", json.getString("mode"))
        assertEquals("data:audio/wav;base64,AAAA", json.getString("dataUri"))
    }

    @Test
    fun `captureJson omits the mode key entirely when null`() {
        // Distinct from a JSON null: a modeless capture (e.g. ECG) has no key.
        val capture = Capture(sensor = "ecg", mode = null, dataUri = "data:image/png;base64,AAAA")
        val json = Protocol.captureJson(capture)
        assertFalse(json.has("mode"))
        assertEquals("ecg", json.getString("sensor"))
        assertEquals("data:image/png;base64,AAAA", json.getString("dataUri"))
    }

    @Test
    fun `cameraFrameJson labels the frame as camera with dimensions and data uri`() {
        val frame = CameraFrame(
            mode = "dermatoscope",
            jpeg = byteArrayOf(1, 2, 3),
            width = 640,
            height = 480
        )
        val json = Protocol.cameraFrameJson(frame, "data:image/jpeg;base64,AQID")
        assertEquals("camera", json.getString("sensor"))
        assertEquals("dermatoscope", json.getString("mode"))
        assertEquals("data:image/jpeg;base64,AQID", json.getString("dataUri"))
        assertEquals(640, json.getInt("width"))
        assertEquals(480, json.getInt("height"))
    }

    /** Unwraps a `reply` envelope down to its `data` object. */
    private fun replyData(message: String): JSONObject {
        val json = JSONObject(message)
        assertEquals("reply", json.getString("event"))
        return json.getJSONObject("data")
    }

    @Test
    fun `snapshotJson serializes a stethoscope active sensor with its mode`() {
        val json =
            Protocol.snapshotJson(fullSnapshot().copy(activeSensor = ActiveSensor.Stethoscope("lungs")))
        val active = json.getJSONObject("activeSensor")
        assertEquals("stethoscope", active.getString("sensor"))
        assertEquals("lungs", active.getString("mode"))
    }

    @Test
    fun `snapshotJson serializes a plain active sensor as just its name`() {
        val json =
            Protocol.snapshotJson(fullSnapshot().copy(activeSensor = ActiveSensor.Plain("thermometer")))
        val active = json.getJSONObject("activeSensor")
        assertEquals("thermometer", active.getString("sensor"))
        assertFalse("a plain sensor carries no extra fields", active.has("mode"))
    }

    private fun fullSnapshot() = DeviceSnapshot(
        device = "connected",
        reading = "active",
        activeSensor = ActiveSensor.Camera(
            mode = "otoscope",
            monitoring = true,
            ledMax = 100,
            ledIntensity = 40,
            ledAdjustable = true,
            autoFocusAvailable = true,
            manualFocusAvailable = true,
            manualFocusEnabled = false,
            focusValue = 12,
            focusValueMax = 255,
        ),
        capabilities = Capabilities(
            thermometer = true,
            pulseOximeter = true,
            ecg = false,
            stethoscope = true,
            camera = true,
        ),
        deviceInfo = DeviceInfo(
            udi = "UDI-123",
            firmwareVersion = "1.2.3",
            generation = "2",
            comPort = "COM3",
            vendorId = "0x1234",
            productId = "0x5678",
        ),
    )
}
