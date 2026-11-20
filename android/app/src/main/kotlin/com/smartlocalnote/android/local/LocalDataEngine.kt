package com.smartlocalnote.android.local

import android.content.Context
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID

data class LocalSyncEntry(
  val relPath: String,
  val path: String,
  val name: String,
  val mtimeSec: Double,
  val size: Long,
  val sha256: String,
)

class LocalDataEngine(context: Context) {
  private val appContext = context.applicationContext
  val dataRoot: File = File(appContext.filesDir, "SmartLocalNote/data")
  val notesDir: File = File(dataRoot, "notes")
  val trashDir: File = File(dataRoot, "trash")
  val trashFilesDir: File = File(trashDir, "files")
  val snapshotsDir: File = File(dataRoot, "snapshots")

  private val configFile: File = File(dataRoot, "config.json")
  private val remindersFile: File = File(dataRoot, "reminders.json")
  private val trashManifestFile: File = File(trashDir, "manifest.json")
  private val trashSettingsFile: File = File(trashDir, "settings.json")

  private val lock = Any()

  init {
    ensureDirectoriesAndSeed()
  }

  private fun ensureDirectoriesAndSeed() = synchronized(lock) {
    dataRoot.mkdirs()
    notesDir.mkdirs()
    trashDir.mkdirs()
    trashFilesDir.mkdirs()
    snapshotsDir.mkdirs()

    if (!configFile.exists()) {
      atomicWriteText(configFile, defaultConfigJson().toString(2), snapshot = false)
    }
    if (!remindersFile.exists()) {
      atomicWriteText(remindersFile, JSONObject().put("items", JSONArray()).toString(2), snapshot = false)
    }
    if (!trashSettingsFile.exists()) {
      val s = JSONObject().put("mode", "app").put("auto_purge_days", 15)
      atomicWriteText(trashSettingsFile, s.toString(2), snapshot = false)
    }
    if (!trashManifestFile.exists()) {
      atomicWriteText(trashManifestFile, JSONObject().put("items", JSONArray()).toString(2), snapshot = false)
    }

    // Seed welcome note on first launch if notes/ is empty
    val existing = notesDir.listFiles()?.filter { !it.name.startsWith(".") }.orEmpty()
    if (existing.isEmpty()) {
      val welcomeFile = File(notesDir, "欢迎使用_SmartLocalNote手机版.md")
      atomicWriteText(welcomeFile, WELCOME_NOTE_CONTENT, snapshot = false)
    }
  }

  private fun defaultConfigJson(): JSONObject = JSONObject().apply {
    put("port", 8765)
    put("theme", "light")
    put("doc_font_size", 16)
    put("doc_font_family", "system")
    put("auto_save_on_switch", true)
    put("default_notes_dir", notesDir.canonicalPath)
    put("default_progress_excel", "")
    put("whitelist_dirs", JSONArray().put(notesDir.canonicalPath))
    put("private_files", JSONArray())
    put("ui_layout", JSONObject())
    put(
      "ai",
      JSONObject().apply {
        put("base_url", "")
        put("api_key", "")
        put("model", "gpt-4o-mini")
        put("enable_free_ai", false)
      },
    )
  }

  // ---------------------------------------------------------------------------
  // Safe Path & Atomic IO
  // ---------------------------------------------------------------------------

  fun resolveSafePath(rawPath: String, mustExist: Boolean = false): File {
    val clean = rawPath.trim()
    if (clean.isEmpty() || clean.contains('\u0000')) {
      throw IllegalArgumentException("文件路径不能为空")
    }
    val rootCanon = dataRoot.canonicalFile
    val notesCanon = notesDir.canonicalFile

    val candidate = if (clean.startsWith("/")) {
      File(clean).canonicalFile
    } else {
      File(notesCanon, clean.replace("\\", "/")).canonicalFile
    }

    val rootPrefix = rootCanon.path + File.separator
    if (candidate.path != rootCanon.path && !candidate.path.startsWith(rootPrefix)) {
      throw SecurityException("安全拦截：路径超出本地笔记库范围")
    }
    if (mustExist && !candidate.exists()) {
      throw IllegalArgumentException("文件不存在：${candidate.name}")
    }
    return candidate
  }

  fun atomicWriteBytes(target: File, bytes: ByteArray) = synchronized(lock) {
    target.parentFile?.mkdirs()
    val tmp = File(target.parentFile, ".${target.name}.${System.nanoTime()}.tmp")
    FileOutputStream(tmp).use { fos ->
      fos.write(bytes)
      fos.fd.sync()
    }
    if (target.exists() && !target.delete()) {
      // Fallback overwrite if delete fails
      FileOutputStream(target).use { it.write(bytes) }
      tmp.delete()
    } else if (!tmp.renameTo(target)) {
      tmp.copyTo(target, overwrite = true)
      tmp.delete()
    }
  }

  fun atomicWriteText(target: File, content: String, snapshot: Boolean = false): String? = synchronized(lock) {
    var snapId: String? = null
    if (snapshot && target.exists() && target.isFile) {
      snapId = createSnapshot(target)
    }
    atomicWriteBytes(target, content.toByteArray(Charsets.UTF_8))
    snapId
  }

