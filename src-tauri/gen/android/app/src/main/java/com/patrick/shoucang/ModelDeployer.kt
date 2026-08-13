package com.patrick.shoucang

import android.content.Context
import java.io.File

/**
 * 语义模型部署：APK assets/models（构建期打入）→ 数据目录 models/（运行期首启拷贝）。
 * Rust sidecar 的 GET /models/{path} 从 <dataDir>/models 读取，前端 transformers.js
 * 以本地模式经 127.0.0.1:4318/models/ 加载 —— 模型不进入 .so 嵌入，避免膨胀。
 */
object ModelDeployer {

  private const val ASSET_ROOT = "models"
  private const val MARKER = ".deployed"

  fun ensure(context: Context) {
    val targetRoot = File(context.dataDir, ASSET_ROOT)
    val marker = File(targetRoot, MARKER)
    if (marker.exists()) return

    try {
      context.assets.list(ASSET_ROOT) ?: return
      targetRoot.mkdirs()
      copyDir(context, ASSET_ROOT, targetRoot)
      // 拷贝完成后写入标记，避免重复拷贝（~280MB 一次）
      marker.writeText("ok")
      android.util.Log.i("ModelDeployer", "models deployed to ${targetRoot.absolutePath}")
    } catch (e: Exception) {
      android.util.Log.w("ModelDeployer", "deploy failed: ${e.message}")
    }
  }

  private fun copyDir(context: Context, assetPath: String, targetDir: File) {
    val children = context.assets.list(assetPath) ?: return
    for (child in children) {
      val childAsset = "$assetPath/$child"
      val childTarget = File(targetDir, child)
      if (context.assets.list(childAsset)?.isNotEmpty() == true) {
        childTarget.mkdirs()
        copyDir(context, childAsset, childTarget)
      } else {
        context.assets.open(childAsset).use { input ->
          childTarget.outputStream().use { output -> input.copyTo(output) }
        }
      }
    }
  }
}
