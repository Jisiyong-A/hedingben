# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# ── WebView JS 桥接（addJavascriptInterface 反射调用，混淆即断）──
# ShareBridge / OcrBridge / ExtensionBridge 由前端通过 window.<name>.<method>() 调用，
# 方法名被 JS 侧硬编码，R8 重命名或移除将导致分享导入/OCR/扩展下载全部失效。
-keepclassmembers class com.patrick.shoucang.MainActivity$ShareBridge { public *; }
-keep class com.patrick.shoucang.OcrBridge { public *; }
-keep class com.patrick.shoucang.ExtensionBridge { public *; }
-keepattributes *Annotation*
-keepclassmembers class ** {
    @android.webkit.JavascriptInterface <methods>;
}

# 保留 WebView 前端经反射触达的 Kotlin 对象方法签名
-dontwarn com.patrick.shoucang.**

# Uncomment this to preserve the line number information for
# debugging stack traces.
-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
-renamesourcefileattribute SourceFile