  private fun createSnapshot(target: File): String? {
    return try {
      val hashKey = sha256Hex(target.canonicalPath.toByteArray(Charsets.UTF_8)).take(12)
      val snapFolder = File(snapshotsDir, hashKey).apply { mkdirs() }
      val stamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())
      val snapId = "${stamp}_${UUID.randomUUID().toString().take(4)}"
      val snapFile = File(snapFolder, "$snapId${target.extension.let { if (it.isNotEmpty()) ".$it" else "" }}")
      target.copyTo(snapFile, overwrite = true)

      // Prune old snapshots (keep latest 10)
      val all = snapFolder.listFiles()?.sortedByDescending { it.lastModified() }.orEmpty()
      if (all.size > 10) {
        all.drop(10).forEach { it.delete() }
      }
      snapId
    } catch (_: Exception) {
      null
    }
  }

  fun listSnapshots(rawPath: String): JSONArray = synchronized(lock) {
    val arr = JSONArray()
    try {
      val target = resolveSafePath(rawPath, mustExist = false)
      val hashKey = sha256Hex(target.canonicalPath.toByteArray(Charsets.UTF_8)).take(12)
      val snapFolder = File(snapshotsDir, hashKey)
      if (!snapFolder.exists() || !snapFolder.isDirectory) return@synchronized arr
      val files = snapFolder.listFiles()?.sortedByDescending { it.lastModified() }.orEmpty()
      val fmt = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.getDefault())
      for (f in files) {
        arr.put(
          JSONObject().apply {
            put("id", f.nameWithoutExtension)
            put("name", f.name)
            put("size", f.length())
            put("mtime", f.lastModified() / 1000.0)
            put("created_at", fmt.format(Date(f.lastModified())))
          },
        )
      }
    } catch (_: Exception) {
    }
    arr
  }

  fun restoreSnapshot(rawPath: String, snapshotId: String): JSONObject = synchronized(lock) {
    val target = resolveSafePath(rawPath, mustExist = false)
    val hashKey = sha256Hex(target.canonicalPath.toByteArray(Charsets.UTF_8)).take(12)
    val snapFolder = File(snapshotsDir, hashKey)
    val match = snapFolder.listFiles()?.firstOrNull {
      it.nameWithoutExtension == snapshotId || it.name == snapshotId
    } ?: throw IllegalArgumentException("快照不存在：$snapshotId")

    val content = match.readText(Charsets.UTF_8)
    atomicWriteText(target, content, snapshot = true)
    JSONObject().apply {
      put("ok", true)
      put("path", target.canonicalPath)
      put("content", content)
      put("snapshot_id", snapshotId)
    }
  }

  // ---------------------------------------------------------------------------
  // Files & Folders
  // ---------------------------------------------------------------------------

  fun listFiles(): JSONObject = synchronized(lock) {
    val cfg = getConfig()
    val privArr = cfg.optJSONArray("private_files") ?: JSONArray()
    val privateSet = HashSet<String>()
    for (i in 0 until privArr.length()) {
      privArr.optString(i).takeIf { it.isNotBlank() }?.let { privateSet.add(it) }
    }

    val itemsList = mutableListOf<JSONObject>()
    val foldersList = mutableListOf<JSONObject>()
    val notesCanon = notesDir.canonicalFile

    fun walk(dir: File, depth: Int) {
      if (depth > 4) return
      val children = dir.listFiles()?.sortedBy { it.name.lowercase(Locale.getDefault()) } ?: return
      for (child in children) {
        if (child.name.startsWith(".")) continue
        if (child.isDirectory) {
          val relDir = relativePosix(notesCanon, child.canonicalFile)
          val parentRel = if (dir.canonicalPath == notesCanon.path) "" else relativePosix(notesCanon, dir.canonicalFile)
          foldersList.add(
            JSONObject().apply {
              put("name", child.name)
              put("rel_dir", relDir)
              put("path", child.canonicalPath)
              put("parent_rel", parentRel)
            },
          )
          walk(child, depth + 1)
        } else if (child.isFile) {
          val canon = child.canonicalFile
          val ext = getDotExt(canon.name)
          val parentRel = if (canon.parentFile?.canonicalPath == notesCanon.path) {
            ""
          } else {
            relativePosix(notesCanon, canon.parentFile!!.canonicalFile)
          }
          itemsList.add(
            JSONObject().apply {
              put("path", canon.path)
              put("name", canon.name)
              put("ext", ext)
              put("size", canon.length())
              put("mtime", canon.lastModified() / 1000.0)
              put("is_private", privateSet.contains(canon.path))
              put("source", "notes")
              put("group", "默认笔记")
              put("rel_dir", parentRel)
            },
          )
        }
      }
    }

    walk(notesCanon, 0)

    val itemsArr = JSONArray()
    itemsList.sortedBy { it.optString("name").lowercase(Locale.getDefault()) }.forEach { itemsArr.put(it) }
    val foldersArr = JSONArray()
    foldersList.sortedBy { it.optString("rel_dir").lowercase(Locale.getDefault()) }.forEach { foldersArr.put(it) }
    val privOut = JSONArray()
    privateSet.forEach { privOut.put(it) }

    JSONObject().apply {
      put("items", itemsArr)
      put("dirs", JSONArray())
      put("folders", foldersArr)
      put("private_files", privOut)
    }
  }

  fun readFile(rawPath: String): JSONObject = synchronized(lock) {
    val target = resolveSafePath(rawPath, mustExist = true)
    val ext = getDotExt(target.name)
    val isPrivate = isFilePrivate(target.canonicalPath)
    val snapshots = listSnapshots(target.canonicalPath)

    if (ext in TEXT_EXTS) {
      val content = readTextSafe(target)
      return@synchronized JSONObject().apply {
        put("type", if (ext == ".md") "markdown" else "text")
        put("path", target.canonicalPath)
        put("name", target.name)
        put("ext", ext)
        put("size", target.length())
        put("content", content)
        put("is_private", isPrivate)
        put("snapshots", snapshots)
      }
    }

    val companion = loadCompanionNote(target)
    if (ext == ".pdf") {
      return@synchronized JSONObject().apply {
        put("type", "pdf")
        put("path", target.canonicalPath)
        put("name", target.name)
        put("ext", ".pdf")
        put("size", target.length())
        put("page_count", 1)
        put("companion_path", companion.first.canonicalPath)
        put("companion_content", companion.second)
        put("companion_exists", companion.third)
        put("is_private", isPrivate)
        put("snapshots", snapshots)
      }
    }

    val mediaType = when {
      ext in IMAGE_EXTS -> "image"
      ext in AUDIO_EXTS -> "audio"
      ext in VIDEO_EXTS -> "video"
      else -> "text"
    }

    if (mediaType != "text") {
      return@synchronized JSONObject().apply {
        put("type", mediaType)
        put("path", target.canonicalPath)
        put("name", target.name)
        put("ext", ext)
        put("size", target.length())
        put("mime", guessMimeType(target))
        put("companion_path", companion.first.canonicalPath)
        put("companion_content", companion.second)
        put("is_private", isPrivate)
      }
    }

    // Fallback: try reading as text if small
    val fallbackText = if (target.length() <= 512 * 1024) readTextSafe(target) else "（二进制文件，暂不支持文本预览）"
    JSONObject().apply {
      put("type", "text")
      put("path", target.canonicalPath)
      put("name", target.name)
      put("ext", ext)
      put("size", target.length())
      put("content", fallbackText)
      put("is_private", isPrivate)
      put("snapshots", snapshots)
    }
  }

  fun writeFile(rawPath: String, content: String): JSONObject = synchronized(lock) {
    val target = resolveSafePath(rawPath, mustExist = false)
    val snapId = atomicWriteText(target, content, snapshot = true)
    JSONObject().apply {
      put("ok", true)
      put("path", target.canonicalPath)
      put("name", target.name)
      put("size", target.length())
      put("snapshot_id", snapId ?: JSONObject.NULL)
    }
  }

  fun createNote(
    title: String = "",
    content: String = "",
    folderRel: String = "",
    nodeId: String? = null,
  ): JSONObject = synchronized(lock) {
    val (targetDir, normRel) = resolveNotesSubdir(folderRel)
    val rawTitle = title.trim()
    val stem = if (rawTitle.isEmpty()) {
      val existingStems = targetDir.listFiles()
        ?.filter { it.isFile && it.extension.equals("md", ignoreCase = true) }
        ?.map { it.nameWithoutExtension }
        .orEmpty()
      nextSequentialName("新建笔记", existingStems)
    } else {
      sanitizeFilename(rawTitle).removeSuffix(".md").ifBlank { "未命名笔记" }
    }

    var candidate = File(targetDir, "$stem.md")
    var counter = 2
    while (candidate.exists()) {
      candidate = File(targetDir, "${stem}_$counter.md")
      counter++
    }

    val body = if (content.isNotEmpty()) content else "# $stem\n\n"
    atomicWriteText(candidate, body, snapshot = false)

    JSONObject().apply {
      put("path", candidate.canonicalPath)
      put("name", candidate.name)
      put("ext", ".md")
      put("rel_dir", normRel)
      put("node_id", nodeId ?: JSONObject.NULL)
    }
  }

  fun createFolder(parentDir: String = "", name: String = ""): JSONObject = synchronized(lock) {
    val baseDir = if (parentDir.isBlank()) {
      notesDir.canonicalFile
    } else if (parentDir.startsWith("/")) {
      resolveSafePath(parentDir, mustExist = false)
    } else {
      resolveNotesSubdir(parentDir).first
    }
    baseDir.mkdirs()

    val rawName = name.trim()
    val folderName = if (rawName.isEmpty()) {
      val existingDirs = baseDir.listFiles()?.filter { it.isDirectory }?.map { it.name }.orEmpty()
      nextSequentialName("新建文件夹", existingDirs)
    } else {
      if (rawName.contains("/") || rawName.contains("\\") || rawName.contains("..")) {
        throw IllegalArgumentException("文件夹名称包含非法路径字符")
      }
      sanitizeFilename(rawName).ifBlank { "新建文件夹" }
    }

    val target = File(baseDir, folderName).canonicalFile
    if (target.exists() && target.isFile) {
      throw IllegalArgumentException("同名文件已存在：${target.name}")
    }
    target.mkdirs()

    val relDir = relativePosix(notesDir.canonicalFile, target)
    JSONObject().apply {
      put("ok", true)
      put("path", target.canonicalPath)
      put("rel_dir", relDir)
      put("name", target.name)
    }
  }

  fun renameFile(oldPath: String, newName: String): JSONObject = synchronized(lock) {
    val src = resolveSafePath(oldPath, mustExist = true)
    val cleanName = sanitizeFilename(newName.trim())
    if (cleanName.isBlank()) throw IllegalArgumentException("新名称不能为空")

    val finalName = if (src.isFile && src.extension.isNotEmpty() && !cleanName.contains(".")) {
      "$cleanName.${src.extension}"
    } else {
      cleanName
    }
    val dest = File(src.parentFile, finalName).canonicalFile
    resolveSafePath(dest.path, mustExist = false)
    if (dest.exists() && dest.canonicalPath != src.canonicalPath) {
      throw IllegalArgumentException("目标名称已存在：$finalName")
    }
    if (!src.renameTo(dest)) {
      throw IllegalStateException("重命名失败")
    }
    JSONObject().apply {
      put("ok", true)
      put("old_path", src.canonicalPath)
      put("new_path", dest.canonicalPath)
      put("path", dest.canonicalPath)
      put("name", dest.name)
    }
  }

  fun moveFiles(paths: List<String>, targetFolderRel: String): JSONObject = synchronized(lock) {
    val (destDir, normRel) = resolveNotesSubdir(targetFolderRel)
    val movedArr = JSONArray()
    for (p in paths) {
      val src = resolveSafePath(p, mustExist = true)
      var dest = File(destDir, src.name).canonicalFile
      if (dest.canonicalPath == src.canonicalPath) continue
      if (dest.exists()) {
        val stem = dest.nameWithoutExtension
        val ext = if (dest.extension.isNotEmpty()) ".${dest.extension}" else ""
        var c = 2
        while (dest.exists()) {
          dest = File(destDir, "${stem}_$c$ext").canonicalFile
          c++
        }
      }
      if (src.renameTo(dest)) {
        movedArr.put(
          JSONObject().apply {
            put("old_path", src.canonicalPath)
            put("new_path", dest.canonicalPath)
            put("name", dest.name)
          },
        )
      }
    }
    JSONObject().apply {
      put("ok", true)
      put("moved", movedArr)
      put("target_folder_rel", normRel)
    }
  }

  fun trashFile(rawPath: String, mode: String = "app"): JSONObject = synchronized(lock) {
    val target = resolveSafePath(rawPath, mustExist = true)
    if (target.canonicalPath == notesDir.canonicalPath) {
      throw IllegalArgumentException("不能删除默认笔记根目录")
    }
    trashFilesDir.mkdirs()
    val trashId = "tr_${UUID.randomUUID().toString().replace("-", "").take(10)}"
    val kind = if (target.isDirectory) "folder" else "file"
    val ext = if (kind == "folder") "" else getDotExt(target.name)
    val sizeBytes = computeSize(target)
    val stored = File(trashFilesDir, "${trashId}__${target.name}").canonicalFile

    moveRecursive(target, stored)

    val item = JSONObject().apply {
      put("id", trashId)
      put("kind", kind)
      put("title", target.name)
      put("orig_path", target.canonicalPath)
      put("stored_path", stored.canonicalPath)
      put("size_bytes", sizeBytes)
      put("deleted_at", nowIso())
      put("ext", ext)
    }
    val manifest = loadTrashManifest()
    manifest.put(item)
    saveTrashManifest(manifest)

    JSONObject().apply {
      put("ok", true)
      put("mode", "app")
      put("recycled_to_system", false)
      put("trash_item", item)
      put("message", "已移入内置回收站")
    }
  }

  fun uploadBase64(
    filename: String,
    contentBase64: String,
    targetDir: String = "手机收集",
    addToShelf: Boolean = false,
    noteAppend: Boolean = false,
  ): JSONObject {
    var rawB64 = contentBase64.trim()
    if (rawB64.startsWith("data:") && rawB64.contains(",")) {
      rawB64 = rawB64.substringAfter(",").trim()
    }
    val bytes = Base64.decode(rawB64, Base64.DEFAULT)
    return saveRawBytes(filename, bytes, targetDir, addToShelf, noteAppend)
  }

  fun saveRawBytes(
    filename: String,
    bytes: ByteArray,
    targetDir: String = "手机收集",
    addToShelf: Boolean = false,
    noteAppend: Boolean = false,
  ): JSONObject = synchronized(lock) {
    val (destDir, normRel) = resolveNotesSubdir(targetDir)
    val safeName = sanitizeFilename(filename).ifBlank { "file_${System.currentTimeMillis()}.bin" }
    var dest = File(destDir, safeName)
    if (dest.exists()) {
      val stem = dest.nameWithoutExtension
      val ext = if (dest.extension.isNotEmpty()) ".${dest.extension}" else ""
      var c = 2
      while (dest.exists()) {
        dest = File(destDir, "${stem}_$c$ext")
        c++
      }
    }
    atomicWriteBytes(dest, bytes)
    JSONObject().apply {
      put("ok", true)
      put("path", dest.canonicalPath)
      put("name", dest.name)
      put("rel_dir", normRel)
      put("size", bytes.size)
      put("add_to_shelf", addToShelf)
      put("note_append", noteAppend)
    }
  }

  fun savePdfAnnotate(rawPath: String, page: Int, noteText: String, color: String = "yellow"): JSONObject =
    synchronized(lock) {
      val target = resolveSafePath(rawPath, mustExist = true)
      val (companionFile, existing, _) = loadCompanionNote(target)
      val stamp = SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.getDefault()).format(Date())
      val entry = "\n- [第 $page 页 | $stamp] ${noteText.trim()} [[${target.name}#page=$page]]\n"
      val updated = if (existing.isBlank()) {
        "# ${target.nameWithoutExtension} 伴生笔记\n$entry"
      } else {
        existing.trimEnd() + "\n" + entry
      }
      atomicWriteText(companionFile, updated, snapshot = false)
      JSONObject().apply {
        put("ok", true)
        put("companion_path", companionFile.canonicalPath)
        put("companion_content", updated)
        put("page", page)
        put("color", color)
      }
    }

  fun expandContent(rawPath: String): JSONObject = synchronized(lock) {
    val target = resolveSafePath(rawPath, mustExist = true)
    val ext = getDotExt(target.name)
    val preview = if (ext in TEXT_EXTS) {
      readTextSafe(target).take(4000)
    } else {
      "文件：${target.name}（${target.length()} 字节）"
    }
    JSONObject().apply {
      put("path", target.canonicalPath)
      put("name", target.name)
      put("ext", ext)
      put("content", preview)
      put("text", preview)
    }
  }

  fun backlinks(rawPath: String): JSONObject = synchronized(lock) {
    val target = resolveSafePath(rawPath, mustExist = false)
    val targetKey = target.canonicalPath
    val targetName = target.name
    val targetStem = target.nameWithoutExtension
    val pattern = Regex(
      "\\[\\[(?:${Regex.escape(targetName)}|${Regex.escape(targetStem)})(?:[#!|\\]])",
      RegexOption.IGNORE_CASE,
    )

    val list = JSONArray()
    val files = listFiles().optJSONArray("items") ?: JSONArray()
    for (i in 0 until files.length()) {
      val item = files.optJSONObject(i) ?: continue
      val fpath = item.optString("path")
      val ext = item.optString("ext").lowercase(Locale.US)
      if (fpath == targetKey || (ext != ".md" && ext != ".txt")) continue
      val f = File(fpath)
      if (!f.exists()) continue
      val lines = readTextSafe(f).lines()
      for ((idx, line) in lines.withIndex()) {
        if (pattern.containsMatchIn(line)) {
          val clean = line.replace(Regex("\\s+"), " ").trim()
          list.put(
            JSONObject().apply {
              put("path", f.canonicalPath)
              put("name", f.name)
              put("ext", ext)
              put("snippet", if (clean.length > 160) clean.take(160) + "..." else clean)
              put("line", idx + 1)
            },
          )
          break
        }
      }
    }
    JSONObject().apply {
      put("target", targetName)
      put("count", list.length())
      put("backlinks", list)
    }
  }

  // ---------------------------------------------------------------------------
  // Global Todos (100% compatible with core/todo_indexer.py)
  // ---------------------------------------------------------------------------

  fun scanAllTodos(): JSONObject = synchronized(lock) {
    val ws = listFiles()
    val files = ws.optJSONArray("items") ?: JSONArray()
    val itemsArr = JSONArray()
    val byFileObj = JSONObject()
    var totalAll = 0
    var doneAll = 0

    for (i in 0 until files.length()) {
      val fInfo = files.optJSONObject(i) ?: continue
      if (fInfo.optString("ext").lowercase(Locale.US) != ".md") continue
      val fpath = fInfo.optString("path")
      val file = File(fpath)
      if (!file.exists()) continue

      val content = readTextSafe(file)
      val parsed = parseMarkdownTodos(content)
      if (parsed.isEmpty()) continue

      val fileName = fInfo.optString("name", file.name)
      val relDir = fInfo.optString("rel_dir", "")
      var fileDone = 0
      for (row in parsed) {
        if (row.checked) fileDone++
        itemsArr.put(
          JSONObject().apply {
            put("id", makeTodoId(fpath, row.lineNo, row.text))
            put("file_path", fpath)
            put("file_name", fileName)
            put("rel_dir", relDir)
            put("line_no", row.lineNo)
            put("text", row.text)
            put("checked", row.checked)
            put("heading", row.heading)
          },
        )
      }
      val fileTotal = parsed.size
      byFileObj.put(
        fpath,
        JSONObject().apply {
          put("total", fileTotal)
          put("done", fileDone)
          put("open", fileTotal - fileDone)
        },
      )
      totalAll += fileTotal
      doneAll += fileDone
    }

    JSONObject().apply {
      put("items", itemsArr)
      put("by_file", byFileObj)
      put(
        "stats",
        JSONObject().apply {
          put("total", totalAll)
          put("done", doneAll)
          put("open", totalAll - doneAll)
        },
      )
    }
  }

  fun toggleTodo(filePath: String, lineNo: Int, checked: Boolean, expectedText: String = ""): JSONObject =
    synchronized(lock) {
      val target = resolveSafePath(filePath, mustExist = true)
      val content = readTextSafe(target)
      val lines = splitLinesKeepEnds(content).toMutableList()
      val cleanExpected = expectedText.trim()
      val targetIdx = lineNo - 1

      var matchedIdx = -1
      var matchedGroups: MatchResult? = null

      if (targetIdx in lines.indices) {
        val body = lines[targetIdx].trimEnd('\r', '\n')
        val m = TODO_LINE_REGEX.matchEntire(body)
        if (m != null && (cleanExpected.isEmpty() || m.groupValues[4].trim() == cleanExpected)) {
          matchedIdx = targetIdx
          matchedGroups = m
        }
      }

      if (matchedIdx < 0 && cleanExpected.isNotEmpty()) {
        var bestDist = Int.MAX_VALUE
        for (i in lines.indices) {
          val m = TODO_LINE_REGEX.matchEntire(lines[i].trimEnd('\r', '\n'))
          if (m != null && m.groupValues[4].trim() == cleanExpected) {
            val d = kotlin.math.abs(i - targetIdx)
            if (d < bestDist) {
              bestDist = d
              matchedIdx = i
              matchedGroups = m
            }
          }
        }
      }

      if (matchedIdx < 0 || matchedGroups == null) {
        throw IllegalArgumentException("未在 ${target.name} 第 $lineNo 行找到匹配的待办事项")
      }

      val raw = lines[matchedIdx]
      val body = raw.trimEnd('\r', '\n')
      val ending = raw.substring(body.length)
      val mark = if (checked) "x" else " "
      lines[matchedIdx] = "${matchedGroups.groupValues[1]}$mark${matchedGroups.groupValues[3]}${matchedGroups.groupValues[4]}$ending"
      val newText = lines.joinToString("")
      atomicWriteText(target, newText, snapshot = false)

      JSONObject().apply {
        put("ok", true)
        put("file_path", target.canonicalPath)
        put("line_no", matchedIdx + 1)
        put("checked", checked)
        put("content", newText)
      }
    }

  fun addTodo(filePath: String, text: String): JSONObject = synchronized(lock) {
    val target = resolveSafePath(filePath, mustExist = true)
    val content = readTextSafe(target)
    val finalText = text.trim().ifEmpty {
      val existing = parseMarkdownTodos(content).map { it.text }
      nextSequentialName("新建待办", existing)
    }
    val todoLine = "- [ ] $finalText"
    val newText = when {
      content.isEmpty() -> "$todoLine\n"
      content.endsWith("\n") -> "$content$todoLine\n"
      else -> "$content\n$todoLine\n"
    }
    atomicWriteText(target, newText, snapshot = false)
    val newLineNo = newText.lines().dropLastWhile { it.isEmpty() }.size

    JSONObject().apply {
      put("ok", true)
      put("file_path", target.canonicalPath)
      put("line_no", newLineNo)
      put("text", finalText)
      put("content", newText)
    }
  }

  // ---------------------------------------------------------------------------
  // K1 Bidirectional Link & #Tag Knowledge Graph
  // ---------------------------------------------------------------------------

  fun buildLinkGraph(activePath: String = ""): JSONObject = synchronized(lock) {
    val ws = listFiles()
    val itemsArr = ws.optJSONArray("items") ?: JSONArray()

    data class FileMeta(val path: String, val name: String, val ext: String, val relDir: String)

    val byPath = LinkedHashMap<String, FileMeta>()
    val byName = HashMap<String, FileMeta>()
    val byStem = HashMap<String, FileMeta>()
    val byRel = HashMap<String, FileMeta>()

    for (i in 0 until itemsArr.length()) {
      val o = itemsArr.optJSONObject(i) ?: continue
      val meta = FileMeta(
        path = o.optString("path"),
        name = o.optString("name"),
        ext = o.optString("ext").lowercase(Locale.US),
        relDir = o.optString("rel_dir"),
      )
      if (meta.path.isBlank() || meta.name.isBlank()) continue
      byPath[meta.path] = meta
      val nameLow = meta.name.lowercase(Locale.US)
      val stemLow = File(meta.name).nameWithoutExtension.lowercase(Locale.US)
      byName.putIfAbsent(nameLow, meta)
      if (stemLow.isNotEmpty()) byStem.putIfAbsent(stemLow, meta)
      if (meta.relDir.isNotEmpty()) {
        byRel.putIfAbsent("${meta.relDir}/$nameLow".lowercase(Locale.US), meta)
        if (stemLow.isNotEmpty()) byRel.putIfAbsent("${meta.relDir}/$stemLow".lowercase(Locale.US), meta)
      }
    }

    fun resolveWiki(rawTarget: String): FileMeta? {
      var cleaned = rawTarget.trim().replace("\\", "/").trimStart('/')
      while (cleaned.startsWith("./")) cleaned = cleaned.removePrefix("./").trimStart('/')
      if (cleaned.isEmpty()) return null
      val low = cleaned.lowercase(Locale.US)
      if ("/" in low && byRel.containsKey(low)) return byRel[low]
      val base = cleaned.substringAfterLast('/').lowercase(Locale.US)
      byName[base]?.let { return it }
      byStem[base]?.let { return it }
      if (base.endsWith(".md")) byStem[base.removeSuffix(".md")]?.let { return it }
      return null
    }

    val mdNotes = LinkedHashMap<String, FileMeta>()
    val noteOutlinks = HashMap<String, MutableList<JSONObject>>()
    val backlinksMap = HashMap<String, MutableList<JSONObject>>()
    val backlinksSeen = HashMap<String, MutableSet<String>>()
    val noteTags = HashMap<String, MutableList<String>>()
    val tagFilesMap = LinkedHashMap<String, MutableList<FileMeta>>()

    for ((fpath, meta) in byPath) {
      if (meta.ext != ".md") continue
      val file = File(fpath)
      if (!file.exists()) continue
      val text = readTextSafe(file)
      mdNotes[fpath] = meta

      val outList = mutableListOf<JSONObject>()
      val seenTargets = HashSet<String>()
      val tagsList = mutableListOf<String>()
      val seenTags = HashSet<String>()

      var inFence = false
      for ((idx, rawLine) in text.lines().withIndex()) {
        val lineNo = idx + 1
        if (FENCE_REGEX.containsMatchIn(rawLine)) {
          inFence = !inFence
          continue
        }
        if (inFence) continue

        for (m in WIKILINK_REGEX.findAll(rawLine)) {
          val rawTarget = m.groupValues[1].trim()
          if (rawTarget.isEmpty() || NON_FILE_PREFIX_REGEX.containsMatchIn(rawTarget)) continue
          val resolved = resolveWiki(rawTarget)
          val targetPath: String
          val targetName: String
          val exists: Boolean
          val dedupKey: String
          if (resolved != null) {
            if (resolved.path == fpath) continue
            targetPath = resolved.path
            targetName = resolved.name
            exists = true
            dedupKey = targetPath
          } else {
            targetPath = ""
            targetName = rawTarget
            exists = false
            dedupKey = "missing:${rawTarget.lowercase(Locale.US)}"
          }
          if (seenTargets.add(dedupKey)) {
            val snip = rawLine.replace(Regex("\\s+"), " ").trim().let { if (it.length > 140) it.take(140) + "..." else it }
            outList.add(
              JSONObject().apply {
                put("target_path", targetPath)
                put("target_name", targetName)
                put("line_no", lineNo)
                put("snippet", snip)
                put("exists", exists)
              },
            )
            if (exists && targetPath.isNotEmpty()) {
              val seenSrc = backlinksSeen.getOrPut(targetPath) { HashSet() }
              if (seenSrc.add(fpath)) {
                backlinksMap.getOrPut(targetPath) { mutableListOf() }.add(
                  JSONObject().apply {
                    put("source_path", fpath)
                    put("source_name", meta.name)
                    put("line_no", lineNo)
                    put("snippet", snip)
                  },
                )
              }
            }
          }
        }

        if (HEADING_LINE_REGEX.containsMatchIn(rawLine)) continue
        val stripped = WIKILINK_REGEX.replace(INLINE_CODE_REGEX.replace(rawLine, " "), " ")
        for (tm in TAG_REGEX.findAll(stripped)) {
          val tag = tm.groupValues[1].trim()
          if (tag.isEmpty() || tag.all(Char::isDigit) || HEX_COLOR_REGEX.matches(tag)) continue
          if (seenTags.add(tag)) {
            tagsList.add(tag)
            tagFilesMap.getOrPut(tag) { mutableListOf() }.add(meta)
          }
        }
      }

      noteOutlinks[fpath] = outList
      noteTags[fpath] = tagsList
    }

    val tagsArr = JSONArray()
    val sortedTags = tagFilesMap.entries.sortedWith(compareByDescending<Map.Entry<String, MutableList<FileMeta>>> { it.value.size }.thenBy { it.key.lowercase(Locale.US) })
    for ((tag, files) in sortedTags) {
      val fArr = JSONArray()
      files.sortedBy { it.name.lowercase(Locale.US) }.forEach { fm ->
        fArr.put(
          JSONObject().apply {
            put("path", fm.path)
            put("name", fm.name)
            put("rel_dir", fm.relDir)
          },
        )
      }
      tagsArr.put(
        JSONObject().apply {
          put("tag", tag)
          put("count", files.size)
          put("files", fArr)
        },
      )
    }

    val resolvedActive = if (activePath.isNotBlank() && byPath.containsKey(activePath)) {
      activePath
    } else if (activePath.isNotBlank()) {
      try {
        val c = resolveSafePath(activePath, mustExist = false).canonicalPath
        if (byPath.containsKey(c)) c else mdNotes.keys.firstOrNull().orEmpty()
      } catch (_: Exception) {
        mdNotes.keys.firstOrNull().orEmpty()
      }
    } else {
      mdNotes.keys.firstOrNull().orEmpty()
    }

    val activeMeta = byPath[resolvedActive]
    val activeOut = noteOutlinks[resolvedActive].orEmpty()
    val activeBack = backlinksMap[resolvedActive].orEmpty()
    val activeTags = noteTags[resolvedActive].orEmpty()

    // Local graph nodes & edges
    val nodesArr = JSONArray()
    val nodeIds = HashSet<String>()
    fun addNode(id: String, label: String, kind: String, count: Int) {
      if (nodeIds.size >= 28 || !nodeIds.add(id)) return
      nodesArr.put(
        JSONObject().apply {
          put("id", id)
          put("label", label)
          put("kind", kind)
          put("count", count)
        },
      )
    }

    fun degree(p: String): Int =
      (backlinksMap[p]?.size ?: 0) + (noteOutlinks[p]?.count { it.optBoolean("exists") } ?: 0) + (noteTags[p]?.size ?: 0)

    if (activeMeta != null) {
      addNode(activeMeta.path, activeMeta.name, "active", degree(activeMeta.path))
      for (bl in activeBack) {
        val sp = bl.optString("source_path")
        byPath[sp]?.let { addNode(sp, it.name, "neighbor", degree(sp)) }
      }
      for (ol in activeOut) {
        if (ol.optBoolean("exists")) {
          val tp = ol.optString("target_path")
          byPath[tp]?.let { addNode(tp, it.name, "neighbor", degree(tp)) }
        }
      }
      for (t in activeTags.take(6)) {
        addNode("tag:$t", "#$t", "tag", tagFilesMap[t]?.size ?: 1)
      }
    }
    for ((p, meta) in mdNotes) {
      if (nodeIds.size >= 24) break
      addNode(p, meta.name, "hub", degree(p))
    }
    for ((tag, files) in sortedTags) {
      if (nodeIds.size >= 28) break
      addNode("tag:$tag", "#$tag", "tag", files.size)
    }

    val edgesArr = JSONArray()
    val seenEdges = HashSet<String>()
    fun addEdge(src: String, dst: String, kind: String) {
      if (src == dst || !nodeIds.contains(src) || !nodeIds.contains(dst)) return
      if (seenEdges.add("$src|$dst|$kind")) {
        edgesArr.put(
          JSONObject().apply {
            put("source", src)
            put("target", dst)
            put("kind", kind)
          },
        )
      }
    }
    for ((src, outs) in noteOutlinks) {
      if (!nodeIds.contains(src)) continue
      for (ol in outs) {
        if (ol.optBoolean("exists")) addEdge(src, ol.optString("target_path"), "link")
      }
    }
    for ((src, tlist) in noteTags) {
      if (!nodeIds.contains(src)) continue
      for (t in tlist) addEdge(src, "tag:$t", "tag")
    }

    // Related files by shared tags
    val relatedArr = JSONArray()
    if (resolvedActive.isNotEmpty()) {
      val sharedMap = LinkedHashMap<String, MutableList<String>>()
      for (t in activeTags) {
        for (fm in tagFilesMap[t].orEmpty()) {
          if (fm.path != resolvedActive) {
            sharedMap.getOrPut(fm.path) { mutableListOf() }.add(t)
          }
        }
      }
      for ((p, shared) in sharedMap.entries.sortedByDescending { it.value.size }.take(8)) {
        val fm = byPath[p] ?: continue
        val stArr = JSONArray()
        shared.forEach { stArr.put(it) }
        relatedArr.put(
          JSONObject().apply {
            put("path", fm.path)
            put("name", fm.name)
            put("rel_dir", fm.relDir)
            put("shared_tags", stArr)
            put("reason", "共标签 #${shared.take(3).joinToString(" #")}")
          },
        )
      }
    }

    val totalLinks = noteOutlinks.values.sumOf { it.size }
    val orphans = mdNotes.keys.count { (noteOutlinks[it]?.isEmpty() != false) && (backlinksMap[it]?.isEmpty() != false) }

    JSONObject().apply {
      put("tags", tagsArr)
      put(
        "active",
        JSONObject().apply {
          put("path", resolvedActive)
          put("name", activeMeta?.name.orEmpty())
          put("backlinks", JSONArray(activeBack))
          put("outlinks", JSONArray(activeOut))
          put("tags", JSONArray(activeTags))
          put("related_files", relatedArr)
        },
      )
      put(
        "local_graph",
        JSONObject().apply {
          put("nodes", nodesArr)
          put("edges", edgesArr)
        },
      )
      put(
        "stats",
        JSONObject().apply {
          put("total_notes", mdNotes.size)
          put("total_links", totalLinks)
          put("total_tags", sortedTags.size)
          put("orphan_notes", orphans)
        },
      )
    }
  }

  // ---------------------------------------------------------------------------
  // Built-in Recycle Bin (Trash)
  // ---------------------------------------------------------------------------

  fun listTrash(): JSONObject = synchronized(lock) {
    val settings = loadTrashSettings()
    val items = loadTrashManifest()
    val list = mutableListOf<JSONObject>()
    var totalBytes = 0L
    for (i in 0 until items.length()) {
      val it = items.optJSONObject(i) ?: continue
      list.add(it)
      totalBytes += it.optLong("size_bytes", 0L)
    }
    list.sortByDescending { it.optString("deleted_at") }
    JSONObject().apply {
      put("items", JSONArray(list))
      put("settings", settings)
      put(
        "stats",
        JSONObject().apply {
          put("count", list.size)
          put("total_bytes", totalBytes)
        },
      )
    }
  }

  fun trashVirtualItem(kind: String, title: String, payload: JSONObject, sourcePath: String = ""): JSONObject =
    synchronized(lock) {
      val cleanKind = kind.trim().ifEmpty { throw IllegalArgumentException("虚拟条目类型 kind 不能为空") }
      val item = JSONObject().apply {
        put("id", "tr_${UUID.randomUUID().toString().replace("-", "").take(10)}")
        put("kind", cleanKind)
        put("title", title.trim().ifEmpty { "未命名$cleanKind" })
        put("orig_path", sourcePath.trim())
        put("source_path", sourcePath.trim())
        put("stored_path", "")
        put("size_bytes", payload.toString().toByteArray(Charsets.UTF_8).size)
        put("deleted_at", nowIso())
        put("ext", "")
        put("payload", payload)
      }
      val manifest = loadTrashManifest()
      manifest.put(item)
      saveTrashManifest(manifest)
      JSONObject().put("ok", true).put("item", item)
    }

  fun restoreTrashItem(trashId: String): JSONObject = synchronized(lock) {
    val id = trashId.trim()
    val manifest = loadTrashManifest()
    val kept = JSONArray()
    var matched: JSONObject? = null
    for (i in 0 until manifest.length()) {
      val it = manifest.optJSONObject(i) ?: continue
      if (matched == null && it.optString("id") == id) {
        matched = it
      } else {
        kept.put(it)
      }
    }
    val item = matched ?: throw IllegalArgumentException("回收站条目不存在：$id")
    val kind = item.optString("kind")
    if (kind == "file" || kind == "folder") {
      val stored = File(item.optString("stored_path"))
      if (!stored.exists()) throw IllegalArgumentException("回收站暂存文件已丢失")
      val orig = File(item.optString("orig_path"))
      orig.parentFile?.mkdirs()
      var target = orig
      if (target.exists()) {
        val stem = target.nameWithoutExtension
        val ext = if (target.isFile && target.extension.isNotEmpty()) ".${target.extension}" else ""
        var c = 2
        target = File(orig.parentFile, "${stem}_恢复$ext")
        while (target.exists()) {
          target = File(orig.parentFile, "${stem}_恢复_$c$ext")
          c++
        }
      }
      moveRecursive(stored, target)
      saveTrashManifest(kept)
      return@synchronized JSONObject().apply {
        put("ok", true)
        put("kind", kind)
        put("restored_path", target.canonicalPath)
        put("item", item)
      }
    }
    saveTrashManifest(kept)
    JSONObject().apply {
      put("ok", true)
      put("kind", kind)
      put("item", item)
    }
  }

  fun emptyTrash(trashId: String = ""): JSONObject = synchronized(lock) {
    val id = trashId.trim()
    val manifest = loadTrashManifest()
    if (id.isNotEmpty()) {
      val kept = JSONArray()
      var removed = 0
      for (i in 0 until manifest.length()) {
        val it = manifest.optJSONObject(i) ?: continue
        if (it.optString("id") == id) {
          val sp = it.optString("stored_path")
          if (sp.isNotBlank()) File(sp).deleteRecursively()
          removed++
        } else {
          kept.put(it)
        }
      }
      saveTrashManifest(kept)
      return@synchronized JSONObject().put("ok", true).put("removed_count", removed)
    }
    val count = manifest.length()
    for (i in 0 until manifest.length()) {
      val sp = manifest.optJSONObject(i)?.optString("stored_path").orEmpty()
      if (sp.isNotBlank()) File(sp).deleteRecursively()
    }
    trashFilesDir.listFiles()?.forEach { it.deleteRecursively() }
    saveTrashManifest(JSONArray())
    JSONObject().put("ok", true).put("removed_count", count)
  }

  fun updateTrashSettings(mode: String?, autoPurgeDays: Int?): JSONObject = synchronized(lock) {
    val cur = loadTrashSettings()
    if (!mode.isNullOrBlank()) {
      cur.put("mode", "app")
    }
    if (autoPurgeDays != null && autoPurgeDays >= 0) {
      cur.put("auto_purge_days", autoPurgeDays)
    }
    atomicWriteText(trashSettingsFile, cur.toString(2), snapshot = false)
    cur
  }

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------

  fun searchNotes(query: String, mode: String = "keyword", limit: Int = 15): JSONObject = synchronized(lock) {
    val q = query.trim()
    if (q.isEmpty()) throw IllegalArgumentException("搜索关键词不能为空")
    val terms = q.lowercase(Locale.US).split(Regex("\\s+")).filter { it.isNotEmpty() }
    val ws = listFiles()
    val items = ws.optJSONArray("items") ?: JSONArray()

    data class Hit(val score: Double, val obj: JSONObject)

    val hits = mutableListOf<Hit>()
    for (i in 0 until items.length()) {
      val item = items.optJSONObject(i) ?: continue
      val path = item.optString("path")
      val name = item.optString("name")
      val ext = item.optString("ext").lowercase(Locale.US)
      val nameLow = name.lowercase(Locale.US)

      var score = 0.0
      for (t in terms) {
        if (nameLow.contains(t)) score += 3.0
      }

      var snippet = ""
      var bestLine = 1
      if (ext in TEXT_EXTS) {
        val f = File(path)
        if (f.exists() && f.length() <= 512 * 1024) {
          val lines = readTextSafe(f).lines()
          for ((idx, line) in lines.withIndex()) {
            val low = line.lowercase(Locale.US)
            val lineHits = terms.count { low.contains(it) }
            if (lineHits > 0) {
              score += lineHits * 1.5
              if (snippet.isEmpty()) {
                bestLine = idx + 1
                val clean = line.replace(Regex("\\s+"), " ").trim()
                snippet = if (clean.length > 140) clean.take(140) + "..." else clean
              }
            }
          }
        }
      }

      if (score > 0.0) {
        hits.add(
          Hit(
            score = score,
            obj = JSONObject().apply {
              put("path", path)
              put("name", name)
              put("ext", ext)
              put("score", score)
              put("line", bestLine)
              put("snippet", snippet.ifEmpty { "文件名匹配：$name" })
              put("reason", if (mode == "semantic") "本地关键词/语义匹配" else "关键词匹配")
            },
          ),
        )
      }
    }

    hits.sortByDescending { it.score }
    val resArr = JSONArray()
    hits.take(limit.coerceIn(1, 50)).forEach { resArr.put(it.obj) }

    JSONObject().apply {
      put("mode", mode)
      put("query", q)
      put("engine", "local_android")
      put("provider_label", "手机本地检索")
      put("total", hits.size)
      put("skipped_private", 0)
      put("results", resArr)
    }
  }

  // ---------------------------------------------------------------------------
  // Config, Privacy & Reminders
  // ---------------------------------------------------------------------------

  fun getConfig(): JSONObject = synchronized(lock) {
    val defaults = defaultConfigJson()
    if (!configFile.exists()) return@synchronized defaults
    return@synchronized try {
      val parsed = JSONObject(configFile.readText(Charsets.UTF_8))
      val keys = parsed.keys()
      while (keys.hasNext()) {
        val k = keys.next()
        if (k == "ai" && parsed.optJSONObject("ai") != null) {
          val mergedAi = defaults.getJSONObject("ai")
          val incomingAi = parsed.getJSONObject("ai")
          val aiKeys = incomingAi.keys()
          while (aiKeys.hasNext()) {
            val ak = aiKeys.next()
            mergedAi.put(ak, incomingAi.get(ak))
          }
          defaults.put("ai", mergedAi)
        } else {
          defaults.put(k, parsed.get(k))
        }
      }
      defaults
    } catch (_: Exception) {
      defaults
    }
  }

  fun updateConfig(patch: JSONObject): JSONObject = synchronized(lock) {
    val cur = getConfig()
    val keys = patch.keys()
    while (keys.hasNext()) {
      val k = keys.next()
      val v = patch.opt(k)
      if (v == null || v == JSONObject.NULL) continue
      if (k == "ai" && v is JSONObject) {
        val curAi = cur.optJSONObject("ai") ?: JSONObject()
        val ak = v.keys()
        while (ak.hasNext()) {
          val sub = ak.next()
          curAi.put(sub, v.get(sub))
        }
        cur.put("ai", curAi)
      } else if (k == "ui_layout" && v is JSONObject) {
        val curUi = cur.optJSONObject("ui_layout") ?: JSONObject()
        val uk = v.keys()
        while (uk.hasNext()) {
          val sub = uk.next()
          curUi.put(sub, v.get(sub))
        }
        cur.put("ui_layout", curUi)
      } else {
        cur.put(k, v)
      }
    }
    atomicWriteText(configFile, cur.toString(2), snapshot = false)
    cur
  }

  fun getSystemInfo(activePort: Int): JSONObject {
    val cfg = getConfig()
    val aiObj = cfg.optJSONObject("ai") ?: JSONObject()
    val hasKey = aiObj.optString("api_key", "").trim().isNotEmpty()
    return JSONObject().apply {
      put("ip", "127.0.0.1")
      put("port", activePort)
      put("platform", "android")
      put("ai_configured", hasKey)
      put("free_ai_enabled", false)
      put("ai_presets", JSONArray())
      put("default_progress_excel", "")
      put("default_notes_dir", notesDir.canonicalPath)
      put("auto_save_on_switch", cfg.optBoolean("auto_save_on_switch", true))
    }
  }

  fun setPrivacy(rawPath: String, isPrivate: Boolean): JSONObject = synchronized(lock) {
    val target = resolveSafePath(rawPath, mustExist = false).canonicalPath
    val cfg = getConfig()
    val arr = cfg.optJSONArray("private_files") ?: JSONArray()
    val set = LinkedHashSet<String>()
    for (i in 0 until arr.length()) {
      arr.optString(i).takeIf { it.isNotBlank() }?.let { set.add(it) }
    }
    if (isPrivate) set.add(target) else set.remove(target)
    val nextArr = JSONArray()
    set.forEach { nextArr.put(it) }
    updateConfig(JSONObject().put("private_files", nextArr))
    JSONObject().put("ok", true).put("path", target).put("private", isPrivate)
  }

  private fun isFilePrivate(canonicalPath: String): Boolean {
    val arr = getConfig().optJSONArray("private_files") ?: return false
    for (i in 0 until arr.length()) {
      if (arr.optString(i) == canonicalPath) return true
    }
    return false
  }

  fun listReminders(): JSONObject = synchronized(lock) {
    val arr = loadRemindersArray()
    JSONObject().put("items", arr).put("reminders", arr)
  }

  fun addReminder(title: String, triggerAt: String?, delaySeconds: Int?): JSONObject = synchronized(lock) {
    val cleanTitle = title.trim().ifEmpty { throw IllegalArgumentException("提醒标题不能为空") }
    val arr = loadRemindersArray()
    val id = "rem_${UUID.randomUUID().toString().replace("-", "").take(8)}"
    val triggerMs = if (delaySeconds != null && delaySeconds > 0) {
      System.currentTimeMillis() + delaySeconds * 1000L
    } else {
      System.currentTimeMillis() + 300_000L
    }
    val item = JSONObject().apply {
      put("id", id)
      put("title", cleanTitle)
      put("trigger_at", triggerAt ?: SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.getDefault()).format(Date(triggerMs)))
      put("status", "pending")
      put("created_at", nowIso())
    }
    arr.put(item)
    atomicWriteText(remindersFile, JSONObject().put("items", arr).toString(2), snapshot = false)
    item
  }

  fun deleteReminder(reminderId: String): JSONObject = synchronized(lock) {
    val arr = loadRemindersArray()
    val next = JSONArray()
    for (i in 0 until arr.length()) {
      val it = arr.optJSONObject(i) ?: continue
      if (it.optString("id") != reminderId) next.put(it)
    }
    atomicWriteText(remindersFile, JSONObject().put("items", next).toString(2), snapshot = false)
    JSONObject().put("ok", true).put("id", reminderId)
  }

  // ---------------------------------------------------------------------------
  // Sync Manifest & Bidirectional Sync Helpers
  // ---------------------------------------------------------------------------

  fun getSyncManifest(): List<LocalSyncEntry> = synchronized(lock) {
    val list = mutableListOf<LocalSyncEntry>()
    val rootCanon = notesDir.canonicalFile
    fun walk(dir: File) {
      val children = dir.listFiles()?.sortedBy { it.name.lowercase(Locale.US) } ?: return
      for (f in children) {
        if (f.name.startsWith(".")) continue
        if (f.isDirectory) {
          walk(f)
        } else if (f.isFile && f.extension.equals("md", ignoreCase = true)) {
          try {
            val bytes = f.readBytes()
            val rel = relativePosix(rootCanon, f.canonicalFile)
            list.add(
              LocalSyncEntry(
                relPath = rel,
                path = f.canonicalPath,
                name = f.name,
                mtimeSec = f.lastModified() / 1000.0,
                size = bytes.size.toLong(),
                sha256 = sha256Hex(bytes),
              ),
            )
          } catch (_: Exception) {
          }
        }
      }
    }
    walk(rootCanon)
    list.sortedBy { it.relPath.lowercase(Locale.US) }
  }

  fun readNotesRelBytes(relPath: String): ByteArray? = synchronized(lock) {
    val target = resolveNotesRelFile(relPath)
    if (!target.exists() || !target.isFile) return@synchronized null
    target.readBytes()
  }

  fun writeNotesRelBytes(relPath: String, bytes: ByteArray, mtimeSec: Double = 0.0): File = synchronized(lock) {
    val target = resolveNotesRelFile(relPath)
    atomicWriteBytes(target, bytes)
    if (mtimeSec > 0.0) {
      try {
        target.setLastModified((mtimeSec * 1000.0).toLong())
      } catch (_: Exception) {
      }
    }
    target
  }

  fun writeConflictCopy(relPath: String, bytes: ByteArray, tag: String = "电脑冲突副本"): File = synchronized(lock) {
    val orig = resolveNotesRelFile(relPath)
    val stamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())
    val stem = orig.nameWithoutExtension
    val ext = if (orig.extension.isNotEmpty()) ".${orig.extension}" else ""
    val conflictFile = File(orig.parentFile, "${stem}_${tag}_$stamp$ext")
    atomicWriteBytes(conflictFile, bytes)
    conflictFile
  }

  private fun resolveNotesRelFile(relPath: String): File {
    val clean = relPath.trim().replace("\\", "/").trimStart('/')
    if (clean.isEmpty() || clean.split("/").any { it == ".." }) {
      throw SecurityException("非法相对路径：$relPath")
    }
    val rootCanon = notesDir.canonicalFile
    val target = File(rootCanon, clean).canonicalFile
    if (!target.path.startsWith(rootCanon.path + File.separator)) {
      throw SecurityException("路径越界：$relPath")
    }
    return target
  }

  // ---------------------------------------------------------------------------
  // Internal Helpers
  // ---------------------------------------------------------------------------

  private data class ParsedTodo(val lineNo: Int, val text: String, val checked: Boolean, val heading: String)

  private fun parseMarkdownTodos(content: String): List<ParsedTodo> {
    val result = mutableListOf<ParsedTodo>()
    var heading = ""
    var inFence = false
    for ((idx, rawLine) in content.lines().withIndex()) {
      if (FENCE_REGEX.containsMatchIn(rawLine)) {
        inFence = !inFence
        continue
      }
      if (inFence) continue
      val hm = HEADING_CAPTURE_REGEX.matchEntire(rawLine.trim())
      if (hm != null) {
        heading = hm.groupValues[1].trim().trimEnd('#').trim()
        continue
      }
      val tm = TODO_LINE_REGEX.matchEntire(rawLine)
      if (tm != null) {
        result.add(
          ParsedTodo(
            lineNo = idx + 1,
            text = tm.groupValues[4].trim(),
            checked = tm.groupValues[2].equals("x", ignoreCase = true),
            heading = heading,
          ),
        )
      }
    }
    return result
  }

  private fun makeTodoId(filePath: String, lineNo: Int, text: String): String {
    val md5 = MessageDigest.getInstance("MD5").digest("$filePath:$lineNo:$text".toByteArray(Charsets.UTF_8))
    return "td_" + md5.joinToString("") { "%02x".format(it) }.take(10)
  }

  private fun splitLinesKeepEnds(text: String): List<String> {
    val out = mutableListOf<String>()
    var start = 0
    var i = 0
    while (i < text.length) {
      if (text[i] == '\r') {
        if (i + 1 < text.length && text[i + 1] == '\n') i++
        out.add(text.substring(start, i + 1))
        start = i + 1
      } else if (text[i] == '\n') {
        out.add(text.substring(start, i + 1))
        start = i + 1
      }
      i++
    }
    if (start < text.length) out.add(text.substring(start))
    return out
  }

  private fun resolveNotesSubdir(folderRel: String): Pair<File, String> {
    val clean = folderRel.trim().replace("\\", "/").trim('/')
    val rootCanon = notesDir.canonicalFile
    if (clean.isEmpty() || clean == ".") {
      rootCanon.mkdirs()
      return rootCanon to ""
    }
    if (clean.contains('\u0000') || clean.split("/").any { it == ".." }) {
      throw SecurityException("安全拦截：目录路径非法")
    }
    val target = File(rootCanon, clean).canonicalFile
    if (target.path != rootCanon.path && !target.path.startsWith(rootCanon.path + File.separator)) {
      throw SecurityException("安全拦截：禁止越出默认笔记目录")
    }
    if (target.exists() && target.isFile) {
      throw IllegalArgumentException("目标路径不是文件夹")
    }
    target.mkdirs()
    return target to relativePosix(rootCanon, target)
  }

  private fun loadCompanionNote(target: File): Triple<File, String, Boolean> {
    val companion = File(target.parentFile, "${target.nameWithoutExtension}.notes.md")
    return if (companion.exists() && companion.isFile) {
      Triple(companion, readTextSafe(companion), true)
    } else {
      Triple(companion, "", false)
    }
  }

  private fun loadTrashManifest(): JSONArray {
    return try {
      val root = JSONObject(trashManifestFile.readText(Charsets.UTF_8))
      root.optJSONArray("items") ?: JSONArray()
    } catch (_: Exception) {
      JSONArray()
    }
  }

  private fun saveTrashManifest(items: JSONArray) {
    atomicWriteText(trashManifestFile, JSONObject().put("items", items).toString(2), snapshot = false)
  }

  private fun loadTrashSettings(): JSONObject {
    return try {
      JSONObject(trashSettingsFile.readText(Charsets.UTF_8))
    } catch (_: Exception) {
      JSONObject().put("mode", "app").put("auto_purge_days", 15)
    }
  }

  private fun loadRemindersArray(): JSONArray {
    return try {
      JSONObject(remindersFile.readText(Charsets.UTF_8)).optJSONArray("items") ?: JSONArray()
    } catch (_: Exception) {
      JSONArray()
    }
  }

  private fun moveRecursive(src: File, dst: File) {
    if (src.renameTo(dst)) return
    if (src.isDirectory) {
      dst.mkdirs()
      src.listFiles()?.forEach { child ->
        moveRecursive(child, File(dst, child.name))
      }
      src.deleteRecursively()
    } else {
      src.copyTo(dst, overwrite = true)
      src.delete()
    }
  }

  private fun computeSize(f: File): Long {
    if (f.isFile) return f.length()
    var sum = 0L
    f.walkTopDown().forEach { if (it.isFile) sum += it.length() }
    return sum
  }

  private fun relativePosix(root: File, child: File): String {
    if (child.path == root.path) return ""
    val prefix = root.path + File.separator
    val rel = if (child.path.startsWith(prefix)) child.path.removePrefix(prefix) else child.name
    return rel.replace(File.separatorChar, '/')
  }

  private fun nextSequentialName(prefix: String, existing: List<String>): String {
    val rx = Regex("^${Regex.escape(prefix)}(\\d+)$")
    var maxNum = 0
    for (name in existing) {
      val m = rx.matchEntire(name.trim())
      if (m != null) {
        maxNum = maxOf(maxNum, m.groupValues[1].toIntOrNull() ?: 0)
      }
    }
    return "$prefix${maxNum + 1}"
  }

  private fun sanitizeFilename(raw: String): String {
    return raw.replace(INVALID_FILENAME_REGEX, "_").trim().trim('.')
  }

  private fun getDotExt(name: String): String {
    val dot = name.lastIndexOf('.')
    return if (dot > 0 && dot < name.length - 1) name.substring(dot).lowercase(Locale.US) else ""
  }

  fun readTextSafe(file: File): String {
    return try {
      file.readText(Charsets.UTF_8).removePrefix("\uFEFF")
    } catch (_: Exception) {
      ""
    }
  }

  fun guessMimeType(file: File): String = guessMimeByName(file.name)

  companion object {
    private val INVALID_FILENAME_REGEX = Regex("[\\\\/:*?\"<>|\\x00-\\x1f]")
    private val FENCE_REGEX = Regex("^\\s*(?:`{3,}|~{3,})")
    private val HEADING_LINE_REGEX = Regex("^\\s*#{1,6}\\s+")
    private val HEADING_CAPTURE_REGEX = Regex("^#{1,6}\\s+(.+)$")
    private val TODO_LINE_REGEX = Regex("^(\\s*[-*+]\\s+\\[)([ xX])(\\]\\s+)(.*)$")
    private val WIKILINK_REGEX = Regex("\\[\\[([^\\]|#]+)(?:#[^\\]|]*)?(?:\\|[^\\]]*)?\\]\\]")
    private val NON_FILE_PREFIX_REGEX = Regex("^(?:app|ws|url|http|https|mailto|cmd|action):", RegexOption.IGNORE_CASE)
    private val INLINE_CODE_REGEX = Regex("`[^`\\n]+`")
    private val TAG_REGEX = Regex("(?:^|[\\s,，;；(（\\[])#([A-Za-z0-9_\\u4e00-\\u9fa5\\-/]{1,32})")
    private val HEX_COLOR_REGEX = Regex("(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})")

    private val TEXT_EXTS = setOf(
      ".md", ".txt", ".json", ".csv", ".log", ".yaml", ".yml", ".xml", ".html", ".css", ".js", ".ts",
      ".py", ".kt", ".java", ".c", ".cpp", ".h", ".go", ".rs", ".sh", ".sql", ".ini", ".toml",
    )
    private val IMAGE_EXTS = setOf(".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp")
    private val AUDIO_EXTS = setOf(".mp3", ".wav", ".aac", ".m4a", ".ogg", ".flac")
    private val VIDEO_EXTS = setOf(".mp4", ".webm", ".mov", ".mkv", ".m4v", ".avi")

    fun sha256Hex(bytes: ByteArray): String {
      val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
      return digest.joinToString("") { "%02x".format(it) }
    }

    fun nowIso(): String = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US).format(Date())

    fun guessMimeByName(name: String): String {
      return when (name.substringAfterLast('.', "").lowercase(Locale.US)) {
        "html", "htm" -> "text/html; charset=utf-8"
        "js", "mjs" -> "application/javascript; charset=utf-8"
        "css" -> "text/css; charset=utf-8"
        "json" -> "application/json; charset=utf-8"
        "svg" -> "image/svg+xml"
        "png" -> "image/png"
        "jpg", "jpeg" -> "image/jpeg"
        "gif" -> "image/gif"
        "webp" -> "image/webp"
        "bmp" -> "image/bmp"
        "ico" -> "image/x-icon"
        "pdf" -> "application/pdf"
        "mp3" -> "audio/mpeg"
        "wav" -> "audio/wav"
        "m4a" -> "audio/mp4"
        "ogg" -> "audio/ogg"
        "mp4" -> "video/mp4"
        "webm" -> "video/webm"
        "woff2" -> "font/woff2"
        "woff" -> "font/woff"
        "ttf" -> "font/ttf"
        "md", "txt" -> "text/plain; charset=utf-8"
        else -> "application/octet-stream"
      }
    }

    private const val WELCOME_NOTE_CONTENT = """# 欢迎使用 SmartLocalNote 手机独立版

这是一份保存在你手机本地的 Markdown 笔记，**完全无需联网或连接电脑**即可独立使用全套工作台！

#随手记 #工作 #手机本地库

## 核心功能一览

### 1. 本地离线工作台
- 所见即所得 Markdown 编辑与阅读
- 点击右上角「思维导图」即可将本文的多级标题自动转为交互脑图
- 支持 `[[欢迎使用_SmartLocalNote手机版.md]]` 双向链接与 `#标签` 知识图谱

### 2. 今日待办清单（点击左侧待办面板可全局管理）
- [ ] 体验在手机端直接编辑笔记与切换深色/浅色主题
- [ ] 打开脑图视图查看本文结构
- [ ] （可选）点击顶栏 📱 按钮，连接 Windows 电脑体验双向增量同步
- [x] 成功安装 SmartLocalNote 独立离线版

## 与 Windows 电脑双向同步
- 平时外出断网照常记录，所有文件安全存储在手机本地
- 回到同一 Wi-Fi 后，点顶栏 📱 按钮进入「Windows 同步中心」，一键双向增量同步全部笔记
"""
  }
}
