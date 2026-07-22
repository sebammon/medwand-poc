package com.medwand.poc.device

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.AbstractExecutorService
import java.util.concurrent.TimeUnit

/**
 * Unit tests for [CameraFramePipeline]'s threading/drop contract. The Android
 * pixel work is faked ([FakeFrameCodec]) and the encoder thread is replaced by
 * a [ManualExecutorService] so task execution is deterministic — no Android,
 * SDK, or real threads involved.
 */
class CameraFramePipelineTest {

    private val bytes2x2 = ByteArray(argbByteSize(2, 2)!!)

    @Test
    fun `drops a frame submitted while the encoder is busy`() {
        val codec = FakeFrameCodec()
        val executor = ManualExecutorService()
        val frames = mutableListOf<CameraFrame>()
        val pipeline = CameraFramePipeline(codec) { executor }
        pipeline.onFrame = { frames.add(it) }
        pipeline.start("otoscope")

        // First frame: enqueues an encode task and marks the pipeline busy.
        pipeline.submit(bytes2x2, 2, 2)
        assertEquals(1, executor.queued.size)
        assertEquals(0, codec.calls)

        // Second frame arrives before the first finished encoding: dropped.
        pipeline.submit(bytes2x2, 2, 2)
        assertEquals(1, executor.queued.size)

        // Draining the first task encodes it, emits, and clears the busy flag.
        executor.runAll()
        assertEquals(1, codec.calls)
        assertEquals(1, frames.size)
        assertEquals("otoscope", frames[0].mode)
        assertEquals(2, frames[0].width)
        assertEquals(2, frames[0].height)

        // A frame after the busy window is accepted again.
        pipeline.submit(bytes2x2, 2, 2)
        assertEquals(1, executor.queued.size)
        executor.runAll()
        assertEquals(2, codec.calls)
        assertEquals(2, frames.size)
    }

    @Test
    fun `resets the busy flag when the codec throws so later frames still encode`() {
        val codec = FakeFrameCodec(throwOnCall = 1)
        val executor = ManualExecutorService()
        val frames = mutableListOf<CameraFrame>()
        val pipeline = CameraFramePipeline(codec) { executor }
        pipeline.onFrame = { frames.add(it) }
        pipeline.start("otoscope")

        pipeline.submit(bytes2x2, 2, 2)
        executor.runAll()               // codec throws → swallowed, no frame emitted
        assertEquals(1, codec.calls)
        assertEquals(0, frames.size)

        // The throw must not have left the pipeline stuck busy.
        pipeline.submit(bytes2x2, 2, 2)
        assertEquals(1, executor.queued.size)
        executor.runAll()
        assertEquals(1, frames.size)
    }

    @Test
    fun `teardown mid-flight emits nothing and resets the codec`() {
        val codec = FakeFrameCodec()
        val executor = ManualExecutorService()
        val frames = mutableListOf<CameraFrame>()
        val pipeline = CameraFramePipeline(codec) { executor }
        pipeline.onFrame = { frames.add(it) }
        pipeline.start("otoscope")

        pipeline.submit(bytes2x2, 2, 2)
        // Capture the queued encode task: a frame handed to the encoder thread
        // but not yet complete when teardown races in.
        val inFlight = executor.queued.first()

        val resetsBeforeStop = codec.resetCount
        pipeline.stop()
        assertTrue("stop() must reset the codec's scratch state", codec.resetCount > resetsBeforeStop)

        // The still-pending task now runs after teardown; the cleared mode makes
        // it a no-op, so nothing is emitted and the codec is never touched.
        inFlight.run()
        assertEquals(0, frames.size)
        assertEquals(0, codec.calls)
    }

    @Test
    fun `drops frames with a buffer shorter than the declared dimensions`() {
        val codec = FakeFrameCodec()
        val executor = ManualExecutorService()
        val pipeline = CameraFramePipeline(codec) { executor }
        pipeline.start("otoscope")

        // 4x4 needs 64 bytes; a 16-byte buffer is too short and is dropped.
        pipeline.submit(ByteArray(16), 4, 4)
        assertEquals(0, executor.queued.size)
    }

    @Test
    fun `drops frames when no encoder is running`() {
        val codec = FakeFrameCodec()
        val executor = ManualExecutorService()
        val pipeline = CameraFramePipeline(codec) { executor }
        // No start(): submit must not throw or enqueue anything.
        pipeline.submit(bytes2x2, 2, 2)
        assertEquals(0, executor.queued.size)
    }

    /** Records calls; optionally throws on the Nth encode to exercise recovery. */
    private class FakeFrameCodec(private val throwOnCall: Int = -1) : FrameCodec {
        var calls = 0
        var resetCount = 0

        override fun argbToJpeg(bytes: ByteArray, width: Int, height: Int, maxEdge: Int): ByteArray {
            calls++
            if (calls == throwOnCall) throw RuntimeException("codec failure")
            return byteArrayOf(1, 2, 3)
        }

        override fun reset() {
            resetCount++
        }
    }

    /**
     * Executor that queues submitted tasks instead of running them, so a test
     * controls exactly when (and whether) an encode task executes.
     */
    private class ManualExecutorService : AbstractExecutorService() {
        val queued = ArrayDeque<Runnable>()
        private var shutdown = false

        override fun execute(command: Runnable) {
            queued.add(command)
        }

        override fun shutdown() {
            shutdown = true
        }

        override fun shutdownNow(): MutableList<Runnable> {
            shutdown = true
            val pending = queued.toMutableList()
            queued.clear()
            return pending
        }

        override fun isShutdown(): Boolean = shutdown

        override fun isTerminated(): Boolean = shutdown && queued.isEmpty()

        override fun awaitTermination(timeout: Long, unit: TimeUnit): Boolean = true

        fun runAll() {
            while (true) {
                val task = queued.removeFirstOrNull() ?: break
                task.run()
            }
        }
    }
}
