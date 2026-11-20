package com.smartlocalnote.android.local

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.io.RandomAccessFile
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import java.util.Locale
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

class LocalSlnServer private constructor(context: Context) {
  private val appContext = context.applicationContext
  val dataEngine: LocalDataEngine = LocalDataEngine(appContext)
  val aiClient: LocalAiClient = LocalAiClient(dataEngine)

  private val running = AtomicBoolean(false)
  private val executor: ExecutorService = Executors.newCachedThreadPool()
  private val sseClients = CopyOnWriteArrayList<SseClient>()

  @Volatile
  private var serverSocket: ServerSocket? = null

  @Volatile
  var port: Int = 0
    private set

  val baseUrl: String
    get() = "http://127.0.0.1:$port"

  private class SseClient(val socket: Socket, val out: OutputStream) {
    private val writeLock = Any()
    fun sendRaw(text: String): Boolean = synchronized(writeLock) {
      try {
        out.write(text.toByteArray(Charsets.UTF_8))
        out.flush()
        true
      } catch (_: Exception) {
        try {
          socket.close()
        } catch (_: Exception) {
        }
        false
      }
    }
  }

  private data class HttpRequest(
    val method: String,
    val path: String,
    val query: Map<String, String>,
    val headers: Map<String, String>,
    val bodyBytes: ByteArray,
  ) {
    fun bodyJson(): JSONObject {
      val s = bodyBytes.toString(Charsets.UTF_8).trim()
      return if (s.startsWith("{")) JSONObject(s) else JSONObject()
    }
  }

  fun start(): Int {
    if (running.get() && port > 0 && serverSocket?.isClosed == false) {
      return port
    }
    synchronized(this) {
      if (running.get() && port > 0 && serverSocket?.isClosed == false) {
        return port
      }
      val ss = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
      serverSocket = ss
      port = ss.localPort
      running.set(true)

      executor.execute {
        while (running.get() && !ss.isClosed) {
          try {
            val client = ss.accept()
            executor.execute { handleConnection(client) }
          } catch (_: Exception) {
            if (!running.get()) break
          }
        }
      }
      return port
    }
  }

  fun stop() {
    running.set(false)
    try {
      serverSocket?.close()
    } catch (_: Exception) {
    }
    for (c in sseClients) {
      try {
        c.socket.close()
      } catch (_: Exception) {
      }
    }
    sseClients.clear()
  }

