package com.smartlocalnote.android

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Base64
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
import com.smartlocalnote.android.data.OfflineItem
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
  STICKY,
  SHELF,
  NOTES_DIR,
}

@Composable
private fun ShareReceiverSheet(
  prefs: AppPrefs,
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
    isFileShare && payload.mimeType.startsWith("image/") -> "🖼️ 分享图片到电脑"
    isFileShare && payload.mimeType.contains("pdf", ignoreCase = true) -> "📄 分享 PDF 到电脑"
    isFileShare -> "📎 分享文件到电脑"
    else -> "📝 分享内容到 SmartLocalNote"
  }

  fun dispatch(action: ShareTargetAction) {
    if (isSubmitting) return
    scope.launch {
      isSubmitting = true
      progressLabel = "正在发送…"

      val textContent = payload.text.trim()
      val uri = payload.streamUri

      if (uri != null) {
        val readFile = withContext(Dispatchers.IO) { DeviceHelper.readUriFile(context, uri) }
        if (readFile == null) {
          isSubmitting = false
          onDone("读取分享文件失败或文件超过 25MB")
          return@launch
        }
        val addToShelf = action != ShareTargetAction.NOTES_DIR

        if (prefs.isPaired) {
          progressLabel = "正在直传 ${readFile.filename}…"
          val uploadRes = SlnApiClient.uploadFile(
            host = prefs.host,
            port = prefs.port,
            token = prefs.token,
            filename = readFile.filename,
            bytes = readFile.bytes,
            addToShelf = addToShelf,
          )
          if (uploadRes.ok) {
            if (action == ShareTargetAction.STICKY) {
              val noteBody = buildString {
                append("📎 已传文件：${readFile.filename}")
                if (textContent.isNotBlank()) append("\n$textContent")
              }
              SlnApiClient.sendQuickSticky(prefs.host, prefs.port, prefs.token, noteBody, "blue")
            }
            DeviceHelper.hapticTick(context)
            val msg = when (action) {
              ShareTargetAction.STICKY -> "📌 文件已传并弹出电脑闪念卡"
              ShareTargetAction.SHELF -> "📥 文件已放入电脑灵动岛暂存"
              ShareTargetAction.NOTES_DIR -> "📁 文件已存入电脑笔记目录"
            }
            onDone(msg)
            return@launch
          }
        }

        // Offline queue fallback for files
        if (readFile.bytes.size <= DeviceHelper.MAX_OFFLINE_FILE_BYTES) {
          val b64 = withContext(Dispatchers.Default) {
            Base64.encodeToString(readFile.bytes, Base64.NO_WRAP)
          }
          prefs.enqueueOffline(
            OfflineItem(
              kind = "upload",
              filename = readFile.filename,
              base64 = b64,
              addToShelf = addToShelf,
            ),
          )
          if (action == ShareTargetAction.STICKY) {
            prefs.enqueueOffline(
              OfflineItem(
                kind = "sticky",
                text = "📎 已传文件：${readFile.filename}" +
                  if (textContent.isNotBlank()) "\n$textContent" else "",
                color = "blue",
              ),
            )
          }
          DeviceHelper.hapticTick(context)
          onDone("📥 当前离线，已写入本地同步队列")
        } else {
          onDone("当前无法连接电脑，且文件超过 6MB 暂不支持离线队列")
        }
        return@launch
      }

      // Text / URL share
      when (action) {
        ShareTargetAction.STICKY -> {
          if (prefs.isPaired) {
            val res = SlnApiClient.sendQuickSticky(prefs.host, prefs.port, prefs.token, textContent, "yellow")
            if (res.ok) {
              DeviceHelper.hapticTick(context)
              onDone("📌 已弹为电脑闪念卡")
              return@launch
            }
          }
          prefs.enqueueOffline(OfflineItem(kind = "sticky", text = textContent, color = "yellow"))
          DeviceHelper.hapticTick(context)
          onDone("📥 当前离线，闪念已入队等待同步")
        }

        ShareTargetAction.SHELF -> {
          if (prefs.isPaired) {
            val res = SlnApiClient.sendClipboard(prefs.host, prefs.port, prefs.token, textContent)
            if (res.ok) {
              DeviceHelper.hapticTick(context)
              onDone("📥 已放入电脑灵动岛暂存")
              return@launch
            }
          }
          prefs.enqueueOffline(OfflineItem(kind = "clipboard", text = textContent))
          DeviceHelper.hapticTick(context)
          onDone("📥 当前离线，已加入同步队列")
        }

        ShareTargetAction.NOTES_DIR -> {
          val stamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())
          val filename = "手机分享_$stamp.md"
          val mdContent = buildString {
            append("# 手机分享剪藏\n\n")
            append("- 时间：${SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.getDefault()).format(Date())}\n\n")
            append(textContent)
            append("\n")
          }
          val bytes = mdContent.toByteArray(Charsets.UTF_8)
          if (prefs.isPaired) {
            val res = SlnApiClient.uploadFile(
              host = prefs.host,
              port = prefs.port,
              token = prefs.token,
              filename = filename,
              bytes = bytes,
              addToShelf = false,
            )
            if (res.ok) {
              DeviceHelper.hapticTick(context)
              onDone("📁 已保存为电脑笔记：$filename")
              return@launch
            }
          }
          val b64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
          prefs.enqueueOffline(
            OfflineItem(
              kind = "upload",
              filename = filename,
              base64 = b64,
              addToShelf = false,
            ),
          )
          DeviceHelper.hapticTick(context)
          onDone("📥 当前离线，笔记文件已入队等待同步")
        }
      }
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
              text = if (prefs.isPaired) {
                "电脑：${prefs.hostName.ifBlank { prefs.host }}（断网自动入队）"
              } else {
                "未配对 · 将自动保存到本地离线同步队列"
              },
              style = MaterialTheme.typography.bodySmall,
              color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
          }
          TextButton(onClick = onCancel, enabled = !isSubmitting) {
            Text("取消")
          }
        }

        // Content Preview Box
        Surface(
          shape = RoundedCornerShape(12.dp),
          color = MaterialTheme.colorScheme.surfaceContainer,
          modifier = Modifier.fillMaxWidth(),
        ) {
          val previewText = when {
            payload.text.isNotBlank() && payload.streamUri != null ->
              "${payload.text}\n（附带文件：${payload.streamUri.lastPathSegment ?: payload.mimeType}）"
            payload.text.isNotBlank() -> payload.text
            else -> "待发送文件：${payload.streamUri?.lastPathSegment ?: payload.mimeType.ifBlank { "未知文件" }}"
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
            onClick = { dispatch(ShareTargetAction.STICKY) },
            modifier = Modifier
              .fillMaxWidth()
              .height(48.dp),
            shape = RoundedCornerShape(12.dp),
          ) {
            Text("📌 弹为电脑闪念卡", fontWeight = FontWeight.SemiBold)
          }

          FilledTonalButton(
            onClick = { dispatch(ShareTargetAction.SHELF) },
            modifier = Modifier
              .fillMaxWidth()
              .height(48.dp),
            shape = RoundedCornerShape(12.dp),
          ) {
            Text("📥 放进电脑灵动岛暂存", fontWeight = FontWeight.Medium)
          }

          OutlinedButton(
            onClick = { dispatch(ShareTargetAction.NOTES_DIR) },
            modifier = Modifier
              .fillMaxWidth()
              .height(46.dp),
            shape = RoundedCornerShape(12.dp),
          ) {
            Text("📁 存入电脑笔记目录")
          }
        }
      }
    }
  }
}
