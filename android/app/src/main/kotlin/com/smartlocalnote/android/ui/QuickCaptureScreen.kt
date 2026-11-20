package com.smartlocalnote.android.ui

import android.util.Base64
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.smartlocalnote.android.data.AppPrefs
import com.smartlocalnote.android.data.OfflineItem
import com.smartlocalnote.android.network.SlnApiClient
import com.smartlocalnote.android.ui.theme.StickyBlue
import com.smartlocalnote.android.ui.theme.StickyGreen
import com.smartlocalnote.android.ui.theme.StickyPink
import com.smartlocalnote.android.ui.theme.StickyPurple
import com.smartlocalnote.android.ui.theme.StickyYellow
import com.smartlocalnote.android.util.DeviceHelper
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private data class StickyColorOption(
  val key: String,
  val label: String,
  val color: Color,
)

private val STICKY_COLORS = listOf(
  StickyColorOption("yellow", "暖黄", StickyYellow),
  StickyColorOption("blue", "晴蓝", StickyBlue),
  StickyColorOption("green", "薄荷", StickyGreen),
  StickyColorOption("pink", "樱粉", StickyPink),
  StickyColorOption("purple", "丁香", StickyPurple),
)

@Composable
fun QuickCaptureScreen(
  prefs: AppPrefs,
  onBack: () -> Unit,
  onOpenConnectSettings: () -> Unit,
) {
  val context = LocalContext.current
  val scope = rememberCoroutineScope()

  var noteText by remember { mutableStateOf("") }
  var selectedColor by remember { mutableStateOf("yellow") }
  var isSending by remember { mutableStateOf(false) }
  var isSyncing by remember { mutableStateOf(false) }
  var statusBanner by remember { mutableStateOf<String?>(null) }
  var offlineQueue by remember { mutableStateOf(prefs.getOfflineQueue()) }

  BackHandler { onBack() }

  fun refreshQueue() {
    offlineQueue = prefs.getOfflineQueue()
  }

  fun syncNow() {
    if (isSyncing) return
    if (offlineQueue.isEmpty()) {
      Toast.makeText(context, "离线队列已清空", Toast.LENGTH_SHORT).show()
      return
    }
    scope.launch {
      isSyncing = true
      val res = SlnApiClient.flushOfflineQueue(prefs)
      refreshQueue()
      isSyncing = false
      if (res.syncedCount > 0) {
        DeviceHelper.hapticTick(context)
        statusBanner = "已同步 ${res.syncedCount} 条记录到电脑" +
          if (res.remainingCount > 0) "，剩余 ${res.remainingCount} 条" else ""
      } else {
        statusBanner = res.lastError.ifBlank { "暂时无法连接电脑，稍后再试" }
      }
    }
  }

  fun sendNote() {
    val clean = noteText.trim()
    if (clean.isEmpty()) {
      Toast.makeText(context, "先写点什么再发送吧", Toast.LENGTH_SHORT).show()
      return
    }
    scope.launch {
      isSending = true
      if (prefs.isPaired) {
        val res = SlnApiClient.sendQuickSticky(
          host = prefs.host,
          port = prefs.port,
          token = prefs.token,
          text = clean,
          color = selectedColor,
        )
        if (res.ok) {
          noteText = ""
          isSending = false
          DeviceHelper.hapticTick(context)
          statusBanner = "⚡ 已弹出为电脑闪念卡"
          Toast.makeText(context, "已发送到电脑", Toast.LENGTH_SHORT).show()
          return@launch
        }
      }
      // Offline fallback: enqueue locally
      prefs.enqueueOffline(
        OfflineItem(
          kind = "sticky",
          text = clean,
          color = selectedColor,
        ),
      )
      refreshQueue()
      noteText = ""
      isSending = false
      DeviceHelper.hapticTick(context)
      statusBanner = "📥 当前离线，已安全存入本地待同步队列"
      Toast.makeText(context, "已入队，联网后自动同步", Toast.LENGTH_SHORT).show()
    }
  }

  fun pushClipboardDirectly() {
    val clip = DeviceHelper.readClipboard(context).trim()
    if (clip.isEmpty()) {
      Toast.makeText(context, "剪贴板为空", Toast.LENGTH_SHORT).show()
      return
    }
    scope.launch {
      isSending = true
      if (prefs.isPaired) {
        val res = SlnApiClient.sendClipboard(prefs.host, prefs.port, prefs.token, clip)
        if (res.ok) {
          isSending = false
          DeviceHelper.hapticTick(context)
          statusBanner = "📋 已直推剪贴板到电脑灵动岛"
          Toast.makeText(context, "已推送到电脑剪贴板", Toast.LENGTH_SHORT).show()
          return@launch
        }
      }
      prefs.enqueueOffline(OfflineItem(kind = "clipboard", text = clip))
      refreshQueue()
      isSending = false
      DeviceHelper.hapticTick(context)
      statusBanner = "📥 离线状态：剪贴板已暂存待同步"
    }
  }

  val filePickerLauncher = rememberLauncherForActivityResult(
    contract = ActivityResultContracts.OpenDocument(),
  ) { uri ->
    if (uri == null) return@rememberLauncherForActivityResult
    scope.launch {
      isSending = true
      statusBanner = "正在读取文件…"
      val file = withContext(Dispatchers.IO) { DeviceHelper.readUriFile(context, uri) }
      if (file == null) {
        isSending = false
        statusBanner = "文件读取失败或超过 25MB 限制"
        return@launch
      }

      if (prefs.isPaired) {
        statusBanner = "正在直传 ${file.filename} (${DeviceHelper.formatFileSize(file.bytes.size.toLong())})…"
        val res = SlnApiClient.uploadFile(
          host = prefs.host,
          port = prefs.port,
          token = prefs.token,
          filename = file.filename,
          bytes = file.bytes,
          addToShelf = true,
        )
        if (res.ok) {
          isSending = false
          DeviceHelper.hapticTick(context)
          statusBanner = "✅ 已直传至电脑：${file.filename}"
          Toast.makeText(context, "文件已传至电脑", Toast.LENGTH_SHORT).show()
          return@launch
        }
      }

      // Offline file queue (safe size cap)
      if (file.bytes.size <= DeviceHelper.MAX_OFFLINE_FILE_BYTES) {
        val b64 = withContext(Dispatchers.Default) {
          Base64.encodeToString(file.bytes, Base64.NO_WRAP)
        }
        prefs.enqueueOffline(
          OfflineItem(
            kind = "upload",
            filename = file.filename,
            base64 = b64,
            addToShelf = true,
          ),
        )
        refreshQueue()
        isSending = false
        DeviceHelper.hapticTick(context)
        statusBanner = "📥 当前离线：${file.filename} 已加入本地同步队列"
      } else {
        isSending = false
        statusBanner = "当前无法连接电脑，且文件超过 6MB 暂不支持离线排队"
      }
    }
  }

  LaunchedEffect(Unit) {
    refreshQueue()
  }

  Surface(
    modifier = Modifier.fillMaxSize(),
    color = MaterialTheme.colorScheme.background,
  ) {
    Column(
      modifier = Modifier
        .fillMaxSize()
        .windowInsetsPadding(WindowInsets.safeDrawing),
    ) {
      // Top App Bar
      Row(
        modifier = Modifier
          .fillMaxWidth()
          .padding(horizontal = 8.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
      ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
          IconButton(onClick = onBack) {
            Icon(
              imageVector = Icons.AutoMirrored.Rounded.ArrowBack,
              contentDescription = "返回",
            )
          }
          Column {
            Text(
              text = "⚡ 速记与快传",
              style = MaterialTheme.typography.titleMedium,
              fontWeight = FontWeight.Bold,
            )
            Text(
              text = if (prefs.isPaired) {
                "目标电脑：${prefs.hostName.ifBlank { prefs.host }}（断网自动入队）"
              } else {
                "离线模式 · 记录保存在本地，配对后一键同步"
              },
              style = MaterialTheme.typography.bodySmall,
              color = MaterialTheme.colorScheme.onSurfaceVariant,
              maxLines = 1,
              overflow = TextOverflow.Ellipsis,
            )
          }
        }
        IconButton(onClick = onOpenConnectSettings) {
          Icon(
            imageVector = Icons.Rounded.Settings,
            contentDescription = "连接设置",
          )
        }
      }

      LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
      ) {
        // Composer Card
        item {
          Card(
            shape = RoundedCornerShape(20.dp),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.65f)),
          ) {
            Column(
              modifier = Modifier.padding(16.dp),
              verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
              OutlinedTextField(
                value = noteText,
                onValueChange = { noteText = it },
                placeholder = {
                  Text("记下一条闪念、灵感或临时片段…\n有网直弹桌面便利贴，断网自动安全排队")
                },
                minLines = 4,
                maxLines = 9,
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(14.dp),
              )

              // 5 Color Dots Selector
              Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
              ) {
                Text(
                  text = "闪念色标",
                  style = MaterialTheme.typography.labelMedium,
                  color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                  STICKY_COLORS.forEach { opt ->
                    val active = selectedColor == opt.key
                    Box(
                      modifier = Modifier
                        .size(28.dp)
                        .clip(CircleShape)
                        .background(opt.color)
                        .then(
                          if (active) {
                            Modifier.border(2.5.dp, MaterialTheme.colorScheme.onSurface, CircleShape)
                          } else {
                            Modifier
                          },
                        )
                        .clickable {
                          selectedColor = opt.key
                          DeviceHelper.hapticTick(context)
                        },
                      contentAlignment = Alignment.Center,
                    ) {
                      if (active) {
                        Icon(
                          imageVector = Icons.Rounded.Check,
                          contentDescription = opt.label,
                          tint = Color(0xFF1A1A1A),
                          modifier = Modifier.size(16.dp),
                        )
                      }
                    }
                  }
                }
              }

              // Quick Action Row
              Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
              ) {
                FilledTonalButton(
                  onClick = {
                    val clip = DeviceHelper.readClipboard(context)
                    if (clip.isBlank()) {
                      Toast.makeText(context, "剪贴板为空", Toast.LENGTH_SHORT).show()
                    } else {
                      noteText = if (noteText.isBlank()) clip else "$noteText\n$clip"
                      DeviceHelper.hapticTick(context)
                    }
                  },
                  modifier = Modifier.weight(1f),
                  shape = RoundedCornerShape(12.dp),
                  contentPadding = PaddingValues(horizontal = 8.dp, vertical = 10.dp),
                ) {
                  Text("📋 粘贴剪贴板", maxLines = 1, overflow = TextOverflow.Ellipsis)
                }

                FilledTonalButton(
                  onClick = { filePickerLauncher.launch(arrayOf("*/*")) },
                  enabled = !isSending,
                  modifier = Modifier.weight(1f),
                  shape = RoundedCornerShape(12.dp),
                  contentPadding = PaddingValues(horizontal = 8.dp, vertical = 10.dp),
                ) {
                  Text("📷 选图传电脑", maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
              }

              // Primary Send Button + Direct Clipboard Push
              Button(
                onClick = { sendNote() },
                enabled = !isSending,
                modifier = Modifier
                  .fillMaxWidth()
                  .height(48.dp),
                shape = RoundedCornerShape(12.dp),
              ) {
                if (isSending) {
                  CircularProgressIndicator(
                    modifier = Modifier.size(18.dp),
                    strokeWidth = 2.dp,
                    color = MaterialTheme.colorScheme.onPrimary,
                  )
                  Spacer(Modifier.width(8.dp))
                  Text("处理中…")
                } else {
                  Text("🚀 发送到电脑（离线自动入队）", fontWeight = FontWeight.SemiBold)
                }
              }

              OutlinedButton(
                onClick = { pushClipboardDirectly() },
                enabled = !isSending,
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(12.dp),
              ) {
                Text("📤 一键将手机剪贴板推送至电脑")
              }

              if (!statusBanner.isNullOrBlank()) {
                Surface(
                  shape = RoundedCornerShape(10.dp),
                  color = MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.55f),
                  modifier = Modifier.fillMaxWidth(),
                ) {
                  Text(
                    text = statusBanner.orEmpty(),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onPrimaryContainer,
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                  )
                }
              }
            }
          }
        }

        // Offline Queue Section Header
        item {
          Row(
            modifier = Modifier
              .fillMaxWidth()
              .padding(top = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
          ) {
            Text(
              text = "离线待同步队列（${offlineQueue.size}）",
              style = MaterialTheme.typography.titleSmall,
              fontWeight = FontWeight.SemiBold,
              color = MaterialTheme.colorScheme.onBackground,
            )
            TextButton(
              onClick = { syncNow() },
              enabled = !isSyncing && offlineQueue.isNotEmpty(),
            ) {
              if (isSyncing) {
                CircularProgressIndicator(modifier = Modifier.size(14.dp), strokeWidth = 2.dp)
                Spacer(Modifier.width(6.dp))
                Text("同步中…")
              } else {
                Icon(
                  imageVector = Icons.Rounded.Refresh,
                  contentDescription = "立即同步",
                  modifier = Modifier.size(16.dp),
                )
                Spacer(Modifier.width(4.dp))
                Text("🔄 立即同步")
              }
            }
          }
        }

        if (offlineQueue.isEmpty()) {
          item {
            Surface(
              shape = RoundedCornerShape(14.dp),
              color = MaterialTheme.colorScheme.surfaceContainerLow,
              modifier = Modifier.fillMaxWidth(),
            ) {
              Text(
                text = "暂无待同步项目。断网时发送的闪念、剪贴板和文件会自动保存在这里。",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(16.dp),
              )
            }
          }
        } else {
          items(offlineQueue.reversed(), key = { it.id }) { item ->
            OfflineQueueItemCard(
              item = item,
              onDelete = {
                prefs.removeOfflineItem(item.id)
                refreshQueue()
                DeviceHelper.hapticTick(context)
              },
            )
          }
        }

        item { Spacer(Modifier.height(16.dp)) }
      }
    }
  }
}

