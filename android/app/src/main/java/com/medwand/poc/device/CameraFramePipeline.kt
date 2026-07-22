package com.medwand.poc.device

import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/** JPEG quality for the downscaled live-preview frame (capture is separate). */
internal const val FRAME_JPEG_QUALITY = 70

// Longest edge of the live preview JPEG. The SDK streams much larger frames
// (e.g. 3200x2400); anything beyond this is wasted encode time since the
// preview renders small. Tune down for more speed. Capture is separate and
// stays full-res.
internal const val PREVIEW_MAX_EDGE = 1280

/** Width/height of a preview frame after (optional) downscaling. */
data class PreviewSize(val width: Int, val height: Int)

/**
 * Target size for a preview frame: the frame itself when its long edge is
 * already within [maxEdge], otherwise an aspect-preserving downscale. Each edge
 * is coerced to at least 1 so an extreme aspect ratio never collapses to zero.
 */
fun previewTargetSize(width: Int, height: Int, maxEdge: Int): PreviewSize {
    val longEdge = maxOf(width, height)
    if (longEdge <= maxEdge) return PreviewSize(width, height)

    val scale = maxEdge.toFloat() / longEdge
    val targetW = (width * scale).toInt().coerceAtLeast(1)
    val targetH = (height * scale).toInt().coerceAtLeast(1)
    return PreviewSize(targetW, targetH)
}

/**
 * Byte length of an ARGB_8888 frame of [width]x[height], or `null` when the
 * dimensions are non-positive or the frame would overflow an `Int`-sized
 * buffer. Guards the SDK's dimensionless frame stream before any allocation.
 */
fun argbByteSize(width: Int, height: Int): Int? {
    val needed = width.toLong() * height.toLong() * 4L
    if (needed <= 0L || needed > Int.MAX_VALUE) return null
    return needed.toInt()
}

/**
 * Android-dependent pixel work for the preview pipeline, behind a seam so the
 * pipeline's threading/drop logic can be unit-tested with a fake.
 */
interface FrameCodec {
    /**
     * Encode an ARGB_8888 buffer ([width]*[height]*4 bytes) to JPEG, downscaled
     * so its long edge is within [maxEdge]. The resulting pixel size matches
     * [previewTargetSize].
     */
    fun argbToJpeg(bytes: ByteArray, width: Int, height: Int, maxEdge: Int): ByteArray

    /** Release any reusable scratch buffers between previews. */
    fun reset()
}

/**
 * Owns the live-camera frame plumbing lifted out of [MedWandDevice]: a single
 * dedicated encoder thread, buffer reuse, and a drop-on-busy guard so a slow
 * encode never backs up or stalls the SDK's camera pipeline. The Android
 * pixel work lives behind [FrameCodec]; this class knows nothing about Bitmap.
 *
 * There is intentionally no framerate throttle — only the busy guard bounds the
 * work.
 */
class CameraFramePipeline(
    private val codec: FrameCodec,
    // Creates the single encoder thread. Injectable so tests can drive the
    // drop-on-busy/teardown logic with a deterministic executor.
    private val executorFactory: () -> ExecutorService = { Executors.newSingleThreadExecutor() },
) {
    /** Set before [start]; emits each encoded preview frame. */
    var onFrame: (CameraFrame) -> Unit = {}

    // The active camera mode's wire name, stamped onto each emitted frame. Set by
    // [start] and cleared by [stop]; a `null` mode (no active preview) drops the
    // frame rather than emitting it — the safety net for a teardown mid-encode.
    @Volatile
    private var mode: String? = null

    private var frameExecutor: ExecutorService? = null
    private val frameLock = Any()
    private var frameBusy = false
    private var frameCopy: ByteArray? = null

    /**
     * Starts a fresh encoder thread for the given camera [mode], replacing any
     * previous one. Frames submitted after this carry [mode] until [stop].
     */
    fun start(mode: String) {
        stop()
        this.mode = mode
        frameExecutor = executorFactory()
    }

    /** Stops the encoder thread and clears per-preview scratch state. */
    fun stop() {
        frameExecutor?.shutdownNow()
        frameExecutor = null
        synchronized(frameLock) {
            frameBusy = false
        }
        frameCopy = null
        mode = null
        codec.reset()
    }

    /**
     * Handles a live frame from the SDK (on an SDK/UVC thread). Copies the
     * buffer under the lock, then hands the copy to the encoder thread; the
     * drop-on-busy guard bounds the work so a slow encode never blocks the
     * camera or builds a backlog. Invalid dimensions or a short buffer are
     * dropped silently.
     */
    fun submit(frameBytes: ByteArray, width: Int, height: Int) {
        val size = argbByteSize(width, height) ?: return
        if (frameBytes.size < size) return

        val executor: ExecutorService
        val copy: ByteArray
        synchronized(frameLock) {
            if (frameBusy) return
            executor = frameExecutor ?: return
            var buffer = frameCopy
            if (buffer == null || buffer.size != size) {
                buffer = ByteArray(size)
                frameCopy = buffer
            }
            System.arraycopy(frameBytes, 0, buffer, 0, size)
            copy = buffer
            frameBusy = true
        }
        runCatching { executor.execute { encodeAndEmit(copy, width, height) } }
            .onFailure { synchronized(frameLock) { frameBusy = false } }
    }

    private fun encodeAndEmit(bytes: ByteArray, width: Int, height: Int) {
        try {
            val mode = mode ?: return
            val jpeg = codec.argbToJpeg(bytes, width, height, PREVIEW_MAX_EDGE)
            val size = previewTargetSize(width, height, PREVIEW_MAX_EDGE)
            onFrame(CameraFrame(mode, jpeg, size.width, size.height))
        } catch (_: Throwable) {
            // A dropped frame is harmless; the next one will render.
        } finally {
            synchronized(frameLock) { frameBusy = false }
        }
    }
}
