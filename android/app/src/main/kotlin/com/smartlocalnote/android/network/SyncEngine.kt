package com.smartlocalnote.android.network

import android.util.Base64
import com.smartlocalnote.android.data.AppPrefs
import com.smartlocalnote.android.local.LocalDataEngine
import com.smartlocalnote.android.local.LocalSlnServer
import com.smartlocalnote.android.local.LocalSyncEntry
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import kotlin.math.abs

data class SyncSummary(
  val ok: Boolean,
  val pulledCount: Int = 0,
  val pushedCount: Int = 0,
  val conflictCount: Int = 0,
  val skippedCount: Int = 0,
  val offlineFlushedCount: Int = 0,
  val message: String = "",
)

private data class RemoteSyncEntry(
  val relPath: String,
  val path: String,
  val name: String,
  val mtimeSec: Double,
  val size: Long,
  val sha256: String,
)

object SyncEngine {
  private const val CONNECT_TIMEOUT_MS = 4500
  private const val READ_TIMEOUT_MS = 18000
  private const val CONFLICT_WINDOW_SEC = 5.0

  suspend fun syncWithWindows(
    prefs: AppPrefs,
    dataEngine: LocalDataEngine,
    localServer: LocalSlnServer? = LocalSlnServer.getRunningOrNull(),
  ): SyncSummary = withContext(Dispatchers.IO) {
    if (!prefs.isPaired) {
      return@withContext SyncSummary(ok = false, message = "尚未配对 Windows 电脑，请先完成配对")
    }
    val host = prefs.host
    val port = prefs.port
    val token = prefs.token

    // 1. Fetch remote manifest from Windows
    val remoteEntries = fetchRemoteManifest(host, port, token)
      ?: return@withContext SyncSummary(
        ok = false,
        message = "无法获取 Windows 电脑笔记清单，请确认电脑端已启动且同处 Wi-Fi / Tailscale",
      )

    // 2. Scan local Android notes manifest
    val localEntries = dataEngine.getSyncManifest()

    val remoteMap = remoteEntries.associateBy { it.relPath }
    val localMap = localEntries.associateBy { it.relPath }
    val allPaths = (remoteMap.keys + localMap.keys).sorted()

    var pulled = 0
    var pushed = 0
    var conflicts = 0
    var skipped = 0

    for (relPath in allPaths) {
      val remote = remoteMap[relPath]
      val local = localMap[relPath]

      when {
        // Windows only -> Pull to Android
        remote != null && local == null -> {
          val bytes = pullFromWindows(host, port, token, remote)
          if (bytes != null) {
            dataEngine.writeNotesRelBytes(relPath, bytes, remote.mtimeSec)
            pulled++
          }
        }

        // Android only -> Push to Windows
        local != null && remote == null -> {
          val bytes = dataEngine.readNotesRelBytes(relPath)
          if (bytes != null && pushToWindows(host, port, token, relPath, bytes, local.mtimeSec)) {
            pushed++
          }
        }

        // Both exist
        remote != null && local != null -> {
          if (remote.sha256.equals(local.sha256, ignoreCase = true)) {
            skipped++
            continue
          }

          val diff = remote.mtimeSec - local.mtimeSec
          when {
            // Very close timestamps or invalid mtime -> preserve both safely via conflict copy
            abs(diff) < CONFLICT_WINDOW_SEC || remote.mtimeSec <= 0.0 || local.mtimeSec <= 0.0 -> {
              val remoteBytes = pullFromWindows(host, port, token, remote)
              if (remoteBytes != null) {
                dataEngine.writeConflictCopy(relPath, remoteBytes, "电脑冲突副本")
                conflicts++
              }
            }
            // Windows is newer -> Pull to Android
            diff >= CONFLICT_WINDOW_SEC -> {
              val remoteBytes = pullFromWindows(host, port, token, remote)
              if (remoteBytes != null) {
                dataEngine.writeNotesRelBytes(relPath, remoteBytes, remote.mtimeSec)
                pulled++
              }
            }
            // Android is newer -> Push to Windows
            else -> {
              val localBytes = dataEngine.readNotesRelBytes(relPath)
              if (localBytes != null && pushToWindows(host, port, token, relPath, localBytes, local.mtimeSec)) {
                pushed++
              }
            }
          }
        }
      }
    }

    // 3. Also flush any queued offline quick-captures
    val flushRes = if (prefs.pendingOfflineCount() > 0) {
      SlnApiClient.flushOfflineQueue(prefs)
    } else {
      FlushResult(0, 0)
    }

    // 4. Notify embedded WebView to refresh file tree immediately
    if (pulled > 0 || conflicts > 0) {
      val evt = JSONObject()
        .put("pulled", pulled)
        .put("pushed", pushed)
        .put("conflicts", conflicts)
        .put("name", "已同步 $pulled 篇笔记")
        .put("add_to_shelf", false)
      localServer?.publishEvent("files:updated", evt)
      localServer?.publishEvent("mobile:upload", evt)
    }

    val summaryText = buildString {
      append("双向同步完成：")
      append("拉取 $pulled 篇，推送 $pushed 篇")
      if (conflicts > 0) append("，保留冲突副本 $conflicts 篇")
      if (flushRes.syncedCount > 0) append("，补发离线记录 ${flushRes.syncedCount} 条")
      if (pulled == 0 && pushed == 0 && conflicts == 0 && flushRes.syncedCount == 0) {
        append("（两端已是最新，共 $skipped 篇一致）")
      }
    }

    SyncSummary(
      ok = true,
      pulledCount = pulled,
      pushedCount = pushed,
      conflictCount = conflicts,
      skippedCount = skipped,
      offlineFlushedCount = flushRes.syncedCount,
      message = summaryText,
    )
  }

