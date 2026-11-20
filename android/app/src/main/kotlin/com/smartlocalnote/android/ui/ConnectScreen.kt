package com.smartlocalnote.android.ui

import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material3.Badge
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
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
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.smartlocalnote.android.data.AppPrefs
import com.smartlocalnote.android.data.OfflineItem
import com.smartlocalnote.android.data.ParsedPairLink
import com.smartlocalnote.android.local.LocalSlnServer
import com.smartlocalnote.android.network.DiscoveredHost
import com.smartlocalnote.android.network.LanDiscovery
import com.smartlocalnote.android.network.SlnApiClient
import com.smartlocalnote.android.network.SyncEngine
import com.smartlocalnote.android.util.DeviceHelper
import kotlinx.coroutines.launch

@Composable
fun ConnectScreen(
  prefs: AppPrefs,
  localServer: LocalSlnServer,
  prefilledLink: ParsedPairLink? = null,
  onBackToWorkbench: () -> Unit,
  onOpenQuickCapture: () -> Unit,
) {
  val context = LocalContext.current
  val scope = rememberCoroutineScope()

  var host by remember { mutableStateOf(prefs.host) }
  var portText by remember { mutableStateOf(prefs.port.toString()) }
  var pin by remember { mutableStateOf("") }
  var selectedName by remember { mutableStateOf(prefs.hostName) }
  var isPairedState by remember { mutableStateOf(prefs.isPaired) }

  var isScanning by remember { mutableStateOf(false) }
  var discoveredHosts by remember { mutableStateOf<List<DiscoveredHost>>(emptyList()) }
  var hasScannedOnce by remember { mutableStateOf(false) }

  var isConnecting by remember { mutableStateOf(false) }
  var isSyncing by remember { mutableStateOf(false) }
  var syncStatusMessage by remember { mutableStateOf<String?>(null) }
  var isSyncError by remember { mutableStateOf(false) }

  var statusMessage by remember { mutableStateOf<String?>(null) }
  var isErrorStatus by remember { mutableStateOf(false) }
  var pendingOfflineCount by remember { mutableIntStateOf(prefs.pendingOfflineCount()) }

  BackHandler { onBackToWorkbench() }

  fun applyParsedLink(parsed: ParsedPairLink, showFeedback: Boolean = true) {
    host = parsed.host
    portText = parsed.port.toString()
    if (parsed.pin.isNotBlank()) pin = parsed.pin
    if (parsed.name.isNotBlank()) selectedName = parsed.name
    if (parsed.token.isNotBlank()) {
      prefs.savePair(parsed.host, parsed.port, parsed.token, parsed.name.ifBlank { parsed.host })
      isPairedState = true
    }
    if (showFeedback) {
      isErrorStatus = false
      statusMessage = "已解析配对链接：${parsed.host}:${parsed.port}"
      DeviceHelper.hapticTick(context)
    }
  }

  fun runLanScan() {
    if (isScanning) return
    scope.launch {
      isScanning = true
      val results = LanDiscovery.discoverHosts(context, timeoutMs = 900)
      discoveredHosts = results
      hasScannedOnce = true
      isScanning = false
      if (host.isBlank() && results.size == 1) {
        host = results.first().ip
        portText = results.first().port.toString()
        selectedName = results.first().name
      }
    }
  }

  fun runBidirectionalSync() {
    if (isSyncing) return
    if (!prefs.isPaired) {
      isSyncError = true
      syncStatusMessage = "请先在下方配对一台 Windows 电脑，再进行双向同步"
      return
    }
    scope.launch {
      isSyncing = true
      isSyncError = false
      syncStatusMessage = "正在与 ${prefs.hostName.ifBlank { prefs.host }} 对比差异并双向增量同步…"
      val result = SyncEngine.syncWithWindows(prefs, localServer.dataEngine, localServer)
      isSyncing = false
      pendingOfflineCount = prefs.pendingOfflineCount()
      isSyncError = !result.ok
      syncStatusMessage = result.message
      DeviceHelper.hapticTick(context)
      Toast.makeText(context, result.message, Toast.LENGTH_LONG).show()
    }
  }

  fun pushClipboardToPc() {
    val clip = DeviceHelper.readClipboard(context).trim()
    if (clip.isEmpty()) {
      Toast.makeText(context, "手机剪贴板为空", Toast.LENGTH_SHORT).show()
      return
    }
    scope.launch {
      if (prefs.isPaired) {
        val res = SlnApiClient.sendClipboard(prefs.host, prefs.port, prefs.token, clip)
        if (res.ok) {
          DeviceHelper.hapticTick(context)
          Toast.makeText(context, "📋 已推送剪贴板到电脑", Toast.LENGTH_SHORT).show()
          return@launch
        }
      }
      prefs.enqueueOffline(OfflineItem(kind = "clipboard", text = clip))
      pendingOfflineCount = prefs.pendingOfflineCount()
      DeviceHelper.hapticTick(context)
      Toast.makeText(context, "📥 电脑暂不可达，已加入待同步队列", Toast.LENGTH_SHORT).show()
    }
  }

  fun performPair() {
    val cleanHost = host.trim()
    val cleanPort = portText.trim().toIntOrNull() ?: AppPrefs.DEFAULT_PORT
    val cleanPin = pin.trim().replace(" ", "")

    if (cleanHost.isBlank()) {
      isErrorStatus = true
      statusMessage = "请先填写电脑 IP 地址，或在上方点击自动发现的电脑"
      return
    }
    if (cleanPin.isBlank()) {
      isErrorStatus = true
      statusMessage = "请输入桌面端显示的 6 位配对码"
      return
    }

    scope.launch {
      isConnecting = true
      isErrorStatus = false
      statusMessage = "正在与 $cleanHost:$cleanPort 配对…"
      val res = SlnApiClient.pair(cleanHost, cleanPort, cleanPin)
      isConnecting = false
      if (res.ok && res.data != null) {
        val data = res.data
        prefs.savePair(
          host = cleanHost,
          port = cleanPort,
          token = data.token,
          hostName = data.hostname.ifBlank { selectedName.ifBlank { cleanHost } },
        )
        isPairedState = true
        pin = ""
        isErrorStatus = false
        statusMessage = "✅ 已绑定电脑 ${prefs.hostName}，现在可随时一键双向同步！"
        DeviceHelper.hapticTick(context)
        Toast.makeText(context, "配对成功：${prefs.hostName}", Toast.LENGTH_SHORT).show()
      } else {
        isErrorStatus = true
        statusMessage = res.message.ifBlank { "配对失败，请确认配对码与网络" }
      }
    }
  }

  LaunchedEffect(Unit) {
    pendingOfflineCount = prefs.pendingOfflineCount()
    isPairedState = prefs.isPaired
    runLanScan()
  }

  LaunchedEffect(prefilledLink) {
    if (prefilledLink != null) {
      applyParsedLink(prefilledLink, showFeedback = true)
    }
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
      // Top Navigation Bar with Back to Local Workbench
      Row(
        modifier = Modifier
          .fillMaxWidth()
          .padding(horizontal = 8.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
      ) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.weight(1f)) {
          IconButton(onClick = onBackToWorkbench) {
            Icon(
              imageVector = Icons.AutoMirrored.Rounded.ArrowBack,
              contentDescription = "返回手机本地工作台",
            )
          }
          Column {
            Text(
              text = "🔄 Windows 电脑双向同步中心",
              style = MaterialTheme.typography.titleMedium,
              fontWeight = FontWeight.Bold,
              maxLines = 1,
              overflow = TextOverflow.Ellipsis,
            )
            Text(
              text = "手机本地离线独立运行 · 随时与电脑增量双向同步",
              style = MaterialTheme.typography.bodySmall,
              color = MaterialTheme.colorScheme.onSurfaceVariant,
              maxLines = 1,
              overflow = TextOverflow.Ellipsis,
            )
          }
        }
        TextButton(onClick = onBackToWorkbench) {
          Text("返回工作台", fontWeight = FontWeight.SemiBold)
        }
      }

      Column(
        modifier = Modifier
          .fillMaxSize()
          .verticalScroll(rememberScrollState())
          .padding(horizontal = 18.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
      ) {
        // Card 0: One-Tap Bidirectional Sync & Quick Push
        Card(
          shape = RoundedCornerShape(18.dp),
          colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.45f)),
          border = BorderStroke(1.dp, MaterialTheme.colorScheme.primary.copy(alpha = 0.35f)),
        ) {
          Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
          ) {
            Row(
              modifier = Modifier.fillMaxWidth(),
              verticalAlignment = Alignment.CenterVertically,
              horizontalArrangement = Arrangement.SpaceBetween,
            ) {
              Column(modifier = Modifier.weight(1f)) {
                Text(
                  text = if (isPairedState) {
                    "🖥️ 已绑定：${prefs.hostName.ifBlank { prefs.host }}"
                  } else {
                    "📱 当前为纯手机离线独立模式"
                  },
                  style = MaterialTheme.typography.titleMedium,
                  fontWeight = FontWeight.Bold,
                )
                Text(
                  text = if (isPairedState) {
                    "地址：${prefs.host}:${prefs.port}"
                  } else {
                    "在下方配对电脑后，可与 Windows 互相增量同步笔记"
                  },
                  style = MaterialTheme.typography.bodySmall,
                  color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
              }
              if (pendingOfflineCount > 0) {
                Badge(
                  containerColor = MaterialTheme.colorScheme.error,
                  contentColor = MaterialTheme.colorScheme.onError,
                ) {
                  Text("$pendingOfflineCount 待发")
                }
              }
            }

            Button(
              onClick = { runBidirectionalSync() },
              enabled = !isSyncing && isPairedState,
              modifier = Modifier
                .fillMaxWidth()
                .height(48.dp),
              shape = RoundedCornerShape(12.dp),
            ) {
              if (isSyncing) {
                CircularProgressIndicator(
                  modifier = Modifier.size(18.dp),
                  strokeWidth = 2.dp,
                  color = MaterialTheme.colorScheme.onPrimary,
                )
                Spacer(Modifier.width(8.dp))
                Text("正在双向增量同步…")
              } else {
                Text("🔄 立即双向同步所有笔记", fontWeight = FontWeight.SemiBold)
              }
            }

            Row(
              modifier = Modifier.fillMaxWidth(),
              horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
              FilledTonalButton(
                onClick = {
                  DeviceHelper.hapticTick(context)
                  onOpenQuickCapture()
                },
                modifier = Modifier.weight(1f),
                shape = RoundedCornerShape(12.dp),
                contentPadding = PaddingValues(horizontal = 8.dp, vertical = 10.dp),
              ) {
                Text("📌 闪念推送电脑", maxLines = 1, overflow = TextOverflow.Ellipsis)
              }
              FilledTonalButton(
                onClick = { pushClipboardToPc() },
                modifier = Modifier.weight(1f),
                shape = RoundedCornerShape(12.dp),
                contentPadding = PaddingValues(horizontal = 8.dp, vertical = 10.dp),
              ) {
                Text("📋 剪贴板推送电脑", maxLines = 1, overflow = TextOverflow.Ellipsis)
              }
            }

            if (!syncStatusMessage.isNullOrBlank()) {
              Surface(
                shape = RoundedCornerShape(10.dp),
                color = if (isSyncError) {
                  MaterialTheme.colorScheme.errorContainer
                } else {
                  MaterialTheme.colorScheme.surface
                },
                modifier = Modifier.fillMaxWidth(),
              ) {
                Text(
                  text = syncStatusMessage.orEmpty(),
                  style = MaterialTheme.typography.bodySmall,
                  color = if (isSyncError) {
                    MaterialTheme.colorScheme.onErrorContainer
                  } else {
                    MaterialTheme.colorScheme.onSurface
                  },
                  modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                )
              }
            }
          }
        }

        // Card 1: LAN Auto-Discovery
        Card(
          shape = RoundedCornerShape(18.dp),
          colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
          border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.65f)),
        ) {
          Column(modifier = Modifier.padding(16.dp)) {
            Row(
              modifier = Modifier.fillMaxWidth(),
              verticalAlignment = Alignment.CenterVertically,
              horizontalArrangement = Arrangement.SpaceBetween,
            ) {
              Text(
                text = "📡 局域网自动发现电脑",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
              )
              TextButton(
                onClick = { runLanScan() },
                enabled = !isScanning,
                contentPadding = PaddingValues(horizontal = 10.dp, vertical = 4.dp),
              ) {
                if (isScanning) {
                  CircularProgressIndicator(modifier = Modifier.size(14.dp), strokeWidth = 2.dp)
                  Spacer(Modifier.width(6.dp))
                  Text("扫描中…")
                } else {
                  Icon(
                    imageVector = Icons.Rounded.Refresh,
                    contentDescription = "重新扫描",
                    modifier = Modifier.size(16.dp),
                  )
                  Spacer(Modifier.width(4.dp))
                  Text("重新扫描")
                }
              }
            }

            Spacer(Modifier.height(6.dp))

            if (discoveredHosts.isEmpty()) {
              Text(
                text = if (isScanning) {
                  "正在向当前 Wi-Fi 广播探测 SmartLocalNote 桌面端…"
                } else if (hasScannedOnce) {
                  "未探测到局域网电脑。请确认电脑端已开启且同处一个 Wi-Fi，或在下方输入 IP / Tailscale 地址。"
                } else {
                  "准备扫描同一局域网下的电脑…"
                },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
              )
            } else {
              Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                discoveredHosts.forEach { item ->
                  val isSelected = host.trim() == item.ip && portText.trim() == item.port.toString()
                  Surface(
                    modifier = Modifier
                      .fillMaxWidth()
                      .clip(RoundedCornerShape(12.dp))
                      .clickable {
                        host = item.ip
                        portText = item.port.toString()
                        selectedName = item.name
                        isErrorStatus = false
                        statusMessage = "已选中电脑 ${item.name}（${item.ip}:${item.port}）"
                        DeviceHelper.hapticTick(context)
                      },
                    shape = RoundedCornerShape(12.dp),
                    color = if (isSelected) {
                      MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.65f)
                    } else {
                      MaterialTheme.colorScheme.surfaceContainerLowest
                    },
                    border = BorderStroke(
                      width = if (isSelected) 1.5.dp else 1.dp,
                      color = if (isSelected) {
                        MaterialTheme.colorScheme.primary
                      } else {
                        MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.55f)
                      },
                    ),
                  ) {
                    Row(
                      modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 12.dp, vertical = 10.dp),
                      verticalAlignment = Alignment.CenterVertically,
                      horizontalArrangement = Arrangement.SpaceBetween,
                    ) {
                      Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.weight(1f),
                      ) {
                        Box(
                          modifier = Modifier
                            .size(10.dp)
                            .clip(CircleShape)
                            .background(MaterialTheme.colorScheme.primary),
                        )
                        Spacer(Modifier.width(10.dp))
                        Column {
                          Text(
                            text = item.name,
                            style = MaterialTheme.typography.bodyMedium,
                            fontWeight = FontWeight.SemiBold,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                          )
                          Text(
                            text = "${item.ip}:${item.port}" +
                              if (item.version.isNotBlank()) " · v${item.version}" else "",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                          )
                        }
                      }
                      if (isSelected) {
                        Icon(
                          imageVector = Icons.Rounded.Check,
                          contentDescription = "已选中",
                          tint = MaterialTheme.colorScheme.primary,
                          modifier = Modifier.size(18.dp),
                        )
                      } else {
                        Text(
                          text = "选用",
                          style = MaterialTheme.typography.labelMedium,
                          color = MaterialTheme.colorScheme.primary,
                          fontWeight = FontWeight.SemiBold,
                        )
                      }
                    }
                  }
                }
              }
            }
          }
        }

        // Card 2: Manual / Tailscale Pairing Form
        Card(
          shape = RoundedCornerShape(18.dp),
          colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
          border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.65f)),
        ) {
          Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
          ) {
            Text(
              text = "🔗 绑定 / 切换 Windows 电脑",
              style = MaterialTheme.typography.titleMedium,
              fontWeight = FontWeight.SemiBold,
            )

            FilledTonalButton(
              onClick = {
                val clip = DeviceHelper.readClipboard(context)
                val parsed = AppPrefs.parsePairingUri(clip)
                if (parsed != null) {
                  applyParsedLink(parsed)
                } else {
                  isErrorStatus = true
                  statusMessage = "剪贴板未检测到 sln://pair?... 或 http://ip:port 链接"
                }
              },
              modifier = Modifier.fillMaxWidth(),
              shape = RoundedCornerShape(12.dp),
            ) {
              Text("📋 粘贴电脑端 sln://pair 配对链接（自动填充）")
            }

            Row(
              modifier = Modifier.fillMaxWidth(),
              horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
              OutlinedTextField(
                value = host,
                onValueChange = { input ->
                  val parsed = AppPrefs.parsePairingUri(input)
                  if (parsed != null && (input.contains("sln://", ignoreCase = true) || input.contains("://"))) {
                    applyParsedLink(parsed)
                  } else {
                    host = input
                  }
                },
                label = { Text("电脑 IP / Tailscale") },
                placeholder = { Text("192.168.1.x") },
                singleLine = true,
                modifier = Modifier.weight(1.75f),
                shape = RoundedCornerShape(12.dp),
              )
              OutlinedTextField(
                value = portText,
                onValueChange = { portText = it.filter(Char::isDigit).take(5) },
                label = { Text("端口") },
                placeholder = { Text("8765") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                modifier = Modifier.weight(0.95f),
                shape = RoundedCornerShape(12.dp),
              )
            }

            OutlinedTextField(
              value = pin,
              onValueChange = { input ->
                val parsed = AppPrefs.parsePairingUri(input)
                if (parsed != null) {
                  applyParsedLink(parsed)
                } else {
                  pin = input.filter(Char::isDigit).take(6)
                }
              },
              label = { Text("6 位配对码") },
              placeholder = { Text("在 Windows 端「手机直连」面板查看") },
              singleLine = true,
              keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
              modifier = Modifier.fillMaxWidth(),
              shape = RoundedCornerShape(12.dp),
            )

            if (!statusMessage.isNullOrBlank()) {
              Surface(
                shape = RoundedCornerShape(10.dp),
                color = if (isErrorStatus) {
                  MaterialTheme.colorScheme.errorContainer
                } else {
                  MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.55f)
                },
                modifier = Modifier.fillMaxWidth(),
              ) {
                Text(
                  text = statusMessage.orEmpty(),
                  style = MaterialTheme.typography.bodySmall,
                  color = if (isErrorStatus) {
                    MaterialTheme.colorScheme.onErrorContainer
                  } else {
                    MaterialTheme.colorScheme.onPrimaryContainer
                  },
                  modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                )
              }
            }

            Button(
              onClick = { performPair() },
              enabled = !isConnecting,
              modifier = Modifier
                .fillMaxWidth()
                .height(48.dp),
              shape = RoundedCornerShape(12.dp),
            ) {
              if (isConnecting) {
                CircularProgressIndicator(
                  modifier = Modifier.size(18.dp),
                  strokeWidth = 2.dp,
                  color = MaterialTheme.colorScheme.onPrimary,
                )
                Spacer(Modifier.width(8.dp))
                Text("正在配对…")
              } else {
                Text("绑定此 Windows 电脑", fontWeight = FontWeight.SemiBold)
              }
            }

            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
            OutlinedButton(
              onClick = onBackToWorkbench,
              modifier = Modifier.fillMaxWidth(),
              shape = RoundedCornerShape(12.dp),
            ) {
              Text("← 返回手机本地工作台")
            }
          }
        }

        Spacer(Modifier.height(14.dp))
      }
    }
  }
}
