package com.smartlocalnote.android.ui

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.smartlocalnote.android.data.AppPrefs
import com.smartlocalnote.android.util.DeviceHelper
import org.json.JSONObject

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun WorkbenchScreen(
  prefs: AppPrefs,
  initialAction: String? = null,
  onOpenQuickCapture: () -> Unit,
  onOpenConnectSettings: () -> Unit,
  onExitApp: () -> Unit,
) {
  val context = LocalContext.current
  val mainHandler = remember { Handler(Looper.getMainLooper()) }

  val latestQuickCapture by rememberUpdatedState(onOpenQuickCapture)
  val latestConnectSettings by rememberUpdatedState(onOpenConnectSettings)
  val latestExitApp by rememberUpdatedState(onExitApp)

  var webViewRef by remember { mutableStateOf<WebView?>(null) }
  var isLoading by remember { mutableStateOf(true) }
  var loadProgress by remember { mutableIntStateOf(0) }
  var errorMessage by remember { mutableStateOf<String?>(null) }
  var pendingFileCallback by remember { mutableStateOf<ValueCallback<Array<Uri>>?>(null) }
  var pendingOfflineCount by remember { mutableIntStateOf(prefs.pendingOfflineCount()) }

  val targetUrl = remember(prefs.host, prefs.port, prefs.token, initialAction) {
    buildWorkbenchUrl(prefs, initialAction)
  }

  val fileChooserLauncher = rememberLauncherForActivityResult(
    contract = ActivityResultContracts.StartActivityForResult(),
  ) { result ->
    val callback = pendingFileCallback
    pendingFileCallback = null
    if (callback == null) return@rememberLauncherForActivityResult

    if (result.resultCode != Activity.RESULT_OK || result.data == null) {
      callback.onReceiveValue(null)
      return@rememberLauncherForActivityResult
    }
    val data = result.data!!
    val uris = mutableListOf<Uri>()
    val clipData = data.clipData
    if (clipData != null && clipData.itemCount > 0) {
      for (i in 0 until clipData.itemCount) {
        clipData.getItemAt(i)?.uri?.let(uris::add)
      }
    } else {
      data.data?.let(uris::add)
    }
    if (uris.isNotEmpty()) {
      callback.onReceiveValue(uris.toTypedArray())
    } else {
      callback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result.resultCode, data))
    }
  }

  fun reloadWorkbench() {
    errorMessage = null
    isLoading = true
    pendingOfflineCount = prefs.pendingOfflineCount()
    val wv = webViewRef ?: return
    syncTokenCookie(prefs)
    val headers = if (prefs.token.isNotBlank()) {
      mapOf("X-SLN-Token" to prefs.token)
    } else {
      emptyMap()
    }
    wv.loadUrl(targetUrl, headers)
  }

  // Reload if initialAction changes (e.g., tapped "open_todos" widget while already open)
  LaunchedEffect(targetUrl) {
    pendingOfflineCount = prefs.pendingOfflineCount()
    val wv = webViewRef
    if (wv != null && wv.url != targetUrl && errorMessage == null) {
      reloadWorkbench()
    }
  }

  BackHandler(enabled = true) {
    if (errorMessage != null) {
      latestConnectSettings()
      return@BackHandler
    }
    val wv = webViewRef
    if (wv == null) {
      latestExitApp()
      return@BackHandler
    }
    val jsCheck = "(function(){try{return typeof window.__SLN_HANDLE_BACK__==='function'?!!window.__SLN_HANDLE_BACK__():false;}catch(e){return false;}})();"
    wv.evaluateJavascript(jsCheck) { rawResult ->
      val handled = rawResult?.trim()?.equals("true", ignoreCase = true) == true
      if (!handled) {
        if (wv.canGoBack()) {
          wv.goBack()
        } else {
          latestExitApp()
        }
      }
    }
  }

  DisposableEffect(Unit) {
    onDispose {
      pendingFileCallback?.onReceiveValue(null)
      pendingFileCallback = null
      webViewRef?.let { wv ->
        wv.removeJavascriptInterface("SmartLocalNoteAndroid")
        wv.stopLoading()
        wv.destroy()
      }
      webViewRef = null
    }
  }

  Box(
    modifier = Modifier
      .fillMaxSize()
      .background(MaterialTheme.colorScheme.background)
      .windowInsetsPadding(WindowInsets.safeDrawing),
  ) {
    AndroidView(
      modifier = Modifier.fillMaxSize(),
      factory = { ctx ->
        WebView(ctx).apply {
          settings.javaScriptEnabled = true
          settings.domStorageEnabled = true
          settings.allowFileAccess = true
          settings.allowContentAccess = true
          settings.loadWithOverviewMode = true
          settings.useWideViewPort = true
          settings.setSupportZoom(false)
          settings.builtInZoomControls = false
          settings.displayZoomControls = false
          settings.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
          settings.cacheMode = WebSettings.LOAD_DEFAULT
          settings.userAgentString = "${settings.userAgentString} SmartLocalNoteAndroid/7.5.0"

          isVerticalScrollBarEnabled = false
          isHorizontalScrollBarEnabled = false

          val cookieManager = CookieManager.getInstance()
          cookieManager.setAcceptCookie(true)
          cookieManager.setAcceptThirdPartyCookies(this, true)
          syncTokenCookie(prefs)

          val bridge = object {
            @JavascriptInterface
            fun getToken(): String = prefs.token

            @JavascriptInterface
            fun getHostInfo(): String {
              return JSONObject().apply {
                put("host", prefs.host)
                put("port", prefs.port)
                put("hostName", prefs.hostName.ifBlank { prefs.host })
                put("baseUrl", prefs.baseUrl())
                put("appVersion", "7.5.0")
                put("pendingOfflineCount", prefs.pendingOfflineCount())
              }.toString()
            }

            @JavascriptInterface
            fun readClipboard(): String = DeviceHelper.readClipboard(ctx)

            @JavascriptInterface
            fun writeClipboard(text: String?) {
              DeviceHelper.writeClipboard(ctx, text.orEmpty())
            }

            @JavascriptInterface
            fun openQuickCapture() {
              mainHandler.post { latestQuickCapture() }
            }

            @JavascriptInterface
            fun openConnectSettings() {
              mainHandler.post { latestConnectSettings() }
            }

            @JavascriptInterface
            fun hapticTick() {
              DeviceHelper.hapticTick(ctx)
            }

            @JavascriptInterface
            fun showNativeToast(msg: String?) {
              val clean = msg?.trim().orEmpty()
              if (clean.isNotEmpty()) {
                mainHandler.post {
                  Toast.makeText(ctx, clean, Toast.LENGTH_SHORT).show()
                }
              }
            }
          }
          addJavascriptInterface(bridge, "SmartLocalNoteAndroid")

          webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
              if (url != "about:blank") {
                isLoading = true
              }
            }

            override fun onPageFinished(view: WebView?, url: String?) {
              if (url != "about:blank") {
                isLoading = false
              }
            }

            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
              val uri = request?.url ?: return false
              val scheme = uri.scheme?.lowercase().orEmpty()
              if (scheme == "sln") {
                return true
              }
              if (scheme != "http" && scheme != "https" && scheme != "about" && scheme != "blob" && scheme != "data") {
                try {
                  ctx.startActivity(Intent(Intent.ACTION_VIEW, uri))
                } catch (_: Exception) {
                }
                return true
              }
              return false
            }

            override fun onReceivedError(
              view: WebView?,
              request: WebResourceRequest?,
              error: WebResourceError?,
            ) {
              if (request?.isForMainFrame != true) return
              val code = error?.errorCode ?: 0
              val desc = error?.description?.toString().orEmpty()
              isLoading = false
              pendingOfflineCount = prefs.pendingOfflineCount()
              errorMessage = mapWebViewError(code, desc)
              view?.loadUrl("about:blank")
            }

            override fun onReceivedHttpError(
              view: WebView?,
              request: WebResourceRequest?,
              errorResponse: WebResourceResponse?,
            ) {
              if (request?.isForMainFrame != true) return
              val status = errorResponse?.statusCode ?: 0
              if (status >= 500) {
                isLoading = false
                pendingOfflineCount = prefs.pendingOfflineCount()
                errorMessage = "桌面端服务返回错误（HTTP $status）"
                view?.loadUrl("about:blank")
              }
            }
          }

          webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
              loadProgress = newProgress
            }

            override fun onShowFileChooser(
              webView: WebView?,
              filePathCallback: ValueCallback<Array<Uri>>?,
              fileChooserParams: FileChooserParams?,
            ): Boolean {
              pendingFileCallback?.onReceiveValue(null)
              pendingFileCallback = filePathCallback
              return try {
                val chooserIntent = fileChooserParams?.createIntent() ?: Intent(Intent.ACTION_GET_CONTENT).apply {
                  addCategory(Intent.CATEGORY_OPENABLE)
                  type = "*/*"
                }
                if (fileChooserParams?.mode == FileChooserParams.MODE_OPEN_MULTIPLE) {
                  chooserIntent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                }
                fileChooserLauncher.launch(chooserIntent)
                true
              } catch (_: Exception) {
                pendingFileCallback?.onReceiveValue(null)
                pendingFileCallback = null
                Toast.makeText(ctx, "无法打开系统文件选择器", Toast.LENGTH_SHORT).show()
                false
              }
            }
          }

          webViewRef = this
          val headers = if (prefs.token.isNotBlank()) {
            mapOf("X-SLN-Token" to prefs.token)
          } else {
            emptyMap()
          }
          loadUrl(targetUrl, headers)
        }
      },
    )

    // Subtle top loading progress bar
    if (isLoading && errorMessage == null && loadProgress in 1..99) {
      LinearProgressIndicator(
        progress = { loadProgress / 100f },
        modifier = Modifier
          .fillMaxWidth()
          .height(3.dp)
          .align(Alignment.TopCenter),
        color = MaterialTheme.colorScheme.primary,
        trackColor = MaterialTheme.colorScheme.surfaceVariant,
      )
    }

    // Native offline / connection-error recovery overlay
    if (errorMessage != null) {
      Surface(
        modifier = Modifier.fillMaxSize(),
        color = MaterialTheme.colorScheme.background,
      ) {
        Box(
          modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
          contentAlignment = Alignment.Center,
        ) {
          Card(
            shape = RoundedCornerShape(22.dp),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.7f)),
            modifier = Modifier.fillMaxWidth(),
          ) {
            Column(
              modifier = Modifier
                .fillMaxWidth()
                .padding(24.dp),
              horizontalAlignment = Alignment.CenterHorizontally,
              verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
              Text(
                text = "📡",
                style = MaterialTheme.typography.displaySmall,
              )
              Text(
                text = "暂时无法连接到电脑工作台",
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.Bold,
                textAlign = TextAlign.Center,
              )
              Text(
                text = errorMessage.orEmpty(),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
              )
              Surface(
                shape = RoundedCornerShape(10.dp),
                color = MaterialTheme.colorScheme.surfaceContainer,
              ) {
                Text(
                  text = "${prefs.hostName.ifBlank { "电脑" }} · ${prefs.baseUrl()}",
                  style = MaterialTheme.typography.labelMedium,
                  color = MaterialTheme.colorScheme.onSurfaceVariant,
                  modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                )
              }

              Spacer(Modifier.height(4.dp))

              Button(
                onClick = {
                  DeviceHelper.hapticTick(context)
                  reloadWorkbench()
                },
                modifier = Modifier
                  .fillMaxWidth()
                  .height(48.dp),
                shape = RoundedCornerShape(12.dp),
              ) {
                Text("🔄 重新连接电脑", fontWeight = FontWeight.SemiBold)
              }

              FilledTonalButton(
                onClick = {
                  DeviceHelper.hapticTick(context)
                  onOpenQuickCapture()
                },
                modifier = Modifier
                  .fillMaxWidth()
                  .height(48.dp),
                shape = RoundedCornerShape(12.dp),
              ) {
                val suffix = if (pendingOfflineCount > 0) "（$pendingOfflineCount 条待同步）" else ""
                Text("⚡ 离线速记（断网可用）$suffix", fontWeight = FontWeight.Medium)
              }

              OutlinedButton(
                onClick = { onOpenConnectSettings() },
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(12.dp),
              ) {
                Text("⚙️ 切换电脑 / 重新配对")
              }
            }
          }
        }
      }
    }
  }
}

