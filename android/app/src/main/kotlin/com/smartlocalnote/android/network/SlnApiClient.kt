package com.smartlocalnote.android.network

import android.os.Build
import android.util.Base64
import com.smartlocalnote.android.data.AppPrefs
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL

data class ApiResult<T>(
  val ok: Boolean,
  val data: T? = null,
  val message: String = "",
  val statusCode: Int = 0,
)

data class PingInfo(
  val service: String,
  val version: String,
  val hostname: String,
  val ip: String,
  val port: Int,
  val todosOpen: Int,
  val todosTotal: Int,
)

data class PairResult(
  val token: String,
  val host: String,
  val port: Int,
  val hostname: String,
)

data class UploadResult(
  val name: String,
  val relDir: String,
  val size: Long,
)

data class FlushResult(
  val syncedCount: Int,
  val remainingCount: Int,
  val lastError: String = "",
)

object SlnApiClient {
  private const val CONNECT_TIMEOUT_MS = 3500
  private const val READ_TIMEOUT_MS = 10000
  private const val UPLOAD_READ_TIMEOUT_MS = 20000

  fun defaultDeviceName(): String {
    val manufacturer = Build.MANUFACTURER?.trim().orEmpty()
    val model = Build.MODEL?.trim().orEmpty()
    return when {
      model.isBlank() -> "Android 手机"
      manufacturer.isBlank() || model.startsWith(manufacturer, ignoreCase = true) -> model
      else -> "$manufacturer $model"
    }.take(48)
  }

  suspend fun ping(
    host: String,
    port: Int,
    token: String = "",
  ): ApiResult<PingInfo> = withContext(Dispatchers.IO) {
    val res = executeJsonRequest(
      method = "GET",
      urlStr = "http://${host.trim()}:$port/api/mobile/ping",
      token = token,
      body = null,
      readTimeoutMs = READ_TIMEOUT_MS,
    )
    if (!res.ok) return@withContext ApiResult(false, null, res.message, res.statusCode)
    val data = res.data ?: return@withContext ApiResult(false, null, "无效响应", res.statusCode)
    val stats = data.optJSONObject("todos_stats")
    ApiResult(
      ok = true,
      data = PingInfo(
        service = data.optString("service", "SmartLocalNote"),
        version = data.optString("version", ""),
        hostname = data.optString("hostname", host),
        ip = data.optString("ip", host),
        port = data.optInt("port", port),
        todosOpen = stats?.optInt("open", 0) ?: 0,
        todosTotal = stats?.optInt("total", 0) ?: 0,
      ),
      message = res.message.ifBlank { "连接正常" },
      statusCode = res.statusCode,
    )
  }

  suspend fun pair(
    host: String,
    port: Int,
    pin: String,
    deviceName: String = defaultDeviceName(),
  ): ApiResult<PairResult> = withContext(Dispatchers.IO) {
    val payload = JSONObject().apply {
      put("pin", pin.trim())
      put("device_name", deviceName.ifBlank { defaultDeviceName() })
    }
    val res = executeJsonRequest(
      method = "POST",
      urlStr = "http://${host.trim()}:$port/api/mobile/pair",
      token = "",
      body = payload,
      readTimeoutMs = READ_TIMEOUT_MS,
    )
    if (!res.ok) return@withContext ApiResult(false, null, res.message, res.statusCode)
    val data = res.data ?: return@withContext ApiResult(false, null, "配对响应为空", res.statusCode)
    val token = data.optString("token", "").trim()
    if (token.isBlank()) {
      return@withContext ApiResult(false, null, data.optString("error", "未返回授权 Token"), res.statusCode)
    }
    val returnedHost = host.trim().ifBlank { data.optString("host", data.optString("ip", "")) }
    val returnedPort = port.takeIf { it in 1..65535 } ?: data.optInt("port", AppPrefs.DEFAULT_PORT)
    val hostname = data.optString("hostname", returnedHost).ifBlank { returnedHost }
    ApiResult(
      ok = true,
      data = PairResult(
        token = token,
        host = returnedHost,
        port = returnedPort,
        hostname = hostname,
      ),
      message = res.message.ifBlank { "配对成功" },
      statusCode = res.statusCode,
    )
  }