  private fun fetchRemoteManifest(host: String, port: Int, token: String): List<RemoteSyncEntry>? {
    var conn: HttpURLConnection? = null
    return try {
      val url = URL("http://${host.trim()}:$port/api/mobile/sync-manifest")
      conn = (url.openConnection() as HttpURLConnection).apply {
        requestMethod = "GET"
        connectTimeout = CONNECT_TIMEOUT_MS
        readTimeout = READ_TIMEOUT_MS
        setRequestProperty("Accept", "application/json")
        if (token.isNotBlank()) setRequestProperty("X-SLN-Token", token)
      }
      if (conn.responseCode !in 200..299) return null
      val body = BufferedReader(InputStreamReader(conn.inputStream, Charsets.UTF_8)).use { it.readText() }
      val root = JSONObject(body)
      if (!root.optBoolean("ok", true)) return null
      val dataArr = root.optJSONArray("data") ?: JSONArray()
      val list = mutableListOf<RemoteSyncEntry>()
      for (i in 0 until dataArr.length()) {
        val o = dataArr.optJSONObject(i) ?: continue
        val rel = o.optString("rel_path", "").trim()
        if (rel.isEmpty()) continue
        list.add(
          RemoteSyncEntry(
            relPath = rel,
            path = o.optString("path", ""),
            name = o.optString("name", rel.substringAfterLast('/')),
            mtimeSec = o.optDouble("mtime", 0.0),
            size = o.optLong("size", 0L),
            sha256 = o.optString("sha256", ""),
          ),
        )
      }
      list
    } catch (_: Exception) {
      null
    } finally {
      conn?.disconnect()
    }
  }