@Composable
private fun OfflineQueueItemCard(
  item: OfflineItem,
  onDelete: () -> Unit,
) {
  val kindBadge = when (item.kind) {
    "sticky" -> "⚡ 闪念"
    "clipboard" -> "📋 剪贴板"
    "upload" -> "📎 文件"
    else -> "📝 待同步"
  }
  val preview = when (item.kind) {
    "upload" -> item.filename.ifBlank { "未命名文件" }
    else -> item.text.ifBlank { "（空内容）" }
  }

  Card(
    shape = RoundedCornerShape(14.dp),
    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
    border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f)),
  ) {
    Row(
      modifier = Modifier
        .fillMaxWidth()
        .padding(start = 14.dp, top = 10.dp, bottom = 10.dp, end = 6.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Column(modifier = Modifier.weight(1f)) {
        Row(
          verticalAlignment = Alignment.CenterVertically,
          horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
          Surface(
            shape = RoundedCornerShape(6.dp),
            color = MaterialTheme.colorScheme.secondaryContainer,
          ) {
            Text(
              text = kindBadge,
              style = MaterialTheme.typography.labelSmall,
              color = MaterialTheme.colorScheme.onSecondaryContainer,
              modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
            )
          }
          Text(
            text = DeviceHelper.formatShortTime(item.createdAt),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
          )
        }
        Spacer(Modifier.height(4.dp))
        Text(
          text = preview,
          style = MaterialTheme.typography.bodyMedium,
          maxLines = 2,
          overflow = TextOverflow.Ellipsis,
        )
      }
      IconButton(onClick = onDelete) {
        Icon(
          imageVector = Icons.Rounded.Delete,
          contentDescription = "删除",
          tint = MaterialTheme.colorScheme.onSurfaceVariant,
          modifier = Modifier.size(20.dp),
        )
      }
    }
  }
}
