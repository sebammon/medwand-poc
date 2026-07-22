package com.medwand.poc.device

import android.graphics.BitmapFactory
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Instrumented tests for [AndroidFrameCodec]. These must run on a device or
 * emulator: the codec drives the real Android graphics stack (Bitmap pixel
 * copy, Canvas downscale, Skia JPEG encode), none of which the JVM stub jar or
 * Robolectric's shadows reproduce faithfully. The surrounding pure logic
 * (previewTargetSize/argbByteSize) is covered off-device in PreviewGeometryTest.
 */
@RunWith(AndroidJUnit4::class)
class AndroidFrameCodecTest {

    private lateinit var codec: AndroidFrameCodec

    @Before
    fun setUp() {
        codec = AndroidFrameCodec()
    }

    @Test
    fun encodesADecodableJpegAtThePassThroughSize() {
        val width = 320
        val height = 240
        val jpeg = codec.argbToJpeg(solidArgb(width, height, GRAY), width, height, PREVIEW_MAX_EDGE)

        assertTrue("output should be a non-empty JPEG", isJpeg(jpeg))
        val decoded = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size)
        // Long edge is within PREVIEW_MAX_EDGE, so no downscale: dimensions pass through.
        assertEquals(width, decoded.width)
        assertEquals(height, decoded.height)
    }

    @Test
    fun downscalesToThePreviewTargetSize() {
        // 3200x2400 is a representative SDK full-res frame; it must shrink to the
        // aspect-preserving target computed by previewTargetSize.
        val width = 3200
        val height = 2400
        val target = previewTargetSize(width, height, PREVIEW_MAX_EDGE)

        val jpeg = codec.argbToJpeg(solidArgb(width, height, GRAY), width, height, PREVIEW_MAX_EDGE)
        val decoded = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size)

        assertEquals(PreviewSize(1280, 960), target) // sanity-check the expectation
        assertEquals(target.width, decoded.width)
        assertEquals(target.height, decoded.height)
    }

    @Test
    fun preservesTheFramePixelsThroughTheRoundTrip() {
        // A solid mid-gray frame should decode back to roughly the same gray:
        // proves copyPixelsFromBuffer actually moved the bytes rather than the
        // codec shipping a blank/black bitmap. JPEG is lossy, so allow tolerance.
        val width = 640
        val height = 480
        val jpeg = codec.argbToJpeg(solidArgb(width, height, GRAY), width, height, PREVIEW_MAX_EDGE)

        val decoded = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size)
        val center = decoded.getPixel(decoded.width / 2, decoded.height / 2)
        assertChannelNear(GRAY, android.graphics.Color.red(center))
        assertChannelNear(GRAY, android.graphics.Color.green(center))
        assertChannelNear(GRAY, android.graphics.Color.blue(center))
    }

    @Test
    fun reusesAndReallocatesScratchBitmapsAcrossFrames() {
        // Same size twice (scratch reuse), then a different size (reallocation),
        // then back again. Each must still produce a correctly-sized JPEG.
        val a = decodeSize(codec.argbToJpeg(solidArgb(320, 240, GRAY), 320, 240, PREVIEW_MAX_EDGE))
        val b = decodeSize(codec.argbToJpeg(solidArgb(320, 240, GRAY), 320, 240, PREVIEW_MAX_EDGE))
        val c = decodeSize(codec.argbToJpeg(solidArgb(3200, 2400, GRAY), 3200, 2400, PREVIEW_MAX_EDGE))
        val d = decodeSize(codec.argbToJpeg(solidArgb(320, 240, GRAY), 320, 240, PREVIEW_MAX_EDGE))

        assertEquals(PreviewSize(320, 240), a)
        assertEquals(PreviewSize(320, 240), b)
        assertEquals(PreviewSize(1280, 960), c)
        assertEquals(PreviewSize(320, 240), d)
    }

    @Test
    fun encodesAgainAfterReset() {
        codec.argbToJpeg(solidArgb(320, 240, GRAY), 320, 240, PREVIEW_MAX_EDGE)
        codec.reset() // drops the scratch bitmaps; next frame must reallocate cleanly

        val jpeg = codec.argbToJpeg(solidArgb(320, 240, GRAY), 320, 240, PREVIEW_MAX_EDGE)
        assertEquals(PreviewSize(320, 240), decodeSize(jpeg))
    }

    private fun decodeSize(jpeg: ByteArray): PreviewSize {
        val decoded = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size)
        return PreviewSize(decoded.width, decoded.height)
    }

    // Builds an ARGB_8888 buffer of the size the codec expects (width*height*4).
    // All four bytes per pixel share [value], so the color is channel-order
    // independent (gray with matching alpha) and the round-trip check is robust.
    private fun solidArgb(width: Int, height: Int, value: Int): ByteArray {
        val bytes = ByteArray(width * height * 4)
        bytes.fill(value.toByte())
        return bytes
    }

    private fun isJpeg(bytes: ByteArray): Boolean =
        bytes.size > 4 &&
            bytes[0] == 0xFF.toByte() && bytes[1] == 0xD8.toByte() && // SOI
            bytes[bytes.size - 2] == 0xFF.toByte() && bytes[bytes.size - 1] == 0xD9.toByte() // EOI

    private fun assertChannelNear(expected: Int, actual: Int) {
        assertTrue("expected ~$expected but was $actual", kotlin.math.abs(expected - actual) <= JPEG_TOLERANCE)
    }

    private companion object {
        const val GRAY = 0x80
        const val JPEG_TOLERANCE = 8 // JPEG at quality 70 is lossy; small drift is expected
    }
}
