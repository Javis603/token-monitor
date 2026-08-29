# No shrinking is enabled for release builds (this app is a LAN viewer with no
# reflection-heavy dependencies), so these are only a starting point if it ever
# is turned on.
-keepattributes *Annotation*
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class androidx.datastore.** { *; }
-dontwarn okhttp3.**
-dontwarn okio.**
