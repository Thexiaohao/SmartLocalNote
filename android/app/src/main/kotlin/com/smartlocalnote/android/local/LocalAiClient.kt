package com.smartlocalnote.android.local

import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL

class LocalAiClient(private val dataEngine: LocalDataEngine) {

  private data class AiConfig(
    val baseUrl: String,
    val apiKey: String,
    val model: String,
  ) {
    val isConfigured: Boolean get() = baseUrl.isNotBlank() && apiKey.isNotBlank()
  }

  private fun readAiConfig(): AiConfig {
    val cfg = dataEngine.getConfig()
    val ai = cfg.optJSONObject("ai") ?: JSONObject()
    val baseUrl = ai.optString("base_url", "").trim().ifEmpty { "https://api.openai.com/v1" }
    val apiKey = ai.optString("api_key", "").trim()
    val model = ai.optString("model", "").trim().ifEmpty { "gpt-4o-mini" }
    return AiConfig(baseUrl = baseUrl, apiKey = apiKey, model = model)
  }

  private fun buildChatUrl(baseUrl: String): String {
    val clean = baseUrl.trimEnd('/')
    return if (clean.endsWith("/chat/completions")) clean else "$clean/chat/completions"
  }

  private fun extractFileText(filePath: String?, maxChars: Int = 5500): String {
    val p = filePath?.trim().orEmpty()
    if (p.isEmpty()) return ""
    return try {
      val f = dataEngine.resolveSafePath(p, mustExist = true)
      dataEngine.readTextSafe(f).take(maxChars)
    } catch (_: Exception) {
      ""
    }
  }

  // ---------------------------------------------------------------------------
  // 1. Summarize
  // ---------------------------------------------------------------------------

  fun summarize(text: String, filePath: String?): JSONObject {
    val parts = mutableListOf<String>()
    val fileText = extractFileText(filePath, 5500)
    if (fileText.isNotBlank()) parts.add(fileText)
    if (text.isNotBlank()) parts.add(text.trim())
    val combined = parts.joinToString("\n\n").trim()
    if (combined.isEmpty()) {
      return offlineSummarize("（暂无文本内容）")
    }

    val cfg = readAiConfig()
    if (!cfg.isConfigured) {
      return offlineSummarize(combined)
    }

    return try {
      val sys = """你是 SmartLocalNote 智能助手。请将用户输入整理为严格 JSON（不要输出多余解释）：
{"summary":"简洁中文总结(2-3句)","tags":["标签1","标签2"],"todos":[{"title":"待办事项","suggested_time":"","priority":"medium"}],"trigger_time":null}"""
      val raw = callChatCompletion(cfg, sys, combined.take(6000))
      val jsonText = extractJsonObjectString(raw)
      val parsed = JSONObject(jsonText)
      JSONObject().apply {
        put("summary", parsed.optString("summary", "").ifBlank { combined.take(120) })
        put("tags", parsed.optJSONArray("tags") ?: JSONArray())
        put("todos", parsed.optJSONArray("todos") ?: JSONArray())
        put("trigger_time", parsed.opt("trigger_time") ?: JSONObject.NULL)
        put("matched_app_ids", JSONArray())
        put("matched_files", JSONArray())
        put("matched_apps", JSONArray())
        put("offline_mode", false)
        put("provider_label", "AI 直连 (${cfg.model})")
      }
    } catch (_: Exception) {
      offlineSummarize(combined)
    }
  }