private fun buildWorkbenchUrl(prefs: AppPrefs, initialAction: String?): String {
  val base = prefs.baseUrl().trimEnd('/')
  val params = mutableListOf("mobile=1")
  if (prefs.token.isNotBlank()) {
    params.add("token=${Uri.encode(prefs.token)}")
  }
  if (!initialAction.isNullOrBlank()) {
    params.add("action=${Uri.encode(initialAction)}")
  }
  return "$base/?${params.joinToString("&")}"
}

private fun syncTokenCookie(prefs: AppPrefs) {
  try {
    if (prefs.host.isNotBlank() && prefs.token.isNotBlank()) {
      val cm = CookieManager.getInstance()
      cm.setCookie(prefs.baseUrl(), "sln_token=${prefs.token}; path=/")
      cm.flush()
    }
  } catch (_: Exception) {
  }
}

private fun mapWebViewError(code: Int, desc: String): String {
  return when {
    desc.contains("ERR_CONNECTION_REFUSED", ignoreCase = true) ->
      "电脑端 SmartLocalNote 似乎未启动，请先在电脑打开桌面程序"
    desc.contains("ERR_CONNECTION_TIMED_OUT", ignoreCase = true) ||
      desc.contains("ERR_TIMED_OUT", ignoreCase = true) ->
      "连接超时，请确认手机与电脑处于同一 Wi-Fi 或已连接 Tailscale"
    desc.contains("ERR_INTERNET_DISCONNECTED", ignoreCase = true) ||
      desc.contains("ERR_ADDRESS_UNREACHABLE", ignoreCase = true) ||
      desc.contains("ERR_NETWORK_CHANGED", ignoreCase = true) ->
      "当前处于离线或局域网不可达状态，可以先使用离线速记，联网后自动同步"
    desc.isNotBlank() -> "连接中断（$desc）"
    else -> "网络请求失败（错误码 $code）"
  }
}
