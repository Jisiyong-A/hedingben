package com.patrick.shoucang

import android.content.Context
import android.net.Uri
import android.webkit.JavascriptInterface
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * ML Kit 本地 OCR bridge —— 供 WebView 前端调用（window.OcrBridge）。
 *
 * 识别 Rust sidecar 数据目录下的本地图片（/data/user/0/<pkg>/media/<noteId>/<file>），
 * 返回纯文本；失败返回空串（导入链路 best-effort，不阻断）。
 * ML Kit bundled 模型打进 APK（zh-Hans/zh-Hant/en），完全离线。
 */
class OcrBridge(private val context: Context) {

  private val recognizer = TextRecognition.getClient(
    ChineseTextRecognizerOptions.Builder().build()
  )

  @JavascriptInterface
  fun recognize(noteId: String, file: String): String {
    val safeFile = file.replace(Regex("[^0-9a-zA-Z._-]"), "")
    val imageFile = File(context.dataDir, "media/$noteId/$safeFile")
    android.util.Log.i("OcrBridge", "recognize noteId=$noteId file=$safeFile path=${imageFile.absolutePath} exists=${imageFile.isFile}")
    if (!imageFile.isFile) return ""

    val latch = CountDownLatch(1)
    var resultText = ""
    try {
      val image = InputImage.fromFilePath(context, Uri.fromFile(imageFile))
      recognizer.process(image)
        .addOnSuccessListener { visionText ->
          resultText = visionText.text
          android.util.Log.i("OcrBridge", "success textLen=${visionText.text.length}")
          latch.countDown()
        }
        .addOnFailureListener { e ->
          android.util.Log.w("OcrBridge", "recognition failed", e)
          latch.countDown()
        }
      if (!latch.await(15, TimeUnit.SECONDS)) {
        android.util.Log.w("OcrBridge", "timeout waiting for ML Kit")
        return ""
      }
    } catch (e: Exception) {
      android.util.Log.w("OcrBridge", "exception", e)
      return ""
    }
    return resultText
  }
}
