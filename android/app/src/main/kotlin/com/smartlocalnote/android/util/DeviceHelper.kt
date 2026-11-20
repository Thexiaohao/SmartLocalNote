package com.smartlocalnote.android.util

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import java.io.ByteArrayOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

data class ReadUriFile(
  val filename: String,
  val mimeType: String,
  val bytes: ByteArray,
)

object DeviceHelper {
  const val MAX_UPLOAD_BYTES = 25 * 1024 * 1024 // 25MB in-memory cap
  const val MAX_OFFLINE_FILE_BYTES = 6 * 1024 * 1024 // 6MB safe cap for SharedPreferences queue

  fun readClipboard(context: Context): String {
    return try {
      val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return ""
      val clip = cm.primaryClip ?: return ""
      if (clip.itemCount <= 0) return ""
      clip.getItemAt(0).coerceToText(context)?.toString().orEmpty()
    } catch (_: Exception) {
      ""
    }
  }

  fun writeClipboard(context: Context, text: String, label: String = "SmartLocalNote") {
    try {
      val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return
      cm.setPrimaryClip(ClipData.newPlainText(label, text))
    } catch (_: Exception) {
    }
  }

  @Suppress("DEPRECATION")
  fun hapticTick(context: Context) {
    try {
      val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        val vm = context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager
        vm?.defaultVibrator
      } else {
        context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
      }
      if (vibrator?.hasVibrator() == true) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          vibrator.vibrate(VibrationEffect.createPredefined(VibrationEffect.EFFECT_TICK))
        } else {
          vibrator.vibrate(VibrationEffect.createOneShot(18L, VibrationEffect.DEFAULT_AMPLITUDE))
        }
      }
    } catch (_: Exception) {
    }
  }

  fun readUriFile(context: Context, uri: Uri, maxBytes: Int = MAX_UPLOAD_BYTES): ReadUriFile? {
    val resolver = context.contentResolver
    val mime = resolver.getType(uri) ?: "application/octet-stream"
    var name: String? = null
    try {
      resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) {
          val idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
          if (idx >= 0) name = cursor.getString(idx)
        }
      }
    } catch (_: Exception) {
    }

    val safeName = name?.trim()?.takeIf { it.isNotBlank() } ?: run {
      val ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(mime)?.let { ".$it" } ?: ".bin"
      val stamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())
      "mobile_$stamp$ext"
    }

    val bytes = try {
      resolver.openInputStream(uri)?.use { input ->
        val out = ByteArrayOutputStream()
        val buf = ByteArray(16 * 1024)
        var total = 0
        while (true) {
          val n = input.read(buf)
          if (n <= 0) break
          total += n
          if (total > maxBytes) return null
          out.write(buf, 0, n)
        }
        out.toByteArray()
      }
    } catch (_: Exception) {
      null
    } ?: return null

    return ReadUriFile(filename = safeName, mimeType = mime, bytes = bytes)
  }

  fun formatFileSize(bytes: Long): String {
    return when {
      bytes < 1024 -> "$bytes B"
      bytes < 1024 * 1024 -> String.format(Locale.US, "%.1f KB", bytes / 1024.0)
      else -> String.format(Locale.US, "%.2f MB", bytes / (1024.0 * 1024.0))
    }
  }

  fun formatShortTime(epochMs: Long): String {
    return SimpleDateFormat("MM-dd HH:mm", Locale.getDefault()).format(Date(epochMs))
  }
}
