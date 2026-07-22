package com.medwand.poc.web

import android.annotation.SuppressLint
import android.content.Context
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewAssetLoader.AssetsPathHandler
import com.medwand.poc.BuildConfig

/**
 * Builds the single WebView that hosts the React frontend. The bundled web build
 * is served over a real https origin via [WebViewAssetLoader] so the bridge can
 * be scoped to that first-party origin (bridge doc §1).
 */
object WebViewFactory {

    const val ORIGIN = "https://appassets.androidplatform.net"
    const val START_URL = "$ORIGIN/assets/index.html"

    @SuppressLint("SetJavaScriptEnabled")
    fun create(context: Context): WebView {
        val webView = WebView(context)
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            // Let the captured stethoscope <audio> clip play without a gesture chain.
            mediaPlaybackRequiresUserGesture = false
            // Content is bundled locally; no file/content access needed.
            allowFileAccess = false
            allowContentAccess = false
            cacheMode = WebSettings.LOAD_DEFAULT
        }

        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", AssetsPathHandler(context))
            .build()
        webView.webViewClient = AssetWebViewClient(assetLoader)

        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)
        return webView
    }
}

/**
 * Serves the bundled web build through the asset loader. This is a single-purpose
 * shell that only ever loads its own first-party bundled assets.
 */
private class AssetWebViewClient(
    private val assetLoader: WebViewAssetLoader,
) : WebViewClient() {

    override fun shouldInterceptRequest(
        view: WebView,
        request: WebResourceRequest,
    ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)
}
