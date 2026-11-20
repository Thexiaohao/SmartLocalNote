package com.smartlocalnote.android.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.widget.RemoteViews
import com.smartlocalnote.android.MainActivity
import com.smartlocalnote.android.R

class QuickNoteWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(
    context: Context,
    appWidgetManager: AppWidgetManager,
    appWidgetIds: IntArray,
  ) {
    for (widgetId in appWidgetIds) {
      val views = RemoteViews(context.packageName, R.layout.widget_quick_note)

      views.setOnClickPendingIntent(
        R.id.widget_btn_sticky,
        buildActionIntent(context, MainActivity.ACTION_QUICK_STICKY, 101),
      )
      views.setOnClickPendingIntent(
        R.id.widget_btn_clipboard,
        buildActionIntent(context, MainActivity.ACTION_PUSH_CLIPBOARD, 102),
      )
      views.setOnClickPendingIntent(
        R.id.widget_btn_todos,
        buildActionIntent(context, MainActivity.ACTION_OPEN_TODOS, 103),
      )

      appWidgetManager.updateAppWidget(widgetId, views)
    }
  }

  private fun buildActionIntent(
    context: Context,
    actionValue: String,
    requestCode: Int,
  ): PendingIntent {
    val intent = Intent(context, MainActivity::class.java).apply {
      action = "com.smartlocalnote.android.WIDGET_$actionValue"
      putExtra(MainActivity.EXTRA_ACTION, actionValue)
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
    }
    return PendingIntent.getActivity(
      context,
      requestCode,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }
}
