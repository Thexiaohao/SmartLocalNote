package com.smartlocalnote.android

import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.lifecycleScope
import com.smartlocalnote.android.data.AppPrefs
import com.smartlocalnote.android.data.OfflineItem
import com.smartlocalnote.android.data.ParsedPairLink
import com.smartlocalnote.android.network.SlnApiClient
import com.smartlocalnote.android.ui.ConnectScreen
import com.smartlocalnote.android.ui.QuickCaptureScreen
import com.smartlocalnote.android.ui.WorkbenchScreen
import com.smartlocalnote.android.ui.theme.SmartLocalNoteTheme
import com.smartlocalnote.android.util.DeviceHelper
import kotlinx.coroutines.launch

sealed interface AppRoute {
  data object Connect : AppRoute
  data class Workbench(val initialAction: String? = null) : AppRoute
  data object QuickCapture : AppRoute
}

class MainActivity : ComponentActivity() {
  private lateinit var prefs: AppPrefs
  private var currentRoute by mutableStateOf<AppRoute>(AppRoute.Connect)
  private var prefilledPairLink by mutableStateOf<ParsedPairLink?>(null)
  private var pendingClipboardPush = false

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    prefs = AppPrefs(this)
    enableEdgeToEdge()

    handleIncomingIntent(intent, isInitialLaunch = true)

    setContent {
      SmartLocalNoteTheme {
        Surface(
          modifier = Modifier.fillMaxSize(),
          color = MaterialTheme.colorScheme.background,
        ) {
          // Background offline queue flush on startup when paired
          LaunchedEffect(Unit) {
            if (prefs.isPaired && prefs.pendingOfflineCount() > 0) {
              val res = SlnApiClient.flushOfflineQueue(prefs)
              if (res.syncedCount > 0) {
                Toast.makeText(
                  this@MainActivity,
                  "已自动同步 ${res.syncedCount} 条离线速记到电脑",
                  Toast.LENGTH_SHORT,
                ).show()
              }
            }
          }

          when (val route = currentRoute) {
            AppRoute.Connect -> ConnectScreen(
              prefs = prefs,
              prefilledLink = prefilledPairLink,
              onConnected = {
                prefilledPairLink = null
                currentRoute = AppRoute.Workbench()
              },
              onOpenQuickCapture = {
                currentRoute = AppRoute.QuickCapture
              },
            )

            is AppRoute.Workbench -> WorkbenchScreen(
              prefs = prefs,
              initialAction = route.initialAction,
              onOpenQuickCapture = {
                currentRoute = AppRoute.QuickCapture
              },
              onOpenConnectSettings = {
                currentRoute = AppRoute.Connect
              },
              onExitApp = {
                finish()
              },
            )

            AppRoute.QuickCapture -> QuickCaptureScreen(
              prefs = prefs,
              onBack = {
                currentRoute = if (prefs.isPaired) AppRoute.Workbench() else AppRoute.Connect
              },
              onOpenConnectSettings = {
                currentRoute = AppRoute.Connect
              },
            )
          }
        }
      }
    }
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    handleIncomingIntent(intent, isInitialLaunch = false)
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (hasFocus && pendingClipboardPush) {
      pendingClipboardPush = false
      executeClipboardPushFromWidget()
    }
  }

  private fun handleIncomingIntent(intent: Intent?, isInitialLaunch: Boolean) {
    // 1. Check sln://pair DeepLink
    val dataUri = intent?.data
    if (dataUri != null && dataUri.scheme.equals("sln", ignoreCase = true)) {
      val parsed = AppPrefs.parsePairingUri(dataUri.toString())
      if (parsed != null) {
        prefilledPairLink = parsed
        currentRoute = AppRoute.Connect
        return
      }
    }

    // 2. Check Desktop Widget extra_action
    val extraAction = intent?.getStringExtra(EXTRA_ACTION)?.trim().orEmpty()
    when (extraAction) {
      ACTION_QUICK_STICKY -> {
        currentRoute = AppRoute.QuickCapture
        return
      }
      ACTION_PUSH_CLIPBOARD -> {
        pendingClipboardPush = true
        currentRoute = if (prefs.isPaired) AppRoute.Workbench() else AppRoute.QuickCapture
        return
      }
      ACTION_OPEN_TODOS -> {
        currentRoute = if (prefs.isPaired) {
          AppRoute.Workbench(initialAction = ACTION_OPEN_TODOS)
        } else {
          AppRoute.Connect
        }
        return
      }
    }

    // 3. Default startup route
    if (isInitialLaunch) {
      currentRoute = if (prefs.isPaired) AppRoute.Workbench() else AppRoute.Connect
    }
  }

  private fun executeClipboardPushFromWidget() {
    val clip = DeviceHelper.readClipboard(this).trim()
    if (clip.isEmpty()) {
      Toast.makeText(this, "手机剪贴板为空", Toast.LENGTH_SHORT).show()
      return
    }
    lifecycleScope.launch {
      if (prefs.isPaired) {
        val res = SlnApiClient.sendClipboard(prefs.host, prefs.port, prefs.token, clip)
        if (res.ok) {
          DeviceHelper.hapticTick(this@MainActivity)
          Toast.makeText(this@MainActivity, "📋 已推送剪贴板到电脑", Toast.LENGTH_SHORT).show()
          return@launch
        }
      }
      prefs.enqueueOffline(OfflineItem(kind = "clipboard", text = clip))
      DeviceHelper.hapticTick(this@MainActivity)
      Toast.makeText(this@MainActivity, "📥 当前离线，剪贴板已入队待同步", Toast.LENGTH_SHORT).show()
    }
  }

  companion object {
    const val EXTRA_ACTION = "extra_action"
    const val ACTION_QUICK_STICKY = "quick_sticky"
    const val ACTION_PUSH_CLIPBOARD = "push_clipboard"
    const val ACTION_OPEN_TODOS = "open_todos"
  }
}