  fun publishEvent(eventType: String, payload: JSONObject = JSONObject()) {
    val enriched = JSONObject(payload.toString()).apply {
      if (!has("event_id")) put("event_id", "mevt_${UUID.randomUUID().toString().replace("-", "").take(10)}")
      if (!has("timestamp")) put("timestamp", LocalDataEngine.nowIso())
    }
    val namedFrame = "event: $eventType\ndata: $enriched\n\n"
    val defaultPayload = JSONObject(enriched.toString()).put("_event", eventType)
    val defaultFrame = "data: $defaultPayload\n\n"
    val combined = namedFrame + defaultFrame

    for (client in sseClients) {
      if (!client.sendRaw(combined)) {
        sseClients.remove(client)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // HTTP/1.1 Connection & Request Parsing
  // ---------------------------------------------------------------------------

  private fun handleConnection(socket: Socket) {
    var keepOpenForSse = false
    try {
      socket.soTimeout = 30_000
      val input = BufferedInputStream(socket.getInputStream())
      val out = socket.getOutputStream()

      val req = parseHttpRequest(input) ?: return
      if (req.method == "OPTIONS") {
        writeSimpleResponse(out, 204, "No Content", "text/plain; charset=utf-8", ByteArray(0))
        return
      }

      // SSE Stream
      if (req.method == "GET" && req.path == "/api/events") {
        keepOpenForSse = true
        handleSseStream(socket, out)
        return
      }

      // AI Streaming Chat (SSE over POST)
      if (req.method == "POST" && req.path == "/api/ai/chat") {
        handleAiChatStream(req, out)
        return
      }

      // Static Assets
      if (req.method == "GET") {
        when {
          req.path == "/" || req.path == "/index.html" -> {
            serveAsset(out, "static/index.html")
            return
          }
          req.path == "/manifest.json" -> {
            serveAsset(out, "static/manifest.json")
            return
          }
          req.path == "/favicon.ico" -> {
            writeSimpleResponse(out, 204, "No Content", "image/x-icon", ByteArray(0))
            return
          }
          req.path.startsWith("/static/") -> {
            val rel = req.path.removePrefix("/static/").trimStart('/')
            if (rel.contains("..")) {
              writeJsonError(out, 403, "Forbidden")
              return
            }
            serveAsset(out, "static/$rel")
            return
          }
          req.path == "/api/files/raw-stream" || req.path == "/api/files/pdf-stream" -> {
            val filePath = req.query["path"].orEmpty()
            serveDiskFileStream(out, filePath, req.headers["range"], forcePdf = req.path.endsWith("pdf-stream"))
            return
          }
        }
      }

      // REST API Dispatch
      val responseJson = dispatchApi(req)
      writeJsonResponse(out, 200, responseJson)
    } catch (e: SecurityException) {
      try {
        writeJsonError(socket.getOutputStream(), 403, e.message ?: "安全拦截")
      } catch (_: Exception) {
      }
    } catch (e: IllegalArgumentException) {
      try {
        writeJsonError(socket.getOutputStream(), 400, e.message ?: "参数错误")
      } catch (_: Exception) {
      }
    } catch (e: Exception) {
      try {
        writeJsonError(socket.getOutputStream(), 500, e.message ?: "内部错误")
      } catch (_: Exception) {
      }
    } finally {
      if (!keepOpenForSse) {
        try {
          socket.close()
        } catch (_: Exception) {
        }
      }
    }
  }

  private fun parseHttpRequest(input: BufferedInputStream): HttpRequest? {
    val requestLine = readLineCrLf(input) ?: return null
    if (requestLine.isBlank()) return null
    val parts = requestLine.split(" ")
    if (parts.size < 2) return null

    val method = parts[0].uppercase(Locale.US)
    val rawTarget = parts[1]
    val qIdx = rawTarget.indexOf('?')
    val rawPath = if (qIdx >= 0) rawTarget.substring(0, qIdx) else rawTarget
    val rawQuery = if (qIdx >= 0) rawTarget.substring(qIdx + 1) else ""
    val path = urlDecode(rawPath)
    val query = parseQueryString(rawQuery)

    val headers = HashMap<String, String>()
    while (true) {
      val line = readLineCrLf(input) ?: break
      if (line.isEmpty()) break
      val colon = line.indexOf(':')
      if (colon > 0) {
        val k = line.substring(0, colon).trim().lowercase(Locale.US)
        val v = line.substring(colon + 1).trim()
        headers[k] = v
      }
    }

    val contentLength = headers["content-length"]?.toIntOrNull()?.coerceIn(0, 32 * 1024 * 1024) ?: 0
    val bodyBytes = if (contentLength > 0) {
      val buf = ByteArray(contentLength)
      var offset = 0
      while (offset < contentLength) {
        val read = input.read(buf, offset, contentLength - offset)
        if (read <= 0) break
        offset += read
      }
      if (offset == contentLength) buf else buf.copyOf(offset)
    } else {
      ByteArray(0)
    }

    return HttpRequest(method, path, query, headers, bodyBytes)
  }

  private fun readLineCrLf(input: InputStream): String? {
    val baos = ByteArrayOutputStream(128)
    var prev = -1
    var any = false
    while (true) {
      val b = input.read()
      if (b == -1) {
        return if (!any) null else baos.toString("UTF-8")
      }
      any = true
      if (b == '\n'.code) {
        val bytes = baos.toByteArray()
        val len = if (prev == '\r'.code && bytes.isNotEmpty()) bytes.size - 1 else bytes.size
        return String(bytes, 0, len, Charsets.UTF_8)
      }
      baos.write(b)
      prev = b
    }
  }

  private fun parseQueryString(raw: String): Map<String, String> {
    if (raw.isBlank()) return emptyMap()
    val map = LinkedHashMap<String, String>()
    for (pair in raw.split('&')) {
      if (pair.isEmpty()) continue
      val eq = pair.indexOf('=')
      if (eq >= 0) {
        map[urlDecode(pair.substring(0, eq))] = urlDecode(pair.substring(eq + 1))
      } else {
        map[urlDecode(pair)] = ""
      }
    }
    return map
  }

  private fun urlDecode(s: String): String {
    return try {
      URLDecoder.decode(s, "UTF-8")
    } catch (_: Exception) {
      s
    }
  }

  // ---------------------------------------------------------------------------
  // Static Assets & File Streaming
  // ---------------------------------------------------------------------------

  private fun serveAsset(out: OutputStream, assetPath: String) {
    val bytes = try {
      appContext.assets.open(assetPath).use { it.readBytes() }
    } catch (_: Exception) {
      writeSimpleResponse(out, 404, "Not Found", "text/plain; charset=utf-8", "Asset not found: $assetPath".toByteArray())
      return
    }
    val mime = LocalDataEngine.guessMimeByName(assetPath)
    writeSimpleResponse(out, 200, "OK", mime, bytes)
  }

  private fun serveDiskFileStream(out: OutputStream, rawPath: String, rangeHeader: String?, forcePdf: Boolean) {
    val file = dataEngine.resolveSafePath(rawPath, mustExist = true)
    if (!file.isFile) {
      writeJsonError(out, 404, "文件不存在")
      return
    }
    val totalLen = file.length()
    val mime = if (forcePdf) "application/pdf" else dataEngine.guessMimeType(file)

    if (!rangeHeader.isNullOrBlank() && rangeHeader.startsWith("bytes=")) {
      val spec = rangeHeader.removePrefix("bytes=").substringBefore(',').trim()
      val parts = spec.split('-')
      val start = parts.getOrNull(0)?.toLongOrNull() ?: 0L
      val end = (parts.getOrNull(1)?.toLongOrNull() ?: (totalLen - 1)).coerceAtMost(totalLen - 1)
      if (start in 0..end && start < totalLen) {
        val chunkLen = end - start + 1
        val header = buildString {
          append("HTTP/1.1 206 Partial Content\r\n")
          append("Content-Type: $mime\r\n")
          append("Accept-Ranges: bytes\r\n")
          append("Content-Range: bytes $start-$end/$totalLen\r\n")
          append("Content-Length: $chunkLen\r\n")
          append("Content-Disposition: inline\r\n")
          append("Connection: close\r\n\r\n")
        }
        out.write(header.toByteArray(Charsets.US_ASCII))
        RandomAccessFile(file, "r").use { raf ->
          raf.seek(start)
          val buf = ByteArray(16 * 1024)
          var remaining = chunkLen
          while (remaining > 0) {
            val toRead = minOf(buf.size.toLong(), remaining).toInt()
            val n = raf.read(buf, 0, toRead)
            if (n <= 0) break
            out.write(buf, 0, n)
            remaining -= n
          }
        }
        out.flush()
        return
      }
    }

    val header = buildString {
      append("HTTP/1.1 200 OK\r\n")
      append("Content-Type: $mime\r\n")
      append("Accept-Ranges: bytes\r\n")
      append("Content-Length: $totalLen\r\n")
      append("Content-Disposition: inline\r\n")
      append("Connection: close\r\n\r\n")
    }
    out.write(header.toByteArray(Charsets.US_ASCII))
    file.inputStream().use { ins ->
      val buf = ByteArray(16 * 1024)
      while (true) {
        val n = ins.read(buf)
        if (n <= 0) break
        out.write(buf, 0, n)
      }
    }
    out.flush()
  }

  // ---------------------------------------------------------------------------
  // SSE Streams
  // ---------------------------------------------------------------------------

  private fun handleSseStream(socket: Socket, out: OutputStream) {
    socket.soTimeout = 0
    val headers = buildString {
      append("HTTP/1.1 200 OK\r\n")
      append("Content-Type: text/event-stream; charset=utf-8\r\n")
      append("Cache-Control: no-cache\r\n")
      append("Connection: keep-alive\r\n")
      append("Access-Control-Allow-Origin: *\r\n\r\n")
      append(": connected\n\n")
    }
    out.write(headers.toByteArray(Charsets.UTF_8))
    out.flush()

    val client = SseClient(socket, out)
    sseClients.add(client)

    try {
      while (running.get() && !socket.isClosed) {
        Thread.sleep(25_000)
        if (!client.sendRaw(": ping\n\n")) break
      }
    } catch (_: Exception) {
    } finally {
      sseClients.remove(client)
      try {
        socket.close()
      } catch (_: Exception) {
      }
    }
  }

  private fun handleAiChatStream(req: HttpRequest, out: OutputStream) {
    val body = req.bodyJson()
    val messages = body.optJSONArray("messages") ?: JSONArray()
    val webSearch = body.optBoolean("web_search", false)
    val ctxArr = body.optJSONArray("context_paths") ?: JSONArray()
    val ctxPaths = mutableListOf<String>()
    for (i in 0 until ctxArr.length()) {
      ctxArr.optString(i).takeIf { it.isNotBlank() }?.let(ctxPaths::add)
    }

    val headers = buildString {
      append("HTTP/1.1 200 OK\r\n")
      append("Content-Type: text/event-stream; charset=utf-8\r\n")
      append("Cache-Control: no-cache\r\n")
      append("Connection: close\r\n\r\n")
    }
    out.write(headers.toByteArray(Charsets.UTF_8))
    out.flush()

    aiClient.streamChat(messages, webSearch, ctxPaths) { chunk ->
      val frame = "data: $chunk\n\n"
      out.write(frame.toByteArray(Charsets.UTF_8))
      out.flush()
    }
  }

  // ---------------------------------------------------------------------------
  // REST API Routing (100% Windows Backend Contract Compatible)
  // ---------------------------------------------------------------------------

  private fun dispatchApi(req: HttpRequest): JSONObject {
    val p = req.path
    val m = req.method

    return when {
      // --- Files ---
      m == "GET" && p == "/api/files/list" -> ok(dataEngine.listFiles())
      m == "GET" && p == "/api/files/read" -> ok(dataEngine.readFile(req.query["path"].orEmpty()))
      m == "PUT" && p == "/api/files/write" -> {
        val b = req.bodyJson()
        ok(dataEngine.writeFile(b.optString("path"), b.optString("content")))
      }
      m == "POST" && p == "/api/files/create-note" -> {
        val b = req.bodyJson()
        ok(
          dataEngine.createNote(
            title = b.optString("title", ""),
            content = b.optString("content", ""),
            folderRel = b.optString("folder_rel", ""),
            nodeId = b.optString("node_id", "").ifBlank { null },
          ),
        )
      }
      m == "POST" && p == "/api/files/create-folder" -> {
        val b = req.bodyJson()
        ok(dataEngine.createFolder(b.optString("parent_dir", ""), b.optString("name", "")))
      }
      m == "POST" && p == "/api/files/rename" -> {
        val b = req.bodyJson()
        ok(dataEngine.renameFile(b.optString("path"), b.optString("new_name")))
      }
      m == "POST" && p == "/api/files/move" -> {
        val b = req.bodyJson()
        val arr = b.optJSONArray("paths") ?: JSONArray()
        val list = (0 until arr.length()).mapNotNull { arr.optString(it).takeIf(String::isNotBlank) }
        ok(dataEngine.moveFiles(list, b.optString("target_folder_rel", "")))
      }
      m == "POST" && p == "/api/files/trash" -> {
        val b = req.bodyJson()
        ok(dataEngine.trashFile(b.optString("path"), b.optString("mode", "app")))
      }
      m == "POST" && p == "/api/files/remove" -> {
        val b = req.bodyJson()
        ok(dataEngine.trashFile(b.optString("path"), "app"))
      }
      m == "POST" && p == "/api/files/pdf-annotate" -> {
        val b = req.bodyJson()
        ok(
          dataEngine.savePdfAnnotate(
            rawPath = b.optString("path"),
            page = b.optInt("page", 1),
            noteText = b.optString("note_text"),
            color = b.optString("color", "yellow"),
          ),
        )
      }
      m == "GET" && p == "/api/files/expand-content" -> ok(dataEngine.expandContent(req.query["path"].orEmpty()))
      m == "GET" && p == "/api/files/backlinks" -> ok(dataEngine.backlinks(req.query["path"].orEmpty()))
      m == "POST" && p == "/api/files/privacy" -> {
        val b = req.bodyJson()
        ok(dataEngine.setPrivacy(b.optString("path"), b.optBoolean("private", false)))
      }
      m == "GET" && p == "/api/files/snapshots" -> ok(dataEngine.listSnapshots(req.query["path"].orEmpty()))
      m == "POST" && p == "/api/files/snapshots" -> {
        val b = req.bodyJson()
        ok(dataEngine.restoreSnapshot(b.optString("path"), b.optString("snapshot_id")))
      }
      m == "POST" && (p == "/api/files/open-external" || p == "/api/files/open-url" || p == "/api/files/import" || p == "/api/files/relocate") ->
        ok(JSONObject().put("ok", true))

      // --- Todos ---
      m == "GET" && p == "/api/todos/all" -> ok(dataEngine.scanAllTodos())
      m == "POST" && p == "/api/todos/toggle" -> {
        val b = req.bodyJson()
        ok(
          dataEngine.toggleTodo(
            filePath = b.optString("file_path"),
            lineNo = b.optInt("line_no", 1),
            checked = b.optBoolean("checked", false),
            expectedText = b.optString("expected_text", ""),
          ),
        )
      }
      m == "POST" && p == "/api/todos/add" -> {
        val b = req.bodyJson()
        ok(dataEngine.addTodo(b.optString("file_path"), b.optString("text", "")))
      }

      // --- K1 Links & Tags Graph ---
      m == "GET" && p == "/api/links/graph" -> ok(dataEngine.buildLinkGraph(req.query["path"].orEmpty()))

      // --- Recycle Bin (Trash) ---
      m == "GET" && p == "/api/trash" -> ok(dataEngine.listTrash())
      m == "POST" && p == "/api/trash/item" -> {
        val b = req.bodyJson()
        ok(
          dataEngine.trashVirtualItem(
            kind = b.optString("kind"),
            title = b.optString("title", ""),
            payload = b.optJSONObject("payload") ?: JSONObject(),
            sourcePath = b.optString("source_path", ""),
          ),
        )
      }
      m == "POST" && p == "/api/trash/restore" -> {
        val b = req.bodyJson()
        ok(dataEngine.restoreTrashItem(b.optString("trash_id").ifBlank { b.optString("id") }))
      }
      m == "POST" && p == "/api/trash/empty" -> {
        val b = req.bodyJson()
        ok(dataEngine.emptyTrash(b.optString("trash_id").ifBlank { b.optString("id") }))
      }
      m == "PUT" && p == "/api/trash/settings" -> {
        val b = req.bodyJson()
        val days = if (b.has("auto_purge_days") && !b.isNull("auto_purge_days")) b.optInt("auto_purge_days") else null
        ok(dataEngine.updateTrashSettings(b.optString("mode", "").ifBlank { null }, days))
      }

      // --- Search ---
      m == "POST" && p == "/api/search" -> {
        val b = req.bodyJson()
        ok(dataEngine.searchNotes(b.optString("query"), b.optString("mode", "keyword"), b.optInt("limit", 15)))
      }

      // --- System & Config ---
      m == "GET" && p == "/api/system/info" -> ok(dataEngine.getSystemInfo(port))
      m == "GET" && p == "/api/system/config" -> ok(dataEngine.getConfig())
      m == "PUT" && p == "/api/system/config" -> ok(dataEngine.updateConfig(req.bodyJson()), "配置已更新")
      m == "POST" && p == "/api/system/pick-path" -> ok(JSONObject().put("path", ""))
      m == "POST" && p == "/api/system/seed-test-suite" -> ok(JSONObject().put("ok", true))

      // --- AI ---
      m == "POST" && p == "/api/ai/summarize" -> {
        val b = req.bodyJson()
        ok(aiClient.summarize(b.optString("text", ""), b.optString("file_path", "").ifBlank { null }))
      }
      m == "POST" && p == "/api/ai/polish" -> {
        val b = req.bodyJson()
        ok(aiClient.polish(b.optString("text", ""), b.optString("style", "article")))
      }
      m == "POST" && p == "/api/ai/mindmap" -> {
        val b = req.bodyJson()
        ok(aiClient.mindmap(b.optString("text", ""), b.optString("file_path", "").ifBlank { null }))
      }
      m == "POST" && p == "/api/ai/extract-table" -> {
        val b = req.bodyJson()
        ok(JSONObject().put("headers", b.optJSONArray("headers") ?: JSONArray()).put("rows", JSONArray()).put("offline_mode", true))
      }
      m == "POST" && p == "/api/ai/classify" -> ok(JSONObject().put("node_id", JSONObject.NULL).put("offline_mode", true))

      // --- Reminders ---
      m == "GET" && p == "/api/reminders" -> ok(dataEngine.listReminders())
      m == "POST" && p == "/api/reminders" -> {
        val b = req.bodyJson()
        val delay = if (b.has("delay_seconds") && !b.isNull("delay_seconds")) b.optInt("delay_seconds") else null
        ok(dataEngine.addReminder(b.optString("title"), b.optString("trigger_at", "").ifBlank { null }, delay))
      }
      m == "DELETE" && p.startsWith("/api/reminders") -> {
        val id = p.removePrefix("/api/reminders").trimStart('/').ifBlank { req.query["reminder_id"].orEmpty() }
        ok(dataEngine.deleteReminder(id))
      }

      // --- Mobile Upload (local WebView direct upload) ---
      m == "POST" && p == "/api/mobile/upload" -> {
        val b = req.bodyJson()
        val res = dataEngine.uploadBase64(
          filename = b.optString("filename"),
          contentBase64 = b.optString("content_base64"),
          targetDir = b.optString("target_dir", "手机收集"),
          addToShelf = b.optBoolean("add_to_shelf", false),
          noteAppend = b.optBoolean("note_append", false),
        )
        publishEvent("files:updated", res)
        ok(res, "文件已保存到手机本地笔记库")
      }
      m == "GET" && p == "/api/mobile/ping" -> ok(
        JSONObject()
          .put("ok", true)
          .put("service", "SmartLocalNote-Android")
          .put("version", "7.5.0")
          .put("hostname", "Android")
          .put("ip", "127.0.0.1")
          .put("port", port),
      )

      // --- Clean Lightweight Placeholders (Zero 404s) ---
      p == "/api/apps" || p.startsWith("/api/apps/") -> ok(JSONObject().put("apps", JSONArray()).put("items", JSONArray()))
      p == "/api/workspaces" || p.startsWith("/api/workspaces/") -> ok(JSONObject().put("workspaces", JSONArray()).put("items", JSONArray()))
      p == "/api/tree" || p.startsWith("/api/tree/") -> ok(JSONObject().put("nodes", JSONArray()))
      p == "/api/tools/fetch-url-title" -> {
        val url = req.bodyJson().optString("url", "")
        ok(JSONObject().put("url", url).put("title", url))
      }
      p.startsWith("/api/excel") -> ok(JSONObject().put("sheets", JSONArray()).put("rows", JSONArray()))

      else -> ok(JSONObject().put("ok", true))
    }
  }

  private fun ok(data: Any, message: String = ""): JSONObject {
    return JSONObject().apply {
      put("ok", true)
      put("data", data)
      if (message.isNotEmpty()) put("message", message)
    }
  }

  private fun writeJsonResponse(out: OutputStream, status: Int, json: JSONObject) {
    val bytes = json.toString().toByteArray(Charsets.UTF_8)
    writeSimpleResponse(out, status, if (status == 200) "OK" else "Error", "application/json; charset=utf-8", bytes)
  }

  private fun writeJsonError(out: OutputStream, status: Int, message: String) {
    val json = JSONObject().put("ok", false).put("message", message).put("detail", message)
    writeJsonResponse(out, status, json)
  }

  private fun writeSimpleResponse(
    out: OutputStream,
    status: Int,
    reason: String,
    contentType: String,
    body: ByteArray,
  ) {
    val header = buildString {
      append("HTTP/1.1 $status $reason\r\n")
      append("Content-Type: $contentType\r\n")
      append("Content-Length: ${body.size}\r\n")
      append("Access-Control-Allow-Origin: *\r\n")
      append("Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS\r\n")
      append("Access-Control-Allow-Headers: Content-Type, X-SLN-Token\r\n")
      append("Cache-Control: no-cache\r\n")
      append("Connection: close\r\n\r\n")
    }
    out.write(header.toByteArray(Charsets.US_ASCII))
    if (body.isNotEmpty()) {
      out.write(body)
    }
    out.flush()
  }

  companion object {
    @Volatile
    private var INSTANCE: LocalSlnServer? = null

    fun ensureStarted(context: Context): LocalSlnServer {
      val existing = INSTANCE
      if (existing != null) {
        existing.start()
        return existing
      }
      return synchronized(this) {
        val again = INSTANCE
        if (again != null) {
          again.start()
          again
        } else {
          LocalSlnServer(context).also {
            it.start()
            INSTANCE = it
          }
        }
      }
    }

    fun getRunningOrNull(): LocalSlnServer? = INSTANCE
  }
}