  private fun pullFromWindows(host: String, port: Int, token: String, entry: RemoteSyncEntry): ByteArray? {
    // Primary: GET /api/mobile/sync-pull?rel_path=...
    val encodedRel = URLEncoder.encode(entry.relPath, "UTF-8")
    val primary = requestJsonGet("http://${host.trim()}:$port/api/mobile/sync-pull?rel_path=$encodedRel", token)
    if (primary != null && primary.optBoolean("ok", false)) {
      val data = primary.optJSONObject("data")
      val b64 = data?.optString("content_base64", "").orEmpty()
      if (b64.isNotEmpty()) {
        return try {
          Base64.decode(b64, Base64.DEFAULT)
        } catch (_: Exception) {
          null
        }
      }
    }

    // Fallback: GET /api/files/read?path=... (works even with older Windows server builds)
    if (entry.path.isNotBlank()) {
      val encodedPath = URLEncoder.encode(entry.path, "UTF-8")
      val fallback = requestJsonGet("http://${host.trim()}:$port/api/files/read?path=$encodedPath", token)
      if (fallback != null && fallback.optBoolean("ok", false)) {
        val content = fallback.optJSONObject("data")?.optString("content")
        if (content != null) {
          return content.toByteArray(Charsets.UTF_8)
        }
      }
    }
    return null
  }

  private fun pushToWindows(
    host: String,
    port: Int,
    token: String,
    relPath: String,
    bytes: ByteArray,
    mtimeSec: Double,
  ): Boolean {
    val b64 = Base64.encodeToString(bytes, Base64.NO_WRAP)

    // Primary: POST /api/mobile/sync-push
    val pushBody = JSONObject().apply {
      put("rel_path", relPath)
      put("content_base64", b64)
      put("mtime", mtimeSec)
      put("token", token)
    }
    val primary = requestJsonPost("http://${host.trim()}:$port/api/mobile/sync-push", token, pushBody)
    if (primary != null && primary.optBoolean("ok", false)) {
      return true
    }

    // Fallback: POST /api/mobile/upload
    val parentRel = if (relPath.contains('/')) relPath.substringBeforeLast('/') else ""
    val fileName = relPath.substringAfterLast('/')
    val uploadBody = JSONObject().apply {
      put("filename", fileName)
      put("content_base64", b64)
      put("target_dir", parentRel.ifBlank { "手机同步" })
      put("add_to_shelf", false)
      put("note_append", false)
      put("token", token)
    }
    val fallback = requestJsonPost("http://${host.trim()}:$port/api/mobile/upload", token, uploadBody)
    return fallback?.optBoolean("ok", false) == true
  }

  private fun requestJsonGet(urlStr: String, token: String): JSONObject? {
    var conn: HttpURLConnection? = null
    return try {
      conn = (URL(urlStr).openConnection() as HttpURLConnection).apply {
        requestMethod = "GET"
        connectTimeout = CONNECT_TIMEOUT_MS
        readTimeout = READ_TIMEOUT_MS
        setRequestProperty("Accept", "application/json")
        if (token.isNotBlank()) setRequestProperty("X-SLN-Token", token)
      }
      if (conn.responseCode !in 200..299) return null
      val text = BufferedReader(InputStreamReader(conn.inputStream, Charsets.UTF_8)).use { it.readText() }
      JSONObject(text)
    } catch (_: Exception) {
      null
    } finally {
      conn?.disconnect()
    }
  }

  private fun requestJsonPost(urlStr: String, token: String, payload: JSONObject): JSONObject? {
    var conn: HttpURLConnection? = null
    return try {
      conn = (URL(urlStr).openConnection() as HttpURLConnection).apply {
        requestMethod = "POST"
        connectTimeout = CONNECT_TIMEOUT_MS
        readTimeout = READ_TIMEOUT_MS
        doOutput = true
        setRequestProperty("Accept", "application/json")
        setRequestProperty("Content-Type", "application/json; charset=utf-8")
        if (token.isNotBlank()) setRequestProperty("X-SLN-Token", token)
      }
      val bytes = payload.toString().toByteArray(Charsets.UTF_8)
      conn.setFixedLengthStreamingMode(bytes.size)
      conn.outputStream.use { os ->
        os.write(bytes)
        os.flush()
      }
      if (conn.responseCode !in 200..299) return null
      val text = BufferedReader(InputStreamReader(conn.inputStream, Charsets.UTF_8)).use { it.readText() }
      JSONObject(text)
    } catch (_: Exception) {
      null
    } finally {
      conn?.disconnect()
    }
  }
}
