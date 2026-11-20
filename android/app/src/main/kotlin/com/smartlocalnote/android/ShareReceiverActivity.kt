package com.smartlocalnote.android

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.smartlocalnote.android.data.AppPrefs
import com.smartlocalnote.android.local.LocalSlnServer
import com.smartlocalnote.android.network.SlnApiClient
import com.smartlocalnote.android.ui.theme.SmartLocalNoteTheme
import com.smartlocalnote.android.util.DeviceHelper
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private data class SharedPayload(
  val text: String = "",
  val subject: String = "",
  val streamUri: Uri? = null,
  val mimeType: String = "",
)

class ShareReceiverActivity : ComponentActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val prefs = AppPrefs(this)
    val localServer = LocalSlnServer.ensureStarted(this)
    val payload = extractSharedPayload(intent)

    if (payload.text.isBlank() && payload.streamUri == null) {
      Toast.makeText(this, "未检测到可分享的文本或文件", Toast.LENGTH_SHORT).show()
      finish()
      return
    }

    setContent {
      SmartLocalNoteTheme {
        ShareReceiverSheet(
          prefs = prefs,
          localServer = localServer,
          payload = payload,
          onDone = { toastMsg ->
            if (toastMsg.isNotBlank()) {
              Toast.makeText(this, toastMsg, Toast.LENGTH_SHORT).show()
            }
            finish()
          },
          onCancel = { finish() },
        )
      }
    }
  }

  private fun extractSharedPayload(intent: Intent?): SharedPayload {
    if (intent == null || intent.action != Intent.ACTION_SEND) return SharedPayload()
    val mime = intent.type.orEmpty()
    val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT)?.trim().orEmpty()
    val rawText = intent.getStringExtra(Intent.EXTRA_TEXT)?.trim().orEmpty()
    val combinedText = when {
      subject.isNotBlank() && rawText.isNotBlank() && !rawText.contains(subject) -> "$subject\n$rawText"
      rawText.isNotBlank() -> rawText
      else -> subject
    }
    @Suppress("DEPRECATION")
    val streamUri: Uri? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
    } else {
      intent.getParcelableExtra(Intent.EXTRA_STREAM)
    }
    return SharedPayload(
      text = combinedText,
      subject = subject,
      streamUri = streamUri,
      mimeType = mime,
    )
  }
}

private enum class ShareTargetAction {
  LOCAL_ONLY,
  LOCAL_AND_SYNC_PC,
  PC_STICKY,
}

