package com.patrick.shoucang

import android.content.Intent
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import org.json.JSONObject

class MainActivity : TauriActivity() {

  companion object {
    @JvmStatic
    private var pendingShare: String? = null
    @JvmStatic
    private var activeWebView: RustWebView? = null

    class ShareBridge {
      @JavascriptInterface
      fun take(): String {
        val text = pendingShare
        pendingShare = null
        return text ?: ""
      }
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    captureShare(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    captureShare(intent)
  }

  /** 捕获分享 intent（XHS App / 任意应用分享文本到本应用） */
  private fun captureShare(intent: Intent?) {
    android.util.Log.i("ShoucangShare", "captureShare intent=$intent")
    val text = intent?.getStringExtra(Intent.EXTRA_TEXT) ?: run {
      android.util.Log.i("ShoucangShare", "captureShare: no EXTRA_TEXT")
      return
    }
    android.util.Log.i("ShoucangShare", "captureShare text=${text.take(60)}")
    if (text.isBlank()) return
    pendingShare = text
    activeWebView?.post {
      activeWebView?.evaluateJavascript(
        "window.__shoucangShareReceive ? window.__shoucangShareReceive(${JSONObject.quote(text)}) : null",
        null
      )
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    val rustWebView = webView as RustWebView
    activeWebView = rustWebView
    rustWebView.addJavascriptInterface(ShareBridge(), "ShoucangShareBridge")
    rustWebView.addJavascriptInterface(OcrBridge(this), "OcrBridge")
    android.util.Log.i("ShoucangShare", "onWebViewCreate: bridge registered, pending=${pendingShare != null}")
    pendingShare?.let { text ->
      webView.post {
        webView.evaluateJavascript(
          "window.__shoucangShareReceive ? window.__shoucangShareReceive(${JSONObject.quote(text)}) : null",
          null
        )
      }
    }
  }

  override fun onDestroy() {
    super.onDestroy()
    if (activeWebView === null) return
    activeWebView = null
  }
}
