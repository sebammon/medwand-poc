package com.medwand.poc.bridge

import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.medwand.poc.device.CameraFrame
import com.medwand.poc.device.CameraMode
import com.medwand.poc.device.Capture
import com.medwand.poc.device.Device
import com.medwand.poc.device.DeviceErrorCode
import com.medwand.poc.device.DeviceException
import com.medwand.poc.device.DeviceSnapshot
import com.medwand.poc.device.Sensor
import com.medwand.poc.device.SensorOptions
import com.medwand.poc.device.StethMode
import com.medwand.sdk_core.Core.MedWandReading
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * The transport bridge between the web app and the [MedWandDevice].
 *
 * Uses the modern WebMessageListener channel: the frontend talks to
 * `window.MedWand.postMessage(...)` / `.onmessage`, scoped to the app's
 * first-party origin only. Commands arrive as JSON strings; replies and events
 * go back as JSON strings (captures are `capture` events carrying a base64
 * `data:` URI).
 *
 * Live **camera frames** are the one exception: when the WebView supports it
 * ([WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER]) each JPEG frame is posted as a raw
 * **`ArrayBuffer`** — no base64, no JSON — and the frontend treats any binary
 * message as a frame. Older WebViews fall back to a base64 `frame` event.
 *
 * This class only translates the protocol; all hardware behaviour lives in
 * [MedWandDevice], which it drives and observes.
 */