  private fun offlineSummarize(text: String): JSONObject {
    val lines = text.lines().map { it.trim() }.filter { it.isNotEmpty() }
    val headings = lines.filter { it.startsWith("#") }.map { it.trimStart('#').trim() }
    val bodyLines = lines.filterNot { it.startsWith("#") }
    val sentences = bodyLines.joinToString(" ")
      .split(Regex("[。！？!?\\n]+"))
      .map { it.trim() }
      .filter { it.length >= 4 }

    val summary = when {
      headings.isNotEmpty() && sentences.isNotEmpty() ->
        "核心主题为「${headings.first().take(24)}」，要点包括：${sentences.take(2).joinToString("；").take(140)}。"
      sentences.isNotEmpty() ->
        sentences.take(2).joinToString("；").take(150) + "。"
      else -> text.take(120)
    }

    val tagsArr = JSONArray()
    val tagRx = Regex("#([A-Za-z0-9_\\u4e00-\\u9fa5\\-]{1,20})")
    val seenTags = LinkedHashSet<String>()
    for (m in tagRx.findAll(text)) {
      val t = m.groupValues[1]
      if (seenTags.add(t) && seenTags.size <= 6) tagsArr.put(t)
    }

    val todosArr = JSONArray()
    val todoRx = Regex("^[-*+]\\s+\\[[ xX]\\]\\s+(.+)$")
    for (ln in lines) {
      val m = todoRx.matchEntire(ln)
      if (m != null) {
        todosArr.put(
          JSONObject().apply {
            put("title", m.groupValues[1].trim())
            put("suggested_time", "")
            put("priority", "medium")
          },
        )
      }
    }

    return JSONObject().apply {
      put("summary", summary)
      put("tags", tagsArr)
      put("todos", todosArr)
      put("trigger_time", JSONObject.NULL)
      put("matched_app_ids", JSONArray())
      put("matched_files", JSONArray())
      put("matched_apps", JSONArray())
      put("offline_mode", true)
      put("provider_label", "手机离线规则提炼（配置 API Key 可解锁云端大模型）")
    }
  }

  // ---------------------------------------------------------------------------
  // 2. Polish
  // ---------------------------------------------------------------------------

  fun polish(text: String, style: String = "article"): JSONObject {
    val clean = text.trim()
    if (clean.isEmpty()) {
      return JSONObject()
        .put("markdown", "")
        .put("offline_mode", true)
        .put("provider_label", "手机离线规则整理")
    }

    val cfg = readAiConfig()
    if (cfg.isConfigured) {
      try {
        val sys = "你是 SmartLocalNote 文档润色助手。请将用户的零散笔记润色整理为结构清晰的 Markdown（风格：$style），完整保留所有 [[...]] 双链与 - [ ] 待办，直接输出 Markdown 正文。"
        val md = stripMarkdownFence(callChatCompletion(cfg, sys, clean.take(6500)))
        if (md.isNotBlank()) {
          return JSONObject()
            .put("markdown", md)
            .put("offline_mode", false)
            .put("provider_label", "AI 直连 (${cfg.model})")
        }
      } catch (_: Exception) {
      }
    }

    // Offline rule-based polish
    val lines = clean.lines().map { it.trim() }.filter { it.isNotEmpty() }
    val todos = lines.filter { Regex("^[-*+]\\s+\\[[ xX]\\]\\s+").containsMatchIn(it) }
    val normal = lines.filterNot { Regex("^[-*+]\\s+\\[[ xX]\\]\\s+").containsMatchIn(it) }
    val sb = StringBuilder()
    if (normal.none { it.startsWith("# ") }) {
      val firstTitle = normal.firstOrNull()?.trimStart('#', '-', '*', ' ')?.take(24) ?: "整理汇总笔记"
      sb.append("# ").append(firstTitle).append("\n\n")
    }
    if (normal.isNotEmpty()) {
      sb.append("## 核心要点\n\n")
      normal.forEach { ln ->
        if (ln.startsWith("#") || ln.startsWith("-") || ln.startsWith("*") || ln.startsWith(">")) {
          sb.append(ln).append("\n")
        } else {
          sb.append("- ").append(ln).append("\n")
        }
      }
    }
    if (todos.isNotEmpty()) {
      sb.append("\n## 待办与行动清单\n\n")
      todos.forEach { sb.append(it).append("\n") }
    }

    return JSONObject()
      .put("markdown", sb.toString().trim())
      .put("offline_mode", true)
      .put("provider_label", "手机离线规则整理")
  }

  // ---------------------------------------------------------------------------
  // 3. Mindmap
  // ---------------------------------------------------------------------------

