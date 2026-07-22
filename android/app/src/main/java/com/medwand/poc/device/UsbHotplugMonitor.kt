package com.medwand.poc.device

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import androidx.core.content.ContextCompat
import androidx.core.content.IntentCompat

/**
 * Watches for the MedWand being physically attached or detached and invokes the
 * matching callback. The MedWand SDK reports a successful connect but never a
 * physical unplug, so these OS broadcasts are the only reliable source of a
 * presence change while the app is running.
 *
 * The receiver is registered dynamically (not in the manifest) because we only
 * care about hotplug events while the app is alive — a manifest filter is for
 * launching the app on attach, which the app does not do.
 */
class UsbHotplugMonitor(
    private val context: Context,
    private val onAttached: () -> Unit,
    private val onDetached: () -> Unit,
) {
    private var receiver: BroadcastReceiver? = null

    /** Begins listening. Idempotent. */
    fun start() {
        if (receiver != null) return
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context, intent: Intent) {
                val device = intent.usbDevice() ?: return
                if (!isMedWandDevice(device)) return
                when (intent.action) {
                    UsbManager.ACTION_USB_DEVICE_ATTACHED -> onAttached()
                    UsbManager.ACTION_USB_DEVICE_DETACHED -> onDetached()
                }
            }
        }
        val filter = IntentFilter().apply {
            addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED)
            addAction(UsbManager.ACTION_USB_DEVICE_DETACHED)
        }
        // Attach/detach are protected system broadcasts, so NOT_EXPORTED is correct.
        ContextCompat.registerReceiver(context, receiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
        this.receiver = receiver
    }

    /** Stops listening. Idempotent. */
    fun stop() {
        receiver?.let { runCatching { context.unregisterReceiver(it) } }
        receiver = null
    }

    private fun Intent.usbDevice(): UsbDevice? =
        IntentCompat.getParcelableExtra(this, UsbManager.EXTRA_DEVICE, UsbDevice::class.java)
}