class MedWandBridge(
    private val device: Device,
    private val scope: CoroutineScope,
    private val ensureAudioPermission: suspend () -> Boolean,
    private val ensureCameraPermission: suspend () -> Boolean,
    // Whether camera frames can be shipped as raw binary array buffers instead of
    // base64. Decided once; the frontend infers the transport from message type.
    // Defaults to the WebView's real capability; pass `false` to force the base64
    // fallback — to compare the two transports on a device, or to test either path.
    private val arrayBufferSupported: Boolean =
        WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER),
) : WebViewCompat.WebMessageListener, Device.Listener {

    private val mainHandler = Handler(Looper.getMainLooper())
    private var replyProxy: JavaScriptReplyProxy? = null

    init {
        device.listener = this
    }

    /** Registers `window.MedWand` on [webView], scoped to [allowedOrigin]. */
    fun register(webView: WebView, allowedOrigin: String): Boolean {
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(webView, JS_OBJECT_NAME, setOf(allowedOrigin), this)
            Log.i(
                TAG,
                "Camera frame transport: ${if (arrayBufferSupported) "binary array-buffer" else "base64 fallback"}."
            )
            return true
        }
        Log.e(TAG, "WebView lacks WEB_MESSAGE_LISTENER support.")
        return false
    }

    override fun onPostMessage(
        view: WebView,
        message: WebMessageCompat,
        sourceOrigin: Uri,
        isMainFrame: Boolean,
        replyProxy: JavaScriptReplyProxy,
    ) {
        this.replyProxy = replyProxy
        val raw = message.data ?: return
        val command = runCatching { JSONObject(raw) }.getOrNull() ?: return
        val id = command.optString("id")
        val cmd = command.optString("cmd")
        val args = command.optJSONObject("args") ?: JSONObject()

        scope.launch {
            try {
                val applied = dispatch(cmd, args)
                if (applied) postString(Protocol.replyOk(id))
                else postString(Protocol.replyBusy(id))
            } catch (e: DeviceException) {
                postString(Protocol.replyError(id, e.code.name, e.message ?: e.code.name))
            } catch (e: Exception) {
                postString(
                    Protocol.replyError(
                        id,
                        DeviceErrorCode.DEVICE_ERROR.name,
                        e.message ?: "Device error"
                    )
                )
            }
        }
    }

    private suspend fun dispatch(cmd: String, args: JSONObject): Boolean = when (cmd) {
        "getState" -> {
            onStateChanged(device.snapshot())
            true
        }

        "connect" -> {
            device.connect()
            true
        }

        "disconnect" -> {
            device.disconnect()
            true
        }

        "startSensor" -> {
            val sensor = Sensor.fromWire(args.optString("sensor"))
                ?: throw DeviceException(DeviceErrorCode.DEVICE_ERROR, "Unknown sensor.")
            val wireMode = args.optString("mode").ifEmpty { null }
            // Parse the wire `mode` into the field this sensor uses and gate the
            // permission it needs; the device validates that the mode is present.
            val options = when (sensor) {
                Sensor.Camera -> {
                    val mode = CameraMode.fromWire(wireMode) ?: throw DeviceException(
                        DeviceErrorCode.DEVICE_ERROR,
                        "Camera requires a mode (dermatoscope or otoscope)."
                    )
                    if (!ensureCameraPermission()) {
                        throw DeviceException(
                            DeviceErrorCode.DEVICE_ERROR,
                            "Camera permission is required for the otoscope/dermatoscope."
                        )
                    }
                    SensorOptions(cameraMode = mode)
                }

                Sensor.Stethoscope -> {
                    val mode = StethMode.fromWire(wireMode) ?: throw DeviceException(
                        DeviceErrorCode.DEVICE_ERROR,
                        "Stethoscope requires a mode (heart, lungs, or bowel)."
                    )
                    if (!ensureAudioPermission()) {
                        throw DeviceException(
                            DeviceErrorCode.DEVICE_ERROR,
                            "Microphone permission is required for the stethoscope."
                        )
                    }
                    SensorOptions(stethMode = mode)
                }

                else -> null
            }
            device.startSensor(sensor, options)
        }

        "stopSensor" -> device.stopSensor()

        "startRecording" -> device.startRecording()

        "stopRecording" -> device.stopRecording()

        // Camera-specific controls (only valid while a preview is running).
        "captureFrame" -> {
            device.captureCameraFrame()
            true
        }

        "cameraLed" -> {
            device.setCameraLed(args.optInt("value"))
            true
        }

        "cameraFocusMode" -> {
            device.setCameraFocusManual(args.optBoolean("manual"))
            true
        }

        "cameraFocusValue" -> {
            device.setCameraFocusValue(args.optInt("value"))
            true
        }

        "cameraMove" -> {
            val horizontal = if (args.has("horizontal")) args.optInt("horizontal") else null
            val vertical = if (args.has("vertical")) args.optInt("vertical") else null
            device.moveOtoscope(horizontal, vertical)
            true
        }

        "cameraZoom" -> {
            device.zoomOtoscope(args.optInt("direction"))
            true
        }

        "cameraRadius" -> {
            device.adjustOtoscopeRadius(args.optInt("direction"))
            true
        }

        "cameraReset" -> {
            device.resetCamera()
            true
        }

        else -> throw DeviceException(DeviceErrorCode.DEVICE_ERROR, "Unknown command: $cmd")
    }

    override fun onStateChanged(snapshot: DeviceSnapshot) {
        postString(Protocol.event("state", Protocol.snapshotJson(snapshot)))
    }

    override fun onReading(sensor: Sensor, reading: MedWandReading) {
        postString(Protocol.event("reading", Protocol.readingEventJson(sensor.wire, reading)))
    }

    override fun onCapture(capture: Capture) {
        postString(Protocol.event("capture", Protocol.captureJson(capture)))
    }

    override fun onCameraFrame(frame: CameraFrame) {
        if (arrayBufferSupported) {
            // Fast path: raw JPEG bytes as an ArrayBuffer. Any binary message on
            // this channel is a camera frame (the only binary traffic); the mode
            // rides in the `state` snapshot, so no envelope is needed.
            postBytes(frame.jpeg)
        } else {
            val dataUri =
                "data:image/jpeg;base64," + Base64.encodeToString(frame.jpeg, Base64.NO_WRAP)
            postString(Protocol.event("frame", Protocol.cameraFrameJson(frame, dataUri)))
        }
    }

    override fun onError(code: DeviceErrorCode, message: String) {
        postString(Protocol.errorEvent(code.name, message))
    }

    private fun postString(message: String) {
        mainHandler.post { runCatching { replyProxy?.postMessage(message) } }
    }

    // Posts raw bytes as an ArrayBuffer to the web side (camera frames). Shares
    // the reply proxy with postString, so ordering with string events is kept.
    private fun postBytes(bytes: ByteArray) {
        mainHandler.post { runCatching { replyProxy?.postMessage(bytes) } }
    }

    private companion object {
        const val TAG = "MedWandBridge"
        const val JS_OBJECT_NAME = "MedWand"
    }
}
