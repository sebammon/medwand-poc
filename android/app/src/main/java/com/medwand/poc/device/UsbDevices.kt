package com.medwand.poc.device

import android.hardware.usb.UsbDevice

/** The MedWand's USB product id (matches the Developer Suite sample). */
private const val MEDWAND_PRODUCT_ID = 60

/** True when a USB device is a MedWand — by product id first, then by name. */
fun isMedWandDevice(device: UsbDevice): Boolean {
    if (device.productId == MEDWAND_PRODUCT_ID) return true
    return listOfNotNull(device.manufacturerName, device.productName, device.deviceName).any {
        it.contains("medwand", ignoreCase = true) || it.contains("med wand", ignoreCase = true)
    }
}
