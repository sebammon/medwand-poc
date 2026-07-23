package com.medwand.poc.bridge

import android.net.Uri
import android.os.Looper
import android.util.Base64
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import com.medwand.poc.device.Capabilities
import com.medwand.poc.device.CameraFrame
import com.medwand.poc.device.CameraMode
import com.medwand.poc.device.Capture
import com.medwand.poc.device.Device
import com.medwand.poc.device.DeviceErrorCode
import com.medwand.poc.device.DeviceException
import com.medwand.poc.device.DeviceInfo
import com.medwand.poc.device.DeviceSnapshot
import com.medwand.poc.device.Sensor
import com.medwand.poc.device.SensorOptions
import com.medwand.poc.device.StethMode
import com.medwand.sdk_core.Core.MedWandReading
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * Tests for [MedWandBridge]: JSON command parsing and dispatch, typed error
 * mapping, permission gating, and the events/replies posted back to the web side.
 *
 * The SDK-backed device is replaced by a [FakeDevice] injected through the
 * [Device] seam, and the web side by a [RecordingReplyProxy] that captures every
 * posted message. Robolectric supplies the real `org.json`, `Base64`, `Looper`,
 * and a `WebView` instance (the bridge never touches the view, only needs one to
 * satisfy the callback signature). Dispatch runs on [Dispatchers.Unconfined] so
 * the fake's non-suspending calls complete inline; posts are then flushed by
 * idling the main looper.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MedWandBridgeTest {

    private val scope = CoroutineScope(Dispatchers.Unconfined)
    private val replyProxy = RecordingReplyProxy()
    private lateinit var webView: WebView
    private lateinit var fake: FakeDevice
    private lateinit var bridge: MedWandBridge

    @Before
    fun setUp() {
        webView = WebView(RuntimeEnvironment.getApplication())
        fake = FakeDevice()
        bridge = newBridge(fake)
    }

    @Test
    fun `getState broadcasts a state event and replies ok`() {
        fake.nextSnapshot = sampleSnapshot(device = "connected")

        bridge.send("""{"id":"c1","cmd":"getState"}""")

        assertEquals("connected", firstEventData("state").getString("device"))
        val reply = lastReplyData()
        assertEquals("c1", reply.getString("id"))
        assertTrue(reply.getBoolean("ok"))
        assertFalse(reply.has("result"))
    }

    @Test
    fun `connect drives the device and replies ok with no snapshot`() {
        bridge.send("""{"id":"c2","cmd":"connect"}""")

        assertEquals(listOf("connect"), fake.calls)
        val data = lastReplyData()
        assertTrue(data.getBoolean("ok"))
        assertFalse(data.has("result"))
    }

    @Test
    fun `disconnect drives the device disconnect and replies ok with no snapshot`() {
        bridge.send("""{"id":"c3","cmd":"disconnect"}""")

        assertEquals(listOf("disconnect"), fake.calls)
        val data = lastReplyData()
        assertTrue(data.getBoolean("ok"))
        assertFalse(data.has("result"))
    }

    @Test
    fun `an unknown command replies with a DEVICE_ERROR`() {
        bridge.send("""{"id":"c4","cmd":"teleport"}""")

        val error = lastReplyData().also { assertFalse(it.getBoolean("ok")) }.getJSONObject("error")
        assertEquals("DEVICE_ERROR", error.getString("code"))
        assertTrue(error.getString("message").contains("teleport"))
    }

    @Test
    fun `a DeviceException is echoed back with its own typed code`() {
        fake.failWith = DeviceException(DeviceErrorCode.SENSOR_BUSY, "camera is already active.")

        bridge.send("""{"id":"c5","cmd":"connect"}""")

        val error = lastReplyData().getJSONObject("error")
        assertEquals("SENSOR_BUSY", error.getString("code"))
        assertEquals("camera is already active.", error.getString("message"))
    }

    @Test
    fun `a generic failure is mapped to DEVICE_ERROR keeping its message`() {
        fake.failWith = RuntimeException("kaboom")

        bridge.send("""{"id":"c6","cmd":"stopSensor"}""")

        val error = lastReplyData().getJSONObject("error")
        assertEquals("DEVICE_ERROR", error.getString("code"))
        assertEquals("kaboom", error.getString("message"))
    }

    @Test
    fun `a dropped command replies busy with no error`() {
        fake.applied = false

        bridge.send("""{"id":"c6b","cmd":"stopSensor"}""")

        assertEquals(listOf("stopSensor"), fake.calls)
        val data = lastReplyData()
        assertFalse(data.getBoolean("ok"))
        assertFalse(data.has("error"))
        assertFalse(data.has("result"))
    }

    @Test
    fun `startSensor camera parses the mode and forwards it after the permission check`() {
        bridge.send("""{"id":"c7","cmd":"startSensor","args":{"sensor":"camera","mode":"otoscope"}}""")

        assertEquals(
            listOf(Sensor.Camera to SensorOptions(cameraMode = CameraMode.Otoscope)),
            fake.startSensorCalls,
        )
        assertTrue(lastReplyData().getBoolean("ok"))
    }

    @Test
    fun `startSensor camera without a mode fails and never touches the device`() {
        bridge.send("""{"id":"c8","cmd":"startSensor","args":{"sensor":"camera"}}""")

        assertTrue(fake.startSensorCalls.isEmpty())
        val error = lastReplyData().getJSONObject("error")
        assertEquals("DEVICE_ERROR", error.getString("code"))
        assertTrue(error.getString("message").contains("mode"))
    }

    @Test
    fun `startSensor camera is rejected when camera permission is denied`() {
        bridge = newBridge(fake, ensureCamera = { false })

        bridge.send("""{"id":"c9","cmd":"startSensor","args":{"sensor":"camera","mode":"otoscope"}}""")

        assertTrue(fake.startSensorCalls.isEmpty())
        assertEquals("DEVICE_ERROR", lastReplyData().getJSONObject("error").getString("code"))
    }

    @Test
    fun `startSensor stethoscope parses the mode and forwards it after the permission check`() {
        bridge.send("""{"id":"c10","cmd":"startSensor","args":{"sensor":"stethoscope","mode":"heart"}}""")

        assertEquals(
            listOf(Sensor.Stethoscope to SensorOptions(stethMode = StethMode.Heart)),
            fake.startSensorCalls,
        )
        assertTrue(lastReplyData().getBoolean("ok"))
    }

    @Test
    fun `startSensor stethoscope is rejected when microphone permission is denied`() {
        bridge = newBridge(fake, ensureAudio = { false })

        bridge.send("""{"id":"c11","cmd":"startSensor","args":{"sensor":"stethoscope","mode":"heart"}}""")

        assertTrue(fake.startSensorCalls.isEmpty())
        assertEquals("DEVICE_ERROR", lastReplyData().getJSONObject("error").getString("code"))
    }

    @Test
    fun `startSensor for a mode-less sensor forwards null options and needs no permission`() {
        bridge.send("""{"id":"c12","cmd":"startSensor","args":{"sensor":"thermometer"}}""")

        assertEquals(
            listOf<Pair<Sensor, SensorOptions?>>(Sensor.Thermometer to null),
            fake.startSensorCalls
        )
        assertTrue(lastReplyData().getBoolean("ok"))
    }

    @Test
    fun `startSensor with an unknown sensor fails and never touches the device`() {
        bridge.send("""{"id":"c13","cmd":"startSensor","args":{"sensor":"tricorder"}}""")

        assertTrue(fake.startSensorCalls.isEmpty())
        assertEquals("DEVICE_ERROR", lastReplyData().getJSONObject("error").getString("code"))
    }

    @Test
    fun `cameraLed forwards the requested intensity`() {
        bridge.send("""{"id":"c14","cmd":"cameraLed","args":{"value":42}}""")

        assertEquals(42, fake.ledValue)
        assertTrue(lastReplyData().getBoolean("ok"))
    }

    @Test
    fun `cameraMove passes only the axes present in the command`() {
        // Only horizontal is sent; vertical must arrive as null, not 0.
        bridge.send("""{"id":"c15","cmd":"cameraMove","args":{"horizontal":2}}""")

        assertEquals(2 to null, fake.moveArgs)
        assertTrue(lastReplyData().getBoolean("ok"))
    }

    @Test
    fun `onReading posts a reading event carrying the sensor wire name`() {
        installProxy()
        val reading = MedWandReading().apply { spo2 = "97"; pulseRate = "70" }

        bridge.onReading(Sensor.PulseOximeter, reading)
        idle()

        val data = lastEvent("reading")
        assertEquals("pulseOximeter", data.getString("sensor"))
        assertEquals("97", data.getJSONObject("reading").getString("spo2"))
    }

    @Test
    fun `onCameraFrame ships raw jpeg bytes when array buffers are supported`() {
        bridge = newBridge(fake, arrayBufferSupported = true)
        installProxy()
        val jpeg = byteArrayOf(9, 8, 7, 6)

        bridge.onCameraFrame(CameraFrame(mode = "otoscope", jpeg = jpeg, width = 320, height = 240))
        idle()

        assertTrue(
            "no string message should be posted on the binary path",
            replyProxy.strings.isEmpty()
        )
        assertEquals(1, replyProxy.bytes.size)
        assertArrayEquals(jpeg, replyProxy.bytes.last())
    }

    @Test
    fun `onCameraFrame emits a base64 frame event when array buffers are unsupported`() {
        bridge = newBridge(fake, arrayBufferSupported = false)
        installProxy()
        val jpeg = byteArrayOf(1, 2, 3, 4)

        bridge.onCameraFrame(
            CameraFrame(
                mode = "dermatoscope",
                jpeg = jpeg,
                width = 640,
                height = 480
            )
        )
        idle()

        assertTrue(
            "no binary message should be posted on the base64 path",
            replyProxy.bytes.isEmpty()
        )
        val data = lastEvent("frame")
        assertEquals("camera", data.getString("sensor"))
        assertEquals("dermatoscope", data.getString("mode"))
        assertEquals(640, data.getInt("width"))
        assertEquals(480, data.getInt("height"))
        val uri = data.getString("dataUri")
        assertTrue(uri.startsWith("data:image/jpeg;base64,"))
        val decoded = Base64.decode(uri.removePrefix("data:image/jpeg;base64,"), Base64.NO_WRAP)
        assertArrayEquals(jpeg, decoded)
    }

    @Test
    fun `onCapture posts a capture event`() {
        installProxy()

        bridge.onCapture(
            Capture(
                sensor = "ecg",
                mode = null,
                dataUri = "data:image/png;base64,AAAA"
            )
        )
        idle()

        val data = lastEvent("capture")
        assertEquals("ecg", data.getString("sensor"))
        assertEquals("data:image/png;base64,AAAA", data.getString("dataUri"))
    }

    @Test
    fun `onStateChanged posts a state event`() {
        installProxy()

        bridge.onStateChanged(sampleSnapshot(device = "attached"))
        idle()

        assertEquals("attached", lastEvent("state").getString("device"))
    }

    @Test
    fun `onError posts an error event with the typed code`() {
        installProxy()

        bridge.onError(DeviceErrorCode.NOT_CONNECTED, "not connected")
        idle()

        val data = lastEvent("error")
        assertEquals("NOT_CONNECTED", data.getString("code"))
        assertEquals("not connected", data.getString("message"))
    }

    private fun newBridge(
        device: Device,
        arrayBufferSupported: Boolean = false,
        ensureAudio: suspend () -> Boolean = { true },
        ensureCamera: suspend () -> Boolean = { true },
    ) = MedWandBridge(device, scope, ensureAudio, ensureCamera, arrayBufferSupported)

    /** Delivers a command through the WebMessage callback and flushes the reply. */
    private fun MedWandBridge.send(json: String) {
        onPostMessage(webView, WebMessageCompat(json), Uri.EMPTY, true, replyProxy)
        idle()
    }

    /** Registers the reply proxy (via any command) then clears the setup traffic. */
    private fun installProxy() {
        bridge.send("""{"id":"install","cmd":"getState"}""")
        replyProxy.strings.clear()
        replyProxy.bytes.clear()
    }

    private fun idle() = shadowOf(Looper.getMainLooper()).idle()

    private fun lastReplyData(): JSONObject = lastEvent("reply")

    /** Parses the last posted string and asserts its envelope event name. */
    private fun lastEvent(event: String): JSONObject {
        val json = JSONObject(replyProxy.strings.last())
        assertEquals(event, json.getString("event"))
        return json.getJSONObject("data")
    }

    /** The data of the first posted message of the given event type. */
    private fun firstEventData(event: String): JSONObject =
        replyProxy.strings.map { JSONObject(it) }.first { it.getString("event") == event }
            .getJSONObject("data")

    /** Records every message the bridge posts back to the web side. */
    private class RecordingReplyProxy : JavaScriptReplyProxy() {
        val strings = mutableListOf<String>()
        val bytes = mutableListOf<ByteArray>()

        override fun postMessage(message: String) {
            strings.add(message)
        }

        override fun postMessage(arrayBuffer: ByteArray) {
            bytes.add(arrayBuffer)
        }
    }

    /**
     * In-memory [Device] that records how the bridge drives it. [failWith], when
     * set, is thrown by every action call to exercise the bridge's error mapping.
     */
    private class FakeDevice : Device {
        override var listener: Device.Listener? = null
        var nextSnapshot: DeviceSnapshot = sampleSnapshot()
        var failWith: Exception? = null
        var applied = true

        val calls = mutableListOf<String>()
        val startSensorCalls = mutableListOf<Pair<Sensor, SensorOptions?>>()
        var ledValue: Int? = null
        var focusManual: Boolean? = null
        var focusValue: Int? = null
        var moveArgs: Pair<Int?, Int?>? = null
        var zoomDirection: Int? = null
        var radiusDirection: Int? = null

        private fun record(name: String) {
            calls.add(name)
            failWith?.let { throw it }
        }

        override fun snapshot(): DeviceSnapshot = nextSnapshot
        override fun destroy() = record("destroy")
        override suspend fun connect() = record("connect")
        override suspend fun disconnect() = record("disconnect")
        override suspend fun startSensor(sensor: Sensor, options: SensorOptions?): Boolean {
            startSensorCalls.add(sensor to options)
            record("startSensor")
            return applied
        }

        override suspend fun stopSensor(): Boolean {
            record("stopSensor")
            return applied
        }

        override suspend fun startRecording(): Boolean {
            record("startRecording")
            return applied
        }

        override suspend fun stopRecording(): Boolean {
            record("stopRecording")
            return applied
        }
        override suspend fun captureCameraFrame() = record("captureFrame")
        override suspend fun setCameraLed(value: Int) {
            ledValue = value
            record("cameraLed")
        }

        override suspend fun setCameraFocusManual(enabled: Boolean) {
            focusManual = enabled
            record("cameraFocusMode")
        }

        override suspend fun setCameraFocusValue(value: Int) {
            focusValue = value
            record("cameraFocusValue")
        }

        override suspend fun moveOtoscope(horizontal: Int?, vertical: Int?) {
            moveArgs = horizontal to vertical
            record("cameraMove")
        }

        override suspend fun zoomOtoscope(direction: Int) {
            zoomDirection = direction
            record("cameraZoom")
        }

        override suspend fun adjustOtoscopeRadius(direction: Int) {
            radiusDirection = direction
            record("cameraRadius")
        }

        override suspend fun resetCamera() = record("cameraReset")
    }
}

/** A minimal snapshot; only [device] varies across the assertions here. */
private fun sampleSnapshot(device: String = "detached") = DeviceSnapshot(
    device = device,
    reading = "idle",
    activeSensor = null,
    capabilities = Capabilities(
        thermometer = true,
        pulseOximeter = true,
        ecg = false,
        stethoscope = false,
        camera = false,
    ),
    deviceInfo = DeviceInfo(
        udi = null,
        firmwareVersion = null,
        generation = null,
        comPort = null,
        vendorId = null,
        productId = null,
    ),
)
