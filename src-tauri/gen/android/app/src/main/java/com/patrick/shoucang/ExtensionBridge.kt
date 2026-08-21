package com.patrick.shoucang

import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.webkit.JavascriptInterface
import java.io.File

/**
 * 浏览器扩展下载桥 —— 供移动端 SetupPanel 调用（window.ExtensionBridge）。
 *
 * 桌面端不使用此桥（SetupPanel 走 POST /setup/browser-extension/open 打开文件夹）；
 * 移动端（health.platform === 'android'）点击「DOWNLOAD EXTENSION TO DOWNLOADS」时，
 * 前端直接调 window.ExtensionBridge.downloadExtension()，本桥把 APK assets/browser-extension
 * 整体拷贝到系统 Downloads/ShouCangExtension/（targetSdk 36 下走 MediaStore，无需存储权限，
 * 直接写 /sdcard/Download 在 Android 13+ 受限）。
 */
class ExtensionBridge(private val context: Context) {

  @JavascriptInterface
  fun downloadExtension(): String {
    return try {
      val assetRoot = "browser-extension"
      val files = context.assets.list(assetRoot)
      if (files == null || files.isEmpty()) return "error: extension assets not found"

      // Android 10+ 优先走 MediaStore（公共 Downloads，无需权限）
      // 为简化：逐文件写入 MediaStore.Downloads，相对路径 Downloads/ShouCangExtension/
      for (name in files) {
        copyAssetToDownloads("$assetRoot/$name", "ShouCangExtension/$name")
      }
      val dir = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        "Downloads/ShouCangExtension"
      } else {
        // 旧版直接写文件系统
        val legacy = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "ShouCangExtension")
        legacy.mkdirs()
        legacy.absolutePath
      }
      // 同时兼容旧版：尝试直接文件拷贝兜底（emulator / API<29）
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
        for (name in files) {
          val out = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "ShouCangExtension/$name")
          out.parentFile?.mkdirs()
          context.assets.open("$assetRoot/$name").use { input ->
            out.outputStream().use { output -> input.copyTo(output) }
          }
        }
      }
      "ok:$dir"
    } catch (e: Exception) {
      android.util.Log.e("ExtensionBridge", "download failed", e)
      "error:${e.message}"
    }
  }

  private fun copyAssetToDownloads(assetPath: String, relativePath: String) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      val resolver = context.contentResolver
      val values = ContentValues().apply {
        put(MediaStore.Downloads.DISPLAY_NAME, relativePath.substringAfterLast("/"))
        put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/" + relativePath.substringBeforeLast("/", "ShouCangExtension"))
        put(MediaStore.Downloads.MIME_TYPE, mimeFor(relativePath))
        put(MediaStore.Downloads.IS_PENDING, 1)
      }
      val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
        ?: throw IllegalStateException("MediaStore insert failed for $relativePath")
      try {
        resolver.openOutputStream(uri)?.use { out ->
          context.assets.open(assetPath).use { input -> input.copyTo(out) }
        }
        values.clear()
        values.put(MediaStore.Downloads.IS_PENDING, 0)
        resolver.update(uri, values, null, null)
      } catch (e: Exception) {
        try { resolver.delete(uri, null, null) } catch (_: Exception) {}
        throw e
      }
    }
  }

  private fun mimeFor(path: String): String = when {
    path.endsWith(".json") -> "application/json"
    path.endsWith(".js") -> "text/javascript"
    else -> "application/octet-stream"
  }
}
