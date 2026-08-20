# 收藏（当前执行文档）

## 产品边界

当前只维护免费本地版，只保留首页卡片分组。

明确不在当前实现中的内容：

- 知识库、知识图谱和流墙
- 收藏夹批量同步
- `safe-xhs` 或其他自动抓取器
- 小红书登录态和账号切换
- AI 聊天、远程模型配置和聚合知识库

## 当前调用链

1. 用户从小红书搜索页拖动一条笔记卡片
2. `browser-extension/content.js` 只把卡片已有的链接和标题写入拖拽载荷
3. `POST /notes/import` 调用无 Cookie 的本地匿名解析器读取这一条公开笔记页面
4. Sidecar 把配图保存到本地并调用 macOS Vision OCR
5. 标题、正文与图片文字参与本地分类
6. `app/components/DeskView.tsx` 把新笔记放入“新进笔记”，保留原有卡片与分组动效

扩展没有 `tabs` 或 `cookies` 权限，不能后台打开登录页面或读取账号凭证。匿名解析器显式使用 `credentials: omit`，失败时不会回退到登录浏览器。这条链路只处理用户拖入的单条笔记，不访问收藏夹。

### B 站解析器边界例外

小红书解析器全程自报 UA（`ShouCangFavorites/0.1`），不伪装。B 站解析器有两处不同（透明披露）：

- **UA 伪装**：B 站拒绝非浏览器 UA 请求，解析器使用 Chrome 151 UA（仅限 B 站，小红书保持自报）。代码：`scripts/lib/bilibili-resolver.mjs:5` / `src-tauri/src/server/bilibili_resolver.rs:4`
- **buvid3 匿名指纹**：B 站 opus 图文接口（`/x/polymer/web-dynamic/v1/opus/detail`）硬性要求 `buvid3` Cookie，否则返回 412。指纹格式为 `uuid{hex16}infoc`，每安装生成一次并持久化复用，不携带登录态或账号信息。代码：`scripts/lib/bilibili-resolver.mjs:49-78` / `src-tauri/src/server/bilibili_resolver.rs:96-145`

## 主要文件

- `app/components/DeskView.tsx`：首页、卡片分组、整页拖入反馈
- `app/lib/xhs-client.ts`：前端访问本地服务
- `app/lib/desk-workspace.mjs`：分组状态
- `scripts/local-api.mjs`：本地存储 API
- `scripts/lib/anonymous-note-resolver.mjs`：不带账号凭证的单条公开页面解析
- `scripts/lib/note-import.mjs`：拖拽载荷校验、标准化和去重
- `scripts/lib/media-import.mjs`：配图本地化与本地 OCR
- `browser-extension/`：卡片拖拽与当前详情页的本地读取

## 验证命令

```bash
npm test
npm run lint
npm run build
cargo test        # 在 src-tauri/ 下：Rust sidecar 移植 + HTTP 契约测试（57 个）
```

## Android 移植（2026-08-13，模拟器验证通过）

架构：Android 上无 node.exe，`lib.rs` 的 android 分支在进程内起 **Rust sidecar**（`src-tauri/src/server/`，axum + tokio，端口 4318，API 契约与桌面 local-api.mjs 完全一致，前端零改动）。前端资源由 `tauri/custom-protocol` 编译期嵌入 `.so`（**不经过 Android assets 目录**，`_next` 无打包问题）。分享接收：`SEND` intent → `MainActivity.kt`（addJavascriptInterface bridge + 双通道注入）→ `app/lib/share-receive.ts`。

### Android 构建命令（全手动流程，绕过 tauri CLI 的两个 Windows bug）

```powershell
# 0. 前置：npm run build 产出 dist；模拟器/设备 adb 已连接
# 1. Rust 交叉编译（必须带 custom-protocol；ring 交叉编译需 NDK 工具链变量）
$ndk = "D:\Android\ndk\26.3.11579264\toolchains\llvm\prebuilt\windows-x86_64\bin"
$env:CC_aarch64_linux_android = "$ndk\aarch64-linux-android24-clang.cmd"
$env:AR_aarch64_linux_android = "$ndk\llvm-ar.exe"
$env:CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER = "$ndk\aarch64-linux-android24-clang.cmd"
$env:JAVA_HOME = "D:\Android\jdk-17.0.20+8"; $env:ANDROID_HOME = "D:\Android"
cargo build --target aarch64-linux-android --features tauri/custom-protocol   # src-tauri/ 下
Copy-Item src-tauri\target\aarch64-linux-android\debug\libshoucang.so `
  src-tauri\gen\android\app\src\main\jniLibs\arm64-v8a\libshoucang.so -Force
# 2. APK（-x rustBuildArm64Debug 跳过 gradle 内 npm 调用，因 tauri-cli android-studio-script 在 Windows 崩溃）
gradlew :app:assembleArm64Debug --no-daemon -x rustBuildArm64Debug   # src-tauri\gen\android 下
# 3. 部署验证
adb install -r <apk>; adb shell pm clear com.patrick.shoucang; adb shell am start -n com.patrick.shoucang/.MainActivity
adb shell "cat /proc/net/unix" | Select-String webview_devtools   # 取新 pid
adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
adb forward tcp:14318 tcp:4318; Invoke-RestMethod http://127.0.0.1:14318/health
```

### Android 踩坑记录

- 中文路径（D:\收藏apk版）触发 AGP path check → `gen/android/gradle.properties` 已加 `android.overridePathCheck=true`
- tauri CLI `android build` 在 Windows 失败于：symlink 权限（未开开发者模式）、`android-studio-script` 崩溃（读 server-addr 文件）→ 全手动流程
- `pm clear` 后 WebView 缓存可能导致旧前端残留 → 验证时先 pm clear 再启动
- 分享 intent 经 adb 传中文/空格会错乱 → 测试用 CDP 注入或 ASCII
- 调试入口：`chrome://inspect`（adb forward + CDP）；Rust server 日志看 `ShoucangShare` 前缀 logcat

### Android 已知限制（后续 Phase）

- OCR：**已接入**（ML Kit Text Recognition v2 bundled 中文，`OcrBridge.kt` 异步 submit/poll + `POST /notes/{id}/ocr` 回写，模拟器验证中文识别通过，不阻塞页面）；首次识别需 ~4s 模型加载（已缓存）
- 语义模型 WASM：**已工作**（e5-base int8 282MB 内置：模型部署 assets→数据目录、`GET /models/{path}` 路由、onnxruntime asyncify wasm 本地化、CSP 放行；前端绕过 transformers.js 4.2.0 的 get_tokenizer_files URL 本地探测缺陷——手动加载 tokenizer 文件直接构造 + AutoModel forward 提取 last_hidden_state；模拟器验证 embed 与语义搜索命中）
- AI 分类（deepseek-v4-flash）未移植（规则分类已工作，见 `server/category.rs`）
- 真实 XHS 链接解析/媒体下载未在真机验证（需网络 + 真机）

## 接口

- `GET /health`
- `GET /notes`
- `POST /notes/import`
- `GET /media/:noteId/:file`
