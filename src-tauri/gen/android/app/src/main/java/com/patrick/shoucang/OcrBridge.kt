package com.patrick.shoucang

import android.content.Context
import android.net.Uri
import android.webkit.JavascriptInterface
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * ML Kit 本地 OCR bridge（异步版）—— 供 WebView 前端调用（window.OcrBridge）。
 *
 * 同步识别会阻塞 WebView JS 线程（首次 ~4s 模型加载 + 每张图识别），导致页面
 * 冻结、健康轮询超时。改为 submit/poll 两段式：
 *   submit(noteId, file) —— 后台线程识别，完成结果存入内存 map（非阻塞）
 *   poll(noteId, file)   —— 返回结果或 ""（未完成），前端轮询直到非空/超时
 * ML Kit bundled 模型打进 APK（zh-Hans/zh-Hant/en），完全离线。
 */
class OcrBridge(private val context: Context) {

  private val recognizer = TextRecognition.getClient(
    ChineseTextRecognizerOptions.Builder().build()
  )
  private val executor = Executors.newFixedThreadPool(2)
  private val results = ConcurrentHashMap<String, String>()

  /** 提交识别任务；同一 noteId/file 幂等（已有结果直接返回，不重复提交） */
  @JavascriptInterface
  fun submit(noteId: String, file: String) {
    val key = keyOf(noteId, file)
    if (results.containsKey(key)) return
    val safeFile = file.replace(Regex("[^0-9a-zA-Z._-]"), "")
    val imageFile = File(context.dataDir, "media/$noteId/$safeFile")
    if (!imageFile.isFile) {
      results.put(key, "")
      return
    }
    executor.execute {
      var text = ""
      try {
        val image = InputImage.fromFilePath(context, Uri.fromFile(imageFile))
        val visionText = Tasks.await(
          recognizer.process(image),
          20,
          java.util.concurrent.TimeUnit.SECONDS
        )
        text = visionText.text
      } catch (e: Exception) {
        text = ""
      }
      results.put(key, text)
    }
  }

  /** 轮询识别结果；未完成或失败返回 "" */
  @JavascriptInterface
  fun poll(noteId: String, file: String): String {
    return results.get(keyOf(noteId, file)) ?: ""
  }

  private fun keyOf(noteId: String, file: String): String {
    return "$noteId/$file"
  }
}
