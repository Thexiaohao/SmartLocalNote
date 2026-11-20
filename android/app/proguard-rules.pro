# Preserve WebView @JavascriptInterface bridge methods under R8 shrinking
-keepattributes *Annotation*
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keepclassmembers class com.smartlocalnote.android.ui.WorkbenchScreenKt** {
    @android.webkit.JavascriptInterface <methods>;
}