  suspend fun sendQuickSticky(
    host: String,
    port: Int,
    token: String,
    text: String,
    color: String = "yellow",
    deviceName: String = defaultDeviceName(),
  ): ApiResult<String> = withContext(Dispatchers.IO) {
    val payload = JSONObject().apply {
      put("text", text.trim())
      put("color", color.ifBlank { "yellow" })
      put("device_name", deviceName)
      put("token", token)
    }
    val res = executeJsonRequest(
      method = "POST",
      urlStr = "http://${host.trim()}:$port/api/mobile/quick-sticky",
      token = token,
      body = payload,
      readTimeoutMs = READ_TIMEOUT_MS,
    )
    if (!res.ok) return@withContext ApiResult(false, null, res.message, res.statusCode)
    val stickyId = res.data?.optString("id", "").orEmpty()
    ApiResult(true, stickyId, res.message.ifBlank { "已发送闪念到桌面端" }, res.statusCode)
  }

  suspend fun sendClipboard(
    host: String,
    port: Int,
    token: String,
    text: String,
    deviceName: String = defaultDeviceName(),
  ): ApiResult<Unit> = withContext(Dispatchers.IO) {
    val payload = JSONObject().apply {
      put("text", text.trim())
      put("device_name", deviceName)
      put("token", token)
    }
    val res = executeJsonRequest(
      method = "POST",
      urlStr = "http://${host.trim()}:$port/api/mobile/clipboard",
      token = token,
      body = payload,
      readTimeoutMs = READ_TIMEOUT_MS,
    )
    if (!res.ok) return@withContext ApiResult(false, null, res.message, res.statusCode)
    ApiResult(true, Unit, res.message.ifBlank { "已推送到电脑剪贴板" }, res.statusCode)
  }

  suspend fun uploadFile(
    host: String,
    port: Int,
    token: String,
    filename: String,
    bytes: ByteArray,
    addToShelf: Boolean = true,
    targetDir: String = "手机直传",
    noteAppend: Boolean = false,
  ): ApiResult<UploadResult> {
    val encoded = Base64.encodeToString(bytes, Base64.NO_WRAP)
    return uploadBase64(
      host = host,
      port = port,
      token = token,
      filename = filename,
      contentBase64 = encoded,
      addToShelf = addToShelf,
      targetDir = targetDir,
      noteAppend = noteAppend,
    )
  }

  suspend fun uploadBase64(
    host: String,
    port: Int,
    token: String,
    filename: String,
    contentBase64: String,
    addToShelf: Boolean = true,
    targetDir: String = "手机直传",
    noteAppend: Boolean = false,
  ): ApiResult<UploadResult> = withContext(Dispatchers.IO) {
    val payload = JSONObject().apply {
      put("filename", filename.ifBlank { "upload_${System.currentTimeMillis()}.bin" })
      put("content_base64", contentBase64)
      put("target_dir", targetDir)
      put("add_to_shelf", addToShelf)
      put("note_append", noteAppend)
      put("token", token)
    }
    val res = executeJsonRequest(
      method = "POST",
      urlStr = "http://${host.trim()}:$port/api/mobile/upload",
      token = token,
      body = payload,
      readTimeoutMs = UPLOAD_READ_TIMEOUT_MS,
    )
    if (!res.ok) return@withContext ApiResult(false, null, res.message, res.statusCode)
    val data = res.data
    ApiResult(
      ok = true,
      data = UploadResult(
        name = data?.optString("name", filename).orEmpty(),
        relDir = data?.optString("rel_dir", targetDir).orEmpty(),
        size = data?.optLong("size", 0L) ?: 0L,
      ),
      message = res.message.ifBlank { "文件已直传到电脑" },
      statusCode = res.statusCode,
    )
  }

