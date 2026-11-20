package com.smartlocalnote.android.ui

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Handler
import android.os.Looper
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
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
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
import com.smartlocalnote.android.local.LocalSlnServer
import com.smartlocalnote.android.util.DeviceHelper
import org.json.JSONObject

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun WorkbenchScreen(
  prefs: AppPrefs,
  localServer: LocalSlnServer,
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

  val targetUrl = remember(localServer.port, initialAction) {
    buildLocalWorkbenchUrl(localServer.port, initialAction)
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
    localServer.start()
    val wv = webViewRef ?: return
    wv.loadUrl(buildLocalWorkbenchUrl(localServer.port, initialAction))
  }

  // Reload if initialAction changes (e.g., tapped "open_todos" widget while already open)
  LaunchedEffect(targetUrl) {
    val wv = webViewRef
    if (wv != null && wv.url != targetUrl && errorMessage == null) {
      reloadWorkbench()
    }
  }

  BackHandler(enabled = true) {
    if (errorMessage != null) {
      reloadWorkbench()
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
          settings.userAgentString = "${settings.userAgentString} SmartLocalNoteAndroid/7.5.0 Standalone"

          isVerticalScrollBarEnabled = false
          isHorizontalScrollBarEnabled = false

          val bridge = object {
            @JavascriptInterface
            fun getToken(): String = prefs.token

            @JavascriptInterface
            fun getHostInfo(): String {
              return JSONObject().apply {
                put("standalone", true)
                put("localPort", localServer.port)
                put("host", prefs.host)
                put("port", prefs.port)
                put("hostName", prefs.hostName.ifBlank { prefs.host })
                put("isPaired", prefs.isPaired)
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
                // Redirect top-bar 📱 button to native Windows Sync Center without modifying static JS
                view?.evaluateJavascript(INJECT_SYNC_BUTTON_HOOK_JS, null)
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
              errorMessage = "本地工作台微引擎加载异常（$code $desc）"
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
                errorMessage = "本地微引擎返回错误（HTTP $status）"
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
          loadUrl(targetUrl)
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

    // Local recovery overlay (rarely shown since engine is 127.0.0.1 in-process)
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
              Text(text = "🛠️", style = MaterialTheme.typography.displaySmall)
              Text(
                text = "本地工作台需要重新加载",
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
                Text("🔄 重启本地引擎并加载", fontWeight = FontWeight.SemiBold)
              }
              OutlinedButton(
                onClick = { onOpenConnectSettings() },
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(12.dp),
              ) {
                Text("🔄 打开 Windows 双向同步中心")
              }
            }
          }
        }
      }
    }
  }
}

private fun buildLocalWorkbenchUrl(port: Int, initialAction: String?): String {
  val params = mutableListOf("mobile=1")
  if (!initialAction.isNullOrBlank()) {
    params.add("action=${Uri.encode(initialAction)}")
  }
  return "http://127.0.0.1:$port/?${params.joinToString("&")}"
}

private const val INJECT_SYNC_BUTTON_HOOK_JS = """
(function() {
  function hookBtn() {
    var btn = document.getElementById('btn-mobile-connect');
    if (!btn || btn.dataset.androidSyncHooked === '1') return;
    btn.dataset.androidSyncHooked = '1';
    btn.title = '与 Windows 电脑双向同步';
    btn.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (window.SmartLocalNoteAndroid && typeof window.SmartLocalNoteAndroid.openConnectSettings === 'function') {
        window.SmartLocalNoteAndroid.openConnectSettings();
      }
    }, true);
  }
  hookBtn();
  setTimeout(hookBtn, 600);
})();
"""