@Composable
private fun ShareReceiverSheet(
  prefs: AppPrefs,
  localServer: LocalSlnServer,
  payload: SharedPayload,
  onDone: (String) -> Unit,
  onCancel: () -> Unit,
) {
  val context = androidx.compose.ui.platform.LocalContext.current
  val scope = rememberCoroutineScope()
  var isSubmitting by remember { mutableStateOf(false) }
  var progressLabel by remember { mutableStateOf("") }

  val isFileShare = payload.streamUri != null
  val previewTitle = when {
    isFileShare && payload.mimeType.startsWith("image/") -> "🖼️ 收集图片到 SmartLocalNote"
    isFileShare && payload.mimeType.contains("pdf", ignoreCase = true) -> "📄 收集 PDF 到 SmartLocalNote"
    isFileShare -> "📎 收集文件到 SmartLocalNote"
    else -> "📝 剪藏内容到 SmartLocalNote"
  }

  fun dispatch(action: ShareTargetAction) {
    if (isSubmitting) return
    scope.launch {
      isSubmitting = true
      progressLabel = "正在写入手机本地笔记库…"

      val textContent = payload.text.trim()
      val uri = payload.streamUri
      val dataEngine = localServer.dataEngine

      // 1. Always save locally first (works 100% offline in milliseconds!)
      if (uri != null) {
        val readFile = withContext(Dispatchers.IO) { DeviceHelper.readUriFile(context, uri) }
        if (readFile == null) {
          isSubmitting = false
          onDone("读取分享文件失败或文件超过 25MB")
          return@launch
        }

        val savedLocal = withContext(Dispatchers.IO) {
          dataEngine.saveRawBytes(
            filename = readFile.filename,
            bytes = readFile.bytes,
            targetDir = "手机收集",
            addToShelf = false,
          )
        }
        localServer.publishEvent("files:updated", savedLocal)
        localServer.publishEvent("mobile:upload", savedLocal)

        if (action == ShareTargetAction.LOCAL_ONLY) {
          DeviceHelper.hapticTick(context)
          onDone("✅ 已保存到手机本地：手机收集/${savedLocal.optString("name")}")
          return@launch
        }

        if (prefs.isPaired) {
          progressLabel = "已存手机，正在同步到电脑…"
          val uploadRes = SlnApiClient.uploadFile(
            host = prefs.host,
            port = prefs.port,
            token = prefs.token,
            filename = readFile.filename,
            bytes = readFile.bytes,
            addToShelf = action == ShareTargetAction.PC_STICKY,
            targetDir = "手机收集",
          )
          if (uploadRes.ok) {
            if (action == ShareTargetAction.PC_STICKY) {
              val noteBody = "📎 已同步文件：${readFile.filename}" +
                if (textContent.isNotBlank()) "\n$textContent" else ""
              SlnApiClient.sendQuickSticky(prefs.host, prefs.port, prefs.token, noteBody, "blue")
            }
            DeviceHelper.hapticTick(context)
            onDone("✅ 已存手机本地并同步到电脑：${readFile.filename}")
            return@launch
          }
        }

        DeviceHelper.hapticTick(context)
        onDone("✅ 已存手机本地（电脑暂未连通，回 Wi-Fi 后可一键双向同步）")
        return@launch
      }

      // Text / URL share -> save Markdown note in notes/手机收集/
      val stamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())
      val titlePrefix = payload.subject.take(24).ifBlank { "手机剪藏" }
      val mdContent = buildString {
        append("# $titlePrefix\n\n")
        append("- 收集时间：${SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.getDefault()).format(Date())}\n")
        append("- 标签：#手机收集 #随手记\n\n")
        append(textContent)
        append("\n")
      }
      val savedNote = withContext(Dispatchers.IO) {
        dataEngine.createNote(
          title = "${titlePrefix}_$stamp",
          content = mdContent,
          folderRel = "手机收集",
        )
      }
      localServer.publishEvent("files:updated", savedNote)
      localServer.publishEvent("mobile:upload", savedNote)

      if (action == ShareTargetAction.LOCAL_ONLY) {
        DeviceHelper.hapticTick(context)
        onDone("✅ 已保存到手机本地：手机收集/${savedNote.optString("name")}")
        return@launch
      }

      if (prefs.isPaired) {
        progressLabel = "已存手机，正在同步到电脑…"
        val syncOk = if (action == ShareTargetAction.PC_STICKY) {
          SlnApiClient.sendQuickSticky(prefs.host, prefs.port, prefs.token, textContent, "yellow").ok
        } else {
          SlnApiClient.uploadFile(
            host = prefs.host,
            port = prefs.port,
            token = prefs.token,
            filename = savedNote.optString("name", "手机剪藏_$stamp.md"),
            bytes = mdContent.toByteArray(Charsets.UTF_8),
            addToShelf = false,
            targetDir = "手机收集",
          ).ok
        }
        if (syncOk) {
          DeviceHelper.hapticTick(context)
          val msg = if (action == ShareTargetAction.PC_STICKY) {
            "✅ 已存手机本地并弹为电脑闪念卡"
          } else {
            "✅ 已存手机本地并同步到电脑"
          }
          onDone(msg)
          return@launch
        }
      }

      DeviceHelper.hapticTick(context)
      onDone("✅ 已保存到手机本地（电脑未连通，稍后可一键同步）")
    }
  }

  Box(
    modifier = Modifier
      .fillMaxSize()
      .background(Color.Black.copy(alpha = 0.25f))
      .clickable(
        indication = null,
        interactionSource = remember { MutableInteractionSource() },
      ) {
        if (!isSubmitting) onCancel()
      },
    contentAlignment = Alignment.BottomCenter,
  ) {
    Card(
      modifier = Modifier
        .fillMaxWidth()
        .windowInsetsPadding(WindowInsets.navigationBars)
        .padding(12.dp)
        .clickable(
          indication = null,
          interactionSource = remember { MutableInteractionSource() },
        ) {},
      shape = RoundedCornerShape(24.dp),
      colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
      border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.7f)),
    ) {
      Column(
        modifier = Modifier
          .fillMaxWidth()
          .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
      ) {
        Row(
          modifier = Modifier.fillMaxWidth(),
          verticalAlignment = Alignment.CenterVertically,
          horizontalArrangement = Arrangement.SpaceBetween,
        ) {
          Column(modifier = Modifier.weight(1f)) {
            Text(
              text = previewTitle,
              style = MaterialTheme.typography.titleMedium,
              fontWeight = FontWeight.Bold,
            )
            Text(
              text = "离线直存手机本地库（notes/手机收集/）",
              style = MaterialTheme.typography.bodySmall,
              color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
          }
          TextButton(onClick = onCancel, enabled = !isSubmitting) {
            Text("取消")
          }
        }

        Surface(
          shape = RoundedCornerShape(12.dp),
          color = MaterialTheme.colorScheme.surfaceContainer,
          modifier = Modifier.fillMaxWidth(),
        ) {
          val previewText = when {
            payload.text.isNotBlank() && payload.streamUri != null ->
              "${payload.text}\n（附带文件：${payload.streamUri.lastPathSegment ?: payload.mimeType}）"
            payload.text.isNotBlank() -> payload.text
            else -> "待保存文件：${payload.streamUri?.lastPathSegment ?: payload.mimeType.ifBlank { "未知文件" }}"
          }
          Text(
            text = previewText,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurface,
            maxLines = 4,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(12.dp),
          )
        }

        if (isSubmitting) {
          Row(
            modifier = Modifier
              .fillMaxWidth()
              .padding(vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.Center,
          ) {
            CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
            Spacer(Modifier.width(10.dp))
            Text(progressLabel.ifBlank { "正在处理…" }, style = MaterialTheme.typography.bodyMedium)
          }
        } else {
          Button(
            onClick = { dispatch(ShareTargetAction.LOCAL_ONLY) },
            modifier = Modifier
              .fillMaxWidth()
              .height(48.dp),
            shape = RoundedCornerShape(12.dp),
          ) {
            Text("📁 存入手机本地笔记（离线秒存）", fontWeight = FontWeight.SemiBold)
          }

          if (prefs.isPaired) {
            FilledTonalButton(
              onClick = { dispatch(ShareTargetAction.LOCAL_AND_SYNC_PC) },
              modifier = Modifier
                .fillMaxWidth()
                .height(48.dp),
              shape = RoundedCornerShape(12.dp),
            ) {
              Text("🔄 存手机并同步到电脑（${prefs.hostName.ifBlank { prefs.host }}）", fontWeight = FontWeight.Medium)
            }

            OutlinedButton(
              onClick = { dispatch(ShareTargetAction.PC_STICKY) },
              modifier = Modifier
                .fillMaxWidth()
                .height(46.dp),
              shape = RoundedCornerShape(12.dp),
            ) {
              Text("📌 存手机并弹为电脑闪念卡")
            }
          }
        }
      }
    }
  }
}
