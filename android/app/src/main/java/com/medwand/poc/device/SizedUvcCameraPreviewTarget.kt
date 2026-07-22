package com.medwand.poc.device

import android.content.Context
import com.medwand.sdk_core.Internal.CameraHelper
import com.medwand.sdk_core.Modules.CameraPreviewTarget
import com.medwand.sdk_core.Modules.UvcCameraPreviewTarget

/**
 * UVC preview target that preserves the SDK's preview behaviour while exposing
 * the actual frame dimensions the camera reports.
 *
 * The controller's live frame handler ([MedWandController.setCameraFrameHandler])
 * hands back only the processed ARGB byte array — no dimensions. The SDK sizes
 * those frames to the resolution negotiated here, so this wrapper records the
 * width/height from the camera callback and the device layer reads them back to
 * build a bitmap from each frame. Mirrors the Developer Suite sample.
 */
class SizedUvcCameraPreviewTarget(context: Context) : CameraPreviewTarget {
    private val delegate = UvcCameraPreviewTarget(context)

    @Volatile
    var frameWidth: Int = 0
        private set

    @Volatile
    var frameHeight: Int = 0
        private set

    override fun resolveCameraDeviceInfo() = delegate.resolveCameraDeviceInfo()

    override fun resolveCameraModel() = delegate.resolveCameraModel()

    override fun setFocusMode(focusMode: CameraHelper.FocusModes) = delegate.setFocusMode(focusMode)

    override fun setFocusModeValue(focusPercent: Int) = delegate.setFocusModeValue(focusPercent)

    override fun start(
        width: Int,
        height: Int,
        frameRate: Int,
        onFrame: (ByteArray, Int, Int) -> Unit,
    ) {
        frameWidth = width
        frameHeight = height
        delegate.start(width, height, frameRate) { bytes, actualWidth, actualHeight ->
            frameWidth = actualWidth
            frameHeight = actualHeight
            onFrame(bytes, actualWidth, actualHeight)
        }
    }

    override fun stop() {
        delegate.stop()
        frameWidth = 0
        frameHeight = 0
    }
}