  fun mindmap(text: String, filePath: String?): JSONObject {
    val fileText = extractFileText(filePath, 5500)
    val combined = listOf(fileText, text.trim()).filter { it.isNotBlank() }.joinToString("\n\n")
    val defaultTitle = filePath?.substringAfterLast('/')?.substringBeforeLast('.')?.ifBlank { "思维导图" } ?: "思维导图"

    val cfg = readAiConfig()
    if (cfg.isConfigured && combined.isNotBlank()) {
      try {
        val sys = "你是思维导图大纲生成助手。请将输入提炼为简洁的 Markdown 多级标题大纲（# 主主题，## 一级分支，### 二级分支，- 叶子要点），直接输出 Markdown。"
        val md = stripMarkdownFence(callChatCompletion(cfg, sys, combined.take(6000)))
        if (md.isNotBlank()) {
          val title = md.lines().firstOrNull { it.trim().startsWith("# ") }?.removePrefix("# ")?.trim() ?: defaultTitle
          return JSONObject()
            .put("markdown", md)
            .put("title", title)
            .put("offline_mode", false)
            .put("provider_label", "AI 直连 (${cfg.model})")
        }
      } catch (_: Exception) {
      }
    }

    // Offline outline builder
    val lines = combined.lines().map { it.trim() }.filter { it.isNotEmpty() }
    val hasHeadings = lines.any { it.startsWith("#") }
    val outline = if (hasHeadings) {
      lines.take(80).joinToString("\n")
    } else {
      buildString {
        append("# ").append(defaultTitle).append("\n\n")
        val chunks = lines.take(18)
        if (chunks.isEmpty()) {
          append("## 核心要点\n- 暂无内容\n")
        } else {
          append("## 核心要点\n")
          chunks.forEach { append("- ").append(it.trimStart('-', '*', ' ')).append("\n") }
        }
      }
    }
    return JSONObject()
      .put("markdown", outline)
      .put("title", defaultTitle)
      .put("offline_mode", true)
      .put("provider_label", "手机离线大纲提炼")
  }

  // ---------------------------------------------------------------------------
  // 4. Streaming Chat (SSE)
  // ---------------------------------------------------------------------------

  fun streamChat(
    messages: JSONArray,
    webSearch: Boolean,
    contextPaths: List<String>,
    emitEvent: (JSONObject) -> Unit,
  ) {
    val contextSnippets = mutableListOf<Pair<String, String>>()
    for (p in contextPaths.take(8)) {
      val content = extractFileText(p, 2500)
      if (content.isNotBlank()) {
        contextSnippets.add(p.substringAfterLast('/') to content)
      }
    }
    val contextNames = JSONArray()
    contextSnippets.forEach { contextNames.put(it.first) }

    val cfg = readAiConfig()
    if (cfg.isConfigured) {
      try {
        val sysPrompt = buildString {
          append("你是 SmartLocalNote 手机本地工作台 AI 助手。请用简洁清晰的中文回答用户问题。")
          if (contextSnippets.isNotEmpty()) {
            append("\n\n以下是用户附加的本地笔记参考：\n")
            for ((name, body) in contextSnippets) {
              append("\n--- [文件：$name] ---\n").append(body).append("\n")
            }
          }
        }
        val apiMsgs = JSONArray().put(JSONObject().put("role", "system").put("content", sysPrompt))
        for (i in 0 until messages.length()) {
          val m = messages.optJSONObject(i) ?: continue
          val role = m.optString("role", "user")
          val content = m.optString("content", "")
          if (content.isNotBlank()) {
            apiMsgs.put(JSONObject().put("role", role).put("content", content))
          }
        }

        val reply = callChatMessages(cfg, apiMsgs)
        if (reply.isNotBlank()) {
          val step = 18
          var idx = 0
          while (idx < reply.length) {
            val end = minOf(idx + step, reply.length)
            emitEvent(JSONObject().put("type", "delta").put("content", reply.substring(idx, end)))
            idx = end
          }
          emitEvent(
            JSONObject()
              .put("type", "done")
              .put(
                "meta",
                JSONObject()
                  .put("web_search", webSearch)
                  .put("context_files", contextNames)
                  .put("offline_mode", false)
                  .put("provider_label", "AI 直连 (${cfg.model})"),
              ),
          )
          return
        }
      } catch (_: Exception) {
        // Fallback to offline
      }
    }

    // Offline rule-based chat reply
    var lastUser = ""
    for (i in messages.length() - 1 downTo 0) {
      val m = messages.optJSONObject(i) ?: continue
      if (m.optString("role") == "user") {
        lastUser = m.optString("content", "").trim()
        break
      }
    }

    val offlineReply = buildString {
      append("📱 **手机离线模式助手**\n\n")
      if (contextSnippets.isNotEmpty()) {
        append("已读取 **${contextSnippets.size}** 份本地笔记参考：\n")
        for ((name, body) in contextSnippets) {
          val firstLine = body.lines().firstOrNull { it.trim().isNotEmpty() }?.trim()?.take(100) ?: "暂无摘要"
          append("- **$name**：$firstLine\n")
        }
        append("\n")
      }
      if (lastUser.isNotBlank()) {
        append("针对你的问题「${lastUser.take(60)}」：\n")
        append("1. 当前尚未配置云端大模型 API Key，已自动启用本地离线规则模式。\n")
        append("2. 你可以在右上角「设置 → AI 配置」中填入任意 OpenAI 兼容接口（如 DeepSeek / 硅基流动 / OpenAI）的 `base_url`、`api_key` 与 `model`，即可在手机端直接流式对话！\n")
      } else {
        append("请输入你想探讨的内容，或在设置中配置 API Key 开启云端大模型对话。")
      }
    }

    val step = 18
    var idx = 0
    while (idx < offlineReply.length) {
      val end = minOf(idx + step, offlineReply.length)
      emitEvent(JSONObject().put("type", "delta").put("content", offlineReply.substring(idx, end)))
      idx = end
    }
    emitEvent(
      JSONObject()
        .put("type", "done")
        .put(
          "meta",
          JSONObject()
            .put("web_search", webSearch)
            .put("context_files", contextNames)
            .put("offline_mode", true)
            .put("provider_label", "手机离线规则模式"),
        ),
    )
  }

