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
    // 语义模型部署（~282MB assets → 数据目录）放后台线程，避免阻塞主线程导致 ANR
    Thread { ModelDeployer.ensure(applicationContext) }.start()
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
    // 视口适配（Google 多尺寸设备要求）：
    // 布局视口必须=设备宽度，否则页面按宽视口布局导致右侧 UI 溢出屏幕外。
    // Tauri 生成的 WebView 默认 useWideViewPort=true，需显式关闭。
    rustWebView.settings.useWideViewPort = false
    rustWebView.settings.loadWithOverviewMode = false
    rustWebView.settings.setSupportZoom(false)
    rustWebView.settings.builtInZoomControls = false
    rustWebView.settings.displayZoomControls = false
    rustWebView.addJavascriptInterface(ShareBridge(), "ShoucangShareBridge")
    rustWebView.addJavascriptInterface(OcrBridge(this), "OcrBridge")
    rustWebView.addJavascriptInterface(ExtensionBridge(this), "ExtensionBridge")
    injectSystemInsets(rustWebView)
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

  /**
   * 系统栏 inset 注入（edge-to-edge 适配）：
   * WebView 内容绘制到状态栏/导航栏之下，前端需留出空间否则
   * 底部导航被手势条遮挡、顶部状态栏与 header 重叠。
   * 页面加载完成后注入一次（CSS 变量由前端 registerInsets 消费）。
   */
  private fun injectSystemInsets(webView: RustWebView) {
    val resources = resources
    val density = resources.displayMetrics.density
    // 状态栏高度（px → dp）
    var statusBarPx = 0
    val statusBarId = resources.getIdentifier("status_bar_height", "dimen", "android")
    if (statusBarId > 0) statusBarPx = resources.getDimensionPixelSize(statusBarId)
    // 导航栏高度（px → dp）
    var navBarPx = 0
    val navBarId = resources.getIdentifier("navigation_bar_height", "dimen", "android")
    if (navBarId > 0) navBarPx = resources.getDimensionPixelSize(navBarId)
    val topDp = Math.round(statusBarPx / density)
    val bottomDp = Math.round(navBarPx / density)
    android.util.Log.i("ShoucangShare", "system insets: top=${topDp}dp bottom=${bottomDp}dp (density=$density)")
    // 页面加载需要时间，轮询注入直到前端就绪（最多 20 次 × 500ms）
    var attempts = 0
    val runnable = object : Runnable {
      override fun run() {
        attempts++
        webView.evaluateJavascript(
          "window.__setInsets ? (window.__setInsets($topDp, $bottomDp), true) : false",
          null
        )
        if (attempts < 20) webView.postDelayed(this, 500)
      }
    }
    webView.postDelayed(runnable, 800)
  }

  override fun onDestroy() {
    super.onDestroy()
    if (activeWebView === null) return
    activeWebView = null
  }
}
