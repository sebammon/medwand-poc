package com.medwand.poc

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import com.medwand.poc.bridge.MedWandBridge
import com.medwand.poc.device.MedWandDevice
import com.medwand.poc.web.WebViewFactory
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel

/**
 * Single-activity host. It builds the WebView, the MedWand device layer, and the
 * bridge that connects them, then loads the bundled frontend. All device logic
 * lives behind the bridge; the Activity only owns the WebView, the coroutine
 * scope, and the runtime permissions the sensors need.
 */
class MainActivity : ComponentActivity() {

    private val scope = MainScope()
    private lateinit var webView: WebView
    private lateinit var device: MedWandDevice

    private var audioPermissionResult: CompletableDeferred<Boolean>? = null
    private val audioPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            audioPermissionResult?.complete(granted)
            audioPermissionResult = null
        }

    private var cameraPermissionResult: CompletableDeferred<Boolean>? = null
    private val cameraPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            cameraPermissionResult?.complete(granted)
            cameraPermissionResult = null
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        device = MedWandDevice(this, BuildConfig.MW_SDK_LICENSE, BuildConfig.MW_SDK_PUBLIC_KEY)
        webView = WebViewFactory.create(this)

        val bridge = MedWandBridge(device, scope, ::ensureAudioPermission, ::ensureCameraPermission)
        bridge.register(webView, WebViewFactory.ORIGIN)
        device.startMonitoring()

        val root = FrameLayout(this).apply {
            addView(webView, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        }
        setContentView(root)
        applySystemBarInsets(root)

        webView.loadUrl(WebViewFactory.START_URL)
    }

    /** Pads the content by the system bars so the web UI is never covered. */
    private fun applySystemBarInsets(view: android.view.View) {
        ViewCompat.setOnApplyWindowInsetsListener(view) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            v.updatePadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
    }

    /** Requests RECORD_AUDIO on demand for the stethoscope; suspends for the result. */
    private suspend fun ensureAudioPermission(): Boolean {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) return true
        val result = CompletableDeferred<Boolean>()
        audioPermissionResult = result
        audioPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
        return result.await()
    }

    /** Requests CAMERA on demand for the otoscope/dermatoscope preview. */
    private suspend fun ensureCameraPermission(): Boolean {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) return true
        val result = CompletableDeferred<Boolean>()
        cameraPermissionResult = result
        cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
        return result.await()
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
    }

    override fun onPause() {
        webView.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        device.stopMonitoring()
        device.close()
        webView.destroy()
        scope.cancel()
        super.onDestroy()
    }
}
