package com.medwand.poc.device

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CompletableDeferred

/**
 * Requests Android runtime permission for the attached MedWand USB device and
 * suspends until the user responds. Isolated here so the device layer can await
 * a grant without any UI plumbing.
 */
class UsbPermissionRequester(private val context: Context) {
    private val action = "${context.packageName}.USB_PERMISSION"

    /** True if permission is already held or the user grants it; false if denied. */
    suspend fun ensurePermission(usbManager: UsbManager): Boolean {
        val device = findMedWandDevice(usbManager) ?: return true
        if (usbManager.hasPermission(device)) return true

        val result = CompletableDeferred<Boolean>()
        val permissionIntent = PendingIntent.getBroadcast(
            context,
            0,
            Intent(action).setPackage(context.packageName),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
        )
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context, intent: Intent) {
                if (intent.action != action) return
                result.complete(intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false))
            }
        }

        val filter = IntentFilter(action)
        ContextCompat.registerReceiver(context, receiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)

        return try {
            usbManager.requestPermission(device, permissionIntent)
            result.await()
        } finally {
            runCatching { context.unregisterReceiver(receiver) }
        }
    }

    /** Locates the MedWand among the attached USB devices, if present. */
    fun findMedWandDevice(usbManager: UsbManager): UsbDevice? =
        usbManager.deviceList.values.firstOrNull { isMedWandDevice(it) }
}
