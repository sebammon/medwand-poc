package com.medwand.poc.device

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Unit tests for the pure preview geometry/validation logic extracted from the
 * camera frame pipeline. No Android or SDK types are involved.
 */
class PreviewGeometryTest {

    @Test
    fun `passes through when the long edge is within the limit`() {
        assertEquals(PreviewSize(640, 480), previewTargetSize(640, 480, 1280))
    }

    @Test
    fun `passes through when the long edge equals the limit`() {
        assertEquals(PreviewSize(1280, 720), previewTargetSize(1280, 720, 1280))
    }

    @Test
    fun `downscales a landscape frame preserving aspect ratio`() {
        // 3200x2400 (4:3) → long edge clamped to 1280, short edge scaled to 960.
        assertEquals(PreviewSize(1280, 960), previewTargetSize(3200, 2400, 1280))
    }

    @Test
    fun `downscales a portrait frame preserving aspect ratio`() {
        assertEquals(PreviewSize(960, 1280), previewTargetSize(2400, 3200, 1280))
    }

    @Test
    fun `truncates the scaled short edge like the integer conversion`() {
        // scale = 1280/2000 = 0.64; 1000*0.64 = 640.0 exactly, 2000 → 1280.
        assertEquals(PreviewSize(1280, 640), previewTargetSize(2000, 1000, 1280))
        // 1500*0.64 = 960.0; long edge 2000 → 1280.
        assertEquals(PreviewSize(1280, 960), previewTargetSize(2000, 1500, 1280))
    }

    @Test
    fun `coerces an extreme aspect ratio short edge to at least one`() {
        // 4000x1: scale = 1280/4000 = 0.32; 1*0.32 = 0.32 → 0, coerced to 1.
        assertEquals(PreviewSize(1280, 1), previewTargetSize(4000, 1, 1280))
    }

    @Test
    fun `computes the ARGB_8888 byte size`() {
        assertEquals(640 * 480 * 4, argbByteSize(640, 480))
    }

    @Test
    fun `rejects non-positive dimensions`() {
        assertNull(argbByteSize(0, 480))
        assertNull(argbByteSize(640, 0))
        assertNull(argbByteSize(-1, 480))
        assertNull(argbByteSize(640, -1))
    }

    @Test
    fun `rejects dimensions that overflow an Int-sized buffer`() {
        // 40000 * 40000 * 4 = 6.4e12, well past Int.MAX_VALUE.
        assertNull(argbByteSize(40_000, 40_000))
    }

    @Test
    fun `accepts the largest in-range frame`() {
        // width*height*4 just under Int.MAX_VALUE stays valid.
        val edge = 23_100 // 23100*23100*4 = 2,134,440,000 < 2,147,483,647
        assertEquals(edge * edge * 4, argbByteSize(edge, edge))
    }
}