  // ---------------------------------------------------------------------------
  // OpenAI-Compatible HTTP Client (Zero third-party deps)
  // ---------------------------------------------------------------------------

  private fun callChatCompletion(cfg: AiConfig, systemPrompt: String, userPrompt: String): String {
    val msgs = JSONArray()
      .put(JSONObject().put("role", "system").put("content", systemPrompt))
      .put(JSONObject().put("role", "user").put("content", userPrompt))
    return callChatMessages(cfg, msgs)
  }

  private fun callChatMessages(cfg: AiConfig, messages: JSONArray): String {
    val url = URL(buildChatUrl(cfg.baseUrl))
    val conn = (url.openConnection() as HttpURLConnection).apply {
      requestMethod = "POST"
      connectTimeout = 10_000
      readTimeout = 45_000
      doOutput = true
      setRequestProperty("Content-Type", "application/json; charset=utf-8")
      setRequestProperty("Authorization", "Bearer ${cfg.apiKey}")
    }
    try {
      val payload = JSONObject().apply {
        put("model", cfg.model)
        put("messages", messages)
        put("stream", false)
      }
      val bytes = payload.toString().toByteArray(Charsets.UTF_8)
      conn.setFixedLengthStreamingMode(bytes.size)
      conn.outputStream.use { os ->
        os.write(bytes)
        os.flush()
      }
      val code = conn.responseCode
      val stream = if (code in 200..299) conn.inputStream else conn.errorStream
      val body = if (stream != null) {
        BufferedReader(InputStreamReader(stream, Charsets.UTF_8)).use { it.readText() }
      } else {
        ""
      }
      if (code !in 200..299) {
        throw IllegalStateException("AI HTTP $code: $body")
      }
      val root = JSONObject(body)
      return root.optJSONArray("choices")
        ?.optJSONObject(0)
        ?.optJSONObject("message")
        ?.optString("content", "")
        ?.trim()
        .orEmpty()
    } finally {
      conn.disconnect()
    }
  }

  private fun stripMarkdownFence(raw: String): String {
    val t = raw.trim()
    if (!t.startsWith("```")) return t
    val lines = t.lines()
    if (lines.size <= 2) return t
    val droppedFirst = lines.drop(1)
    val droppedLast = if (droppedFirst.lastOrNull()?.trim() == "```") droppedFirst.dropLast(1) else droppedFirst
    return droppedLast.joinToString("\n").trim()
  }

  private fun extractJsonObjectString(raw: String): String {
    val cleaned = stripMarkdownFence(raw)
    val start = cleaned.indexOf('{')
    val end = cleaned.lastIndexOf('}')
    return if (start >= 0 && end > start) cleaned.substring(start, end + 1) else cleaned
  }
}