  suspend fun flushOfflineQueue(prefs: AppPrefs): FlushResult = withContext(Dispatchers.IO) {
    val queue = prefs.getOfflineQueue()
    if (queue.isEmpty()) return@withContext FlushResult(0, 0)
    if (!prefs.isPaired) {
      return@withContext FlushResult(0, queue.size, "尚未配对电脑")
    }

    val host = prefs.host
    val port = prefs.port
    val token = prefs.token
    var synced = 0
    var lastError = ""

    for (item in queue) {
      val result: ApiResult<*> = when (item.kind) {
        "sticky" -> sendQuickSticky(host, port, token, item.text, item.color)
        "clipboard" -> sendClipboard(host, port, token, item.text)
        "upload" -> uploadBase64(
          host = host,
          port = port,
          token = token,
          filename = item.filename.ifBlank { "offline_${item.createdAt}.bin" },
          contentBase64 = item.base64,
          addToShelf = item.addToShelf,
        )
        else -> ApiResult(true, Unit)
      }

      if (result.ok) {
        prefs.removeOfflineItem(item.id)
        synced++
      } else {
        lastError = result.message
        // Stop on connectivity/auth failure to avoid hanging on every item
        if (result.statusCode == 0 || result.statusCode == 401 || result.statusCode == 403) {
          break
        }
      }
    }

    FlushResult(
      syncedCount = synced,
      remainingCount = prefs.pendingOfflineCount(),
      lastError = lastError,
    )
  }

  private fun executeJsonRequest(
    method: String,
    urlStr: String,
    token: String,
    body: JSONObject?,
    readTimeoutMs: Int,
  ): ApiResult<JSONObject> {
    var conn: HttpURLConnection? = null
    return try {
      val url = URL(urlStr)
      conn = (url.openConnection() as HttpURLConnection).apply {
        requestMethod = method
        connectTimeout = CONNECT_TIMEOUT_MS
        readTimeout = readTimeoutMs
        useCaches = false
        setRequestProperty("Accept", "application/json")
        if (token.isNotBlank()) {
          setRequestProperty("X-SLN-Token", token)
        }
        if (body != null) {
          doOutput = true
          setRequestProperty("Content-Type", "application/json; charset=utf-8")
        }
      }

      if (body != null) {
        val bytes = body.toString().toByteArray(Charsets.UTF_8)
        conn.setFixedLengthStreamingMode(bytes.size)
        conn.outputStream.use { os ->
          os.write(bytes)
          os.flush()
        }
      }

      val status = conn.responseCode
      val stream = if (status in 200..299) conn.inputStream else conn.errorStream
      val rawText = if (stream != null) {
        BufferedReader(InputStreamReader(stream, Charsets.UTF_8)).use { it.readText() }
      } else {
        ""
      }

      val parsed = try {
        if (rawText.trim().startsWith("{")) JSONObject(rawText) else null
      } catch (_: Exception) {
        null
      }

      if (status in 200..299) {
        val envelopeOk = parsed?.optBoolean("ok", true) ?: true
        val msg = parsed?.optString("message", "").orEmpty()
        if (!envelopeOk) {
          return ApiResult(false, null, msg.ifBlank { "请求被拒绝" }, status)
        }
        val innerData = parsed?.optJSONObject("data") ?: parsed ?: JSONObject()
        ApiResult(true, innerData, msg, status)
      } else {
        val errMsg = parsed?.optString("message", "").orEmpty()
          .ifBlank { parsed?.optString("detail", "").orEmpty() }
          .ifBlank { "HTTP $status" }
        ApiResult(false, null, errMsg, status)
      }
    } catch (e: Exception) {
      val friendly = when {
        e.message?.contains("ECONNREFUSED", ignoreCase = true) == true -> "无法连接到电脑，请确认桌面端已启动"
        e.message?.contains("timed out", ignoreCase = true) == true -> "连接超时，请检查同一 Wi-Fi / Tailscale"
        e.message?.contains("ENETUNREACH", ignoreCase = true) == true ||
          e.message?.contains("EHOSTUNREACH", ignoreCase = true) == true -> "当前网络不可达电脑"
        else -> e.localizedMessage ?: "网络连接失败"
      }
      ApiResult(false, null, friendly, 0)
    } finally {
      conn?.disconnect()
    }
  }
}
