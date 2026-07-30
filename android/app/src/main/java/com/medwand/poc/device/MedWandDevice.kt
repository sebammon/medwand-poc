package com.medwand.poc.device

import android.content.Context
import android.hardware.usb.UsbManager
import com.medwand.poc.device.Device.Listener
import com.medwand.sdk_core.Internal.CameraHelper
import com.medwand.sdk_core.Internal.StethoscopeHelpers.MicrophoneModes
import com.medwand.sdk_core.MedWandController
import com.medwand.sdk_core.Modules.EcgRenderTarget
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/**
 * Owns the MedWand SDK controller and its lifecycle. This is the hardware layer:
 * it knows nothing about JSON, WebViews, or the bridge protocol. Callers drive
 * it with plain domain calls and observe device activity through [Listener].
 *
 * SDK call sequences mirror the (tested) MedWand Developer Suite sample so the
 * behaviour matches the reference integration exactly.
 */
class MedWandDevice(
    private val context: Context,
    private val license: String,
    private val publicKey: String,
) : Device {

    // Published from the bridge on the main thread but read on SDK/encoder
    // threads (frame encode, reading/state callbacks), so publish it safely.
    @Volatile
    override var listener: Listener? = null

    // Serializes connect/disconnect so a teardown can't interleave an in-flight connect.
    private val opLock = Mutex()

    private val usbPermission = UsbPermissionRequester(context)
    private var controller: MedWandController? = null
    private var activeSensor: Sensor? = null
    private var stethMode: StethMode? = null
    private var cameraMode: CameraMode? = null

    // Live camera preview plumbing. The SDK's frame handler delivers processed
    // ARGB bytes with no dimensions, so [cameraPreview] records the size the
    // camera reports and [framePipeline] JPEG-encodes each frame off the SDK
    // thread with a drop-on-busy guard. The pipeline forwards encoded frames to
    // the listener.
    // Written on Dispatchers.IO when a preview starts/stops, but read on the
    // SDK's camera-frame thread (setCameraFrameHandler), so publish it safely.
    @Volatile
    private var cameraPreview: SizedUvcCameraPreviewTarget? = null
    private val framePipeline = CameraFramePipeline(AndroidFrameCodec()).apply {
        onFrame = { frame -> listener?.onCameraFrame(frame) }
    }

    // The SDK doesn't report a physical unplug, so we watch the OS USB broadcasts
    // and reconcile our state when the MedWand attaches or detaches.
    private val hotplug = UsbHotplugMonitor(
        context,
        onAttached = { emitState() },
        onDetached = { onDeviceDetached() },
    )

    // The SDK renders ECG frames into a target; the app ignores those frames and
    // plots the dimensionless `ecgData` on the frontend instead. This sink keeps
    // the SDK's render path valid without drawing anything.
    private val ecgRenderSink = object : EcgRenderTarget {
        override val width: Int get() = 1
        override val height: Int get() = 1
        override fun render(imageBytes: ByteArray) = Unit
    }

    /**
     * Connects and initializes the device: validate the license, obtain USB
     * permission, open the device, initialize it, and wire SDK callbacks.
     * Throws [DeviceException] with a typed code on any failure.
     */
    override suspend fun connect() = opLock.withLock {
        withContext(Dispatchers.IO) {
            if (license.isEmpty() || publicKey.isEmpty()) {
                throw DeviceException(
                    DeviceErrorCode.LICENSE_INVALID,
                    "Missing MedWand license configuration."
                )
            }

            val usbManager = context.getSystemService(Context.USB_SERVICE) as UsbManager
            val controller = this@MedWandDevice.controller ?: MedWandController(usbManager).also {
                this@MedWandDevice.controller = it
            }

            controller.onLicenseError =
                { state -> emitError(DeviceErrorCode.LICENSE_INVALID, "License error: $state") }
            controller.construct(license, publicKey)
            if (!controller.isLicenseValid) {
                throw DeviceException(
                    DeviceErrorCode.LICENSE_INVALID,
                    "The MedWand license is not valid."
                )
            }

            if (!usbPermission.ensurePermission(usbManager)) {
                throw DeviceException(
                    DeviceErrorCode.USB_PERMISSION_DENIED,
                    "USB permission denied."
                )
            }

            controller.connect()
            if (!controller.isConnected) {
                throw DeviceException(
                    DeviceErrorCode.NOT_CONNECTED,
                    "MedWand not found. Connect the device and try again."
                )
            }

            controller.initialize()
            if (!controller.isInitialized) {
                throw DeviceException(DeviceErrorCode.DEVICE_ERROR, "MedWand failed to initialize.")
            }

            // Attach the sensor handlers
            controller.configure(ecgRenderSink)
            controller.ecg?.onRecordedStripReady = { raw -> onEcgStripReady(raw) }
            controller.stethoscope?.onRecordedFramesReady = { raw -> onStethFramesReady(raw) }

            // setCameraFrameHandler creates the camera module, so the recorded-frame
            // handler can be attached straight after. The SDK delivers dimensionless
            // ARGB bytes, so the size the camera reported ([cameraPreview]) is read
            // back here and handed to the pipeline.
            controller.setCameraFrameHandler { frameBytes ->
                val target = cameraPreview ?: return@setCameraFrameHandler
                framePipeline.submit(frameBytes, target.frameWidth, target.frameHeight)
            }
            controller.camera?.onRecordedFrameReady = { frameBytes -> onCameraCapture(frameBytes) }

            // Route ongoing SDK events into the listener.
            controller.onDeviceError = { error ->
                // Unplugging mid-reading makes the SDK's next I/O fail, surfacing as a
                // device error. That's not a real fault — it's the detach, already
                // reported as a `state` change — so swallow it when the MedWand is no
                // longer attached. A genuine error while still plugged in is emitted.
                if (isMedWandAttached()) {
                    emitError(DeviceErrorCode.DEVICE_ERROR, error?.toString() ?: "Device error")
                }
            }
            controller.onDeviceStateChanged = { emitState() }
            controller.onReadingStateChanged = { emitState() }
            // Only one sensor runs at a time, so a reading always belongs to the
            // active sensor — no need to re-derive it from the reading itself.
            controller.onReadingReceived = { reading ->
                activeSensor?.let { sensor -> listener?.onReading(sensor, reading) }
            }

            emitState()
        }
    }

    /**
     * Tears the device down for a user disconnect. Serialized against [connect]
     * via [opLock] so rapid connect/disconnect toggling can't interleave; the
     * teardown itself is [destroy].
     */
    override suspend fun disconnect() = opLock.withLock {
        destroy()
        emitState()
    }

    private suspend fun withLockOrDrop(block: suspend () -> Unit): Boolean {
        if (!opLock.tryLock()) return false
        try {
            block()
        } finally {
            opLock.unlock()
        }
        return true
    }

    /** Starts a sensor. Only one runs at a time (bridge doc §3). */
    override suspend fun startSensor(sensor: Sensor, options: SensorOptions?) = withLockOrDrop {
        withContext(Dispatchers.IO) {
            val controller = requireInitialized()
            if (activeSensor != null && activeSensor != sensor) {
                throw DeviceException(
                    DeviceErrorCode.SENSOR_BUSY,
                    "${activeSensor?.wire} is already active."
                )
            }

            val started = when (sensor) {
                Sensor.Thermometer -> controller.startThermometer()
                Sensor.PulseOximeter -> controller.startPulseOximeter()
                Sensor.Ecg -> controller.startEcg()
                Sensor.Stethoscope -> {
                    val mode = options?.stethMode ?: throw DeviceException(
                        DeviceErrorCode.DEVICE_ERROR,
                        "Stethoscope requires a mode (heart, lungs, or bowel).",
                    )
                    stethMode = mode
                    // Setting a non-Off mode starts the live audio preview on the device.
                    controller.setStethoscopeMode(mode.sdk)
                }
                // The camera is the exception: it runs a UVC preview via setCameraMode(...)
                // rather than a startX() call, and owns its own failure detail and state
                // emit — so its branch returns here instead of falling through to the
                // shared start-and-report tail below.
                Sensor.Camera -> {
                    val mode = options?.cameraMode ?: throw DeviceException(
                        DeviceErrorCode.DEVICE_ERROR,
                        "Camera requires a mode (dermatoscope or otoscope).",
                    )
                    startCameraPreview(controller, mode)
                    return@withContext
                }
            }

            if (!started) {
                teardownSensor()
                throw DeviceException(
                    DeviceErrorCode.DEVICE_ERROR,
                    "Failed to start ${sensor.wire}."
                )
            }
            activeSensor = sensor
            emitState()
        }
    }

    override suspend fun stopSensor() = withLockOrDrop { teardownSensor() }

    // Stops the active sensor and emits — the lock-free core. The public
    // [stopSensor] serializes it via [withLockOrDrop]; the failed-start rollback
    // paths call it directly since they already hold [opLock] and must not
    // re-acquire. Keys off the tracking fields (not activeSensor) so it also
    // rolls back a failed start.
    private suspend fun teardownSensor() = withContext(Dispatchers.IO) {
        val controller = controller ?: return@withContext
        if (stethMode != null) {
            runCatching { controller.setStethoscopeMode(MicrophoneModes.Off) }
        }
        framePipeline.stop()
        runCatching { controller.stopSensor(false) }
        cameraPreview = null
        activeSensor = null
        stethMode = null
        cameraMode = null
        emitState()
    }

    /**
     * Starts (or switches) the live otoscope/dermatoscope preview through the
     * SDK's UVC path. The live/recorded frame handlers and the preview target are
     * connection-scoped (attached in [connect], cleared in [destroy]), so this only
     * drives the per-preview state: the frame encoder and the SDK preview mode.
     * Unlike the startX() sensors it owns its whole flow — throwing with the SDK's
     * detail on failure, and marking the camera active + emitting state on
     * success. Callers reach it through [startSensor] with a [Sensor.Camera] request.
     */
    private suspend fun startCameraPreview(controller: MedWandController, mode: CameraMode) {
        if (!controller.canUseCamera || !controller.hasValidOtoscope) {
            throw DeviceException(DeviceErrorCode.DEVICE_ERROR, "This MedWand has no camera.")
        }

        val target = SizedUvcCameraPreviewTarget(context)
        cameraPreview = target

        // If a preview is already up, switch modes cleanly by tearing the old one
        // down first (mirrors selecting a new mode in the sample).
        if (activeSensor == Sensor.Camera) {
            framePipeline.stop()
            runCatching { controller.stopSensor(false) }
        }

        framePipeline.start(mode.wire)

        if (!controller.setCameraMode(target, mode.sdk)) {
            val detail =
                controller.cameraLastError?.takeIf { it.isNotBlank() } ?: "Preview did not start."
            teardownSensor()
            throw DeviceException(DeviceErrorCode.DEVICE_ERROR, "Failed to start camera: $detail")
        }

        // Default to autofocus when the lens supports it, like the sample.
        if (controller.cameraFocusInfo?.hasAutoFocus == true) {
            runCatching { controller.setFocusMode(CameraHelper.FocusModes.Auto, false) }
        }

        cameraMode = mode
        activeSensor = Sensor.Camera
        emitState()
    }

    /** Captures a single still from the live preview (delivered as a `capture`). */
    override suspend fun captureCameraFrame() = withContext(Dispatchers.IO) {
        val controller = requireCameraMonitoring()
        controller.camera?.recordFrame()
            ?: throw DeviceException(DeviceErrorCode.DEVICE_ERROR, "Camera is not available.")
    }

    /** Sets the ring-light intensity (0..ledMax); off/full toggle for fixed LEDs. */
    override suspend fun setCameraLed(value: Int) = withContext(Dispatchers.IO) {
        val controller = requireCameraMonitoring()
        val max = controller.cameraLedIntensityMax
        if (max <= 0) return@withContext
        val target = if (controller.cameraLedIntensityAdjustable) {
            value.coerceIn(0, max)
        } else {
            if (value > 0) max else 0
        }
        controller.setCameraLedIntensity(target)
        emitState()
    }

    /** Switches between manual and automatic focus. */
    override suspend fun setCameraFocusManual(enabled: Boolean) = withContext(Dispatchers.IO) {
        val controller = requireCameraMonitoring()
        controller.setFocusMode(
            if (enabled) CameraHelper.FocusModes.Manual else CameraHelper.FocusModes.Auto,
            false,
        )
        emitState()
    }

    /** Sets the manual focus position (0..focusValueMax). */
    override suspend fun setCameraFocusValue(value: Int) = withContext(Dispatchers.IO) {
        val controller = requireCameraMonitoring()
        val max = controller.cameraFocusInfo?.focusMaximum ?: 0
        if (max <= 0) return@withContext
        controller.setFocusModeValue(value.coerceIn(0, max))
        emitState()
    }

    /** Pans the otoscope tip mask. */
    override suspend fun moveOtoscope(horizontal: Int?, vertical: Int?) =
        withContext(Dispatchers.IO) {
            val controller = requireOtoscope()
            controller.cameraMove(
                horizontal?.times(OTOSCOPE_MOVE_STEP),
                vertical?.times(OTOSCOPE_MOVE_STEP),
            )
        }

    /** Zooms the otoscope image. `direction` is +1 (in) or -1 (out). */
    override suspend fun zoomOtoscope(direction: Int) = withContext(Dispatchers.IO) {
        val controller = requireOtoscope()
        controller.cameraZoom(direction * OTOSCOPE_ZOOM_STEP)
    }

    /** Grows/shrinks the otoscope tip circle. `direction` is +1 or -1. */
    override suspend fun adjustOtoscopeRadius(direction: Int) = withContext(Dispatchers.IO) {
        val controller = requireOtoscope()
        controller.cameraAdjustOtoscopeRadius(direction * OTOSCOPE_RADIUS_STEP)
    }

    /** Resets pan/zoom/radius back to the SDK defaults. */
    override suspend fun resetCamera() = withContext(Dispatchers.IO) {
        requireCameraMonitoring().cameraReset()
    }

    private fun requireCameraMonitoring(): MedWandController {
        val controller = requireInitialized()
        if (activeSensor != Sensor.Camera || !controller.cameraIsMonitoring) {
            throw DeviceException(
                DeviceErrorCode.DEVICE_ERROR,
                "The camera preview is not running."
            )
        }
        return controller
    }

    private fun requireOtoscope(): MedWandController {
        val controller = requireCameraMonitoring()
        if (cameraMode != CameraMode.Otoscope) {
            throw DeviceException(DeviceErrorCode.DEVICE_ERROR, "This control is otoscope-only.")
        }
        return controller
    }

    // A recorded still: the SDK turns the raw frame into a ready-to-use
    // data:image/png;base64 URI, forwarded as-is (mirrors the ECG strip path).
    private fun onCameraCapture(raw: ByteArray) {
        val dataUri = controller?.cameraBmpFromCapture(raw)
        if (dataUri.isNullOrBlank()) {
            emitError(DeviceErrorCode.DEVICE_ERROR, "Camera capture was empty or malformed.")
            return
        }
        listener?.onCapture(
            Capture(
                sensor = Sensor.Camera.wire,
                mode = cameraMode?.wire,
                dataUri = dataUri
            )
        )
    }

    /** Begins capturing an ECG strip or a stethoscope clip. */
    override suspend fun startRecording() = withLockOrDrop {
        withContext(Dispatchers.IO) {
            requireInitialized().startRecording()
            emitState()
        }
    }

    /** Ends the recording; the SDK then delivers a recorded artifact callback. */
    override suspend fun stopRecording() = withLockOrDrop {
        withContext(Dispatchers.IO) {
            requireInitialized().stopRecording()
            emitState()
        }
    }

    override fun snapshot(): DeviceSnapshot = buildSnapshot()

    /** Starts watching for USB attach/detach. Call once when the host starts. */
    fun startMonitoring() = hotplug.start()

    /** Stops watching for USB attach/detach. Call when the host is destroyed. */
    fun stopMonitoring() = hotplug.stop()

    // The MedWand was physically unplugged. The SDK still believes it is
    // connected, so tear the controller down ourselves and report `detached`.
    private fun onDeviceDetached() {
        if (controller != null) destroy()
        emitState()
    }

    /**
     * Terminal teardown: stops any active sensor, clears the SDK callbacks, and
     * releases the controller. Not serialized — the host teardown and USB-detach
     * paths call it directly; the disconnect command reaches it via [disconnect].
     */
    override fun destroy() {
        val controller = controller ?: return
        // Clear the connection-scoped SDK callbacks (attached in connect) before
        // stopping, so no frame or artifact is delivered mid-teardown.
        runCatching { controller.setCameraFrameHandler(null) }
        controller.camera?.onRecordedFrameReady = null
        controller.ecg?.onRecordedStripReady = null
        controller.stethoscope?.onRecordedFramesReady = null
        cameraPreview = null
        framePipeline.stop()
        runCatching { controller.stopSensor(false) }
        controller.onLicenseError = {}
        controller.onDeviceError = {}
        controller.onDeviceStateChanged = {}
        controller.onReadingStateChanged = {}
        controller.onReadingReceived = {}
        runCatching { controller.close() }
        this.controller = null
        activeSensor = null
        stethMode = null
        cameraMode = null
    }

    private fun requireInitialized(): MedWandController {
        val controller = controller
        if (controller == null || !controller.isInitialized) {
            throw DeviceException(DeviceErrorCode.NOT_CONNECTED, "MedWand is not connected.")
        }
        return controller
    }

    // The SDK returns the strip as a ready-to-use `data:image/png;base64,...`
    // URI, so it is forwarded to the frontend as-is (no decode round-trip).
    private fun onEcgStripReady(raw: ByteArray) {
        val dataUri = controller?.ecgBmpFromCapture(raw)
        if (dataUri.isNullOrBlank()) {
            emitError(DeviceErrorCode.DEVICE_ERROR, "ECG capture was empty or malformed.")
            return
        }
        listener?.onCapture(Capture(sensor = Sensor.Ecg.wire, mode = null, dataUri = dataUri))
    }

    // The SDK returns the clip as a ready-to-use `data:audio/wav;base64,...` URI.
    private fun onStethFramesReady(raw: ByteArray) {
        val dataUri = controller?.stethoscope?.wavFromFrames(raw)
        if (dataUri.isNullOrBlank()) {
            emitError(DeviceErrorCode.DEVICE_ERROR, "Stethoscope capture was empty or malformed.")
            return
        }
        listener?.onCapture(
            Capture(
                sensor = Sensor.Stethoscope.wire,
                mode = stethMode?.wire,
                dataUri = dataUri
            )
        )
    }

    private fun emitState() {
        listener?.onStateChanged(buildSnapshot())
    }

    private fun emitError(code: DeviceErrorCode, message: String) {
        listener?.onError(code, message)
    }

    // Physical presence, straight from the OS — permission-free and independent
    // of the SDK, which is why it stays correct after a detach the SDK misses.
    private fun isMedWandAttached(): Boolean {
        val usbManager = context.getSystemService(UsbManager::class.java) ?: return false
        return usbPermission.findMedWandDevice(usbManager) != null
    }

    private fun buildSnapshot(): DeviceSnapshot {
        val controller = controller
        val initialized = controller?.isInitialized == true
        val device = when {
            initialized -> "connected"
            isMedWandAttached() -> "attached"
            else -> "detached"
        }
        val reading = controller?.readingState?.name?.lowercase() ?: "stopped"
        return DeviceSnapshot(
            device = device,
            reading = reading,
            activeSensor = buildActiveSensor(controller),
            capabilities = Capabilities(
                thermometer = initialized,
                pulseOximeter = initialized,
                ecg = initialized && controller?.hasValidEcg == true,
                stethoscope = initialized && controller?.hasValidStethoscope == true,
                camera = initialized && controller?.canUseCamera == true && controller?.hasValidOtoscope == true,
            ),
            deviceInfo = DeviceInfo(
                udi = controller?.udi,
                firmwareVersion = controller?.firmwareVersion,
                generation = controller?.generation?.toString(),
                comPort = controller?.comPort,
                vendorId = controller?.vendorId,
                productId = controller?.productId,
            )
        )
    }

    // The running sensor plus its live, user-settable state. Only one runs at a
    // time, so this returns a single tagged value (or null when idle).
    private fun buildActiveSensor(controller: MedWandController?): ActiveSensor? =
        when (val active = activeSensor) {
            null -> null
            Sensor.Camera -> buildCameraActive(controller)
            Sensor.Stethoscope ->
                stethMode?.let { ActiveSensor.Stethoscope(it.wire) }
                    ?: ActiveSensor.Plain(active.wire)

            else -> ActiveSensor.Plain(active.wire)
        }

    // Camera control state, meaningful only while a preview runs. Reads are
    // wrapped defensively — the SDK getters can throw or return null when the
    // camera isn't active. Only called while the camera is the active sensor.
    private fun buildCameraActive(controller: MedWandController?): ActiveSensor.Camera {
        val monitoring = controller?.cameraIsMonitoring == true
        val mode = cameraMode?.wire
            ?: controller?.let { runCatching { CameraMode.wireOf(it.cameraMode) }.getOrNull() }
            ?: "off"
        if (controller == null || !monitoring) {
            return ActiveSensor.Camera(
                mode = if (monitoring) mode else "off",
                monitoring = monitoring,
                ledMax = 0, ledIntensity = 0, ledAdjustable = false,
                autoFocusAvailable = false, manualFocusAvailable = false,
                manualFocusEnabled = false, focusValue = 0, focusValueMax = 0,
            )
        }
        val ledMax =
            runCatching { controller.cameraLedIntensityMax }.getOrDefault(0).coerceAtLeast(0)
        val focus = runCatching { controller.cameraFocusInfo }.getOrNull()
        val focusMax = (focus?.focusMaximum ?: 0).coerceAtLeast(0)
        return ActiveSensor.Camera(
            mode = mode,
            monitoring = true,
            ledMax = ledMax,
            ledIntensity = runCatching { controller.ledIntensity }.getOrDefault(0)
                .coerceIn(0, ledMax),
            ledAdjustable = runCatching { controller.cameraLedIntensityAdjustable }.getOrDefault(
                false
            ),
            autoFocusAvailable = focus?.hasAutoFocus == true,
            manualFocusAvailable = focus?.hasManualFocus == true && focusMax > 0,
            manualFocusEnabled = runCatching {
                controller.cameraFocusMode == CameraHelper.FocusModes.Manual
            }.getOrDefault(false),
            focusValue = runCatching { controller.cameraFocusModeValue }.getOrDefault(0)
                .coerceIn(0, focusMax),
            focusValueMax = focusMax,
        )
    }

    private companion object {
        // Otoscope control step sizes (mirror the Developer Suite sample).
        const val OTOSCOPE_MOVE_STEP = 5
        const val OTOSCOPE_RADIUS_STEP = 10
        const val OTOSCOPE_ZOOM_STEP = 10
    }
}
