package com.medwand.poc.device

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Rect
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer

/**
 * Production [FrameCodec] backed by Android graphics. Turns each ARGB_8888
 * frame into a downscaled preview JPEG, reusing its scratch bitmaps/canvas
 * across frames. Not thread-safe by design: [CameraFramePipeline] only ever
 * calls it from its single encoder thread, so the scratch state needs no
 * locking. The SDK's full-res stream and the capture path are untouched.
 */
class AndroidFrameCodec : FrameCodec {
    private var frameBitmap: Bitmap? = null
    private var scaledBitmap: Bitmap? = null
    private var scaledCanvas: Canvas? = null
    private val previewDst = Rect()
    private val previewPaint = Paint(Paint.FILTER_BITMAP_FLAG)   // bilinear on downscale

    override fun argbToJpeg(bytes: ByteArray, width: Int, height: Int, maxEdge: Int): ByteArray {
        var bitmap = frameBitmap
        if (bitmap == null || bitmap.width != width || bitmap.height != height) {
            bitmap?.recycle()
            bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
            frameBitmap = bitmap
        }
        bitmap.copyPixelsFromBuffer(ByteBuffer.wrap(bytes, 0, width * height * 4))

        // Downscale the preview to keep JPEG encoding within the frame budget.
        // Only the bytes we ship over the bridge shrink.
        val encoded = scaleForPreview(bitmap, width, height, maxEdge)

        val out = ByteArrayOutputStream()
        encoded.compress(Bitmap.CompressFormat.JPEG, FRAME_JPEG_QUALITY, out)
        return out.toByteArray()
    }

    // Returns a preview-sized bitmap: the full frame itself when it is already
    // within [maxEdge], otherwise a reused scratch bitmap holding a bilinear-
    // downscaled copy. Single-threaded, so the scratch state needs no locking.
    private fun scaleForPreview(source: Bitmap, width: Int, height: Int, maxEdge: Int): Bitmap {
        val target = previewTargetSize(width, height, maxEdge)
        if (target.width == width && target.height == height) return source

        var scaled = scaledBitmap
        if (scaled == null || scaled.width != target.width || scaled.height != target.height) {
            scaled?.recycle()
            scaled = Bitmap.createBitmap(target.width, target.height, Bitmap.Config.ARGB_8888)
            scaledBitmap = scaled
            scaledCanvas = Canvas(scaled)
        }
        previewDst.set(0, 0, target.width, target.height)
        scaledCanvas?.drawBitmap(source, null, previewDst, previewPaint)
        return scaled
    }

    // The scratch bitmaps are owned by the pipeline's (now-stopped) encoder
    // thread; drop them so they are reallocated for the next preview.
    override fun reset() {
        frameBitmap = null
        scaledBitmap = null
        scaledCanvas = null
    }
}
