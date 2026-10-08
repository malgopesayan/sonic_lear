package com.malgopelabs.soniclayer

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.ContentValues
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.JsResult
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebResourceRequest
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener

/**
 * SonicLayer Pro for Android.
 *
 * Main WebView  = the browser (YouTube / SoundCloud / Twitch / Vimeo).
 * content.js    = injected into every page load, exactly as the extension did.
 * Popup WebView = popup.html/popup.js in a bottom panel, talking to the page
 *                 through [Bridge] (the chrome.tabs / chrome.storage replacement).
 *
 * The bridge is ONLY attached to the popup WebView (our own trusted HTML),
 * never to the main WebView that loads third-party sites.
 */
class MainActivity : Activity() {

    companion object {
        private const val FILE_CHOOSER = 1001
        private val SUPPORTED = setOf("www.youtube.com", "soundcloud.com", "www.twitch.tv", "vimeo.com")
    }

    private lateinit var web: WebView
    private lateinit var popup: WebView
    private lateinit var panel: LinearLayout
    private lateinit var fab: TextView
    private lateinit var root: FrameLayout

    private val ui = Handler(Looper.getMainLooper())
    private val prefs by lazy { getSharedPreferences("soniclayer", MODE_PRIVATE) }

    @Volatile private var currentUrl = "https://m.youtube.com/"
    private lateinit var injectScript: String
    private lateinit var popupHtml: String

    private var customView: View? = null
    private var customViewCb: WebChromeClient.CustomViewCallback? = null
    private var fileCb: ValueCallback<Array<Uri>>? = null

    // ------------------------------------------------------------------ setup

    private fun asset(name: String): String =
        assets.open(name).bufferedReader(Charsets.UTF_8).use { it.readText() }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = Color.parseColor("#050505")
        window.navigationBarColor = Color.parseColor("#050505")

        injectScript = "if(!window.__sonicLoaded){window.__sonicLoaded=true;\n" +
            asset("android-content-shim.js") + "\n;" +
            asset("orbit-math.js") + "\n;" +
            asset("content.js") + "\n}"

        popupHtml = asset("popup.html")
            .replace(
                "<head>",
                "<head><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
                    "<style>body{width:100%!important;max-width:100%!important}</style>"
            )
            .replace(
                "<script src=\"orbit-math.js\"></script>",
                "<script>" + asset("android-popup-shim.js") + "</script><script>" + asset("orbit-math.js") + "</script>"
            )
            .replace("<script src=\"popup.js\"></script>", "<script>" + asset("popup.js") + "</script>")

        val dp = resources.displayMetrics.density
        root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }

        val column = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        column.addView(buildTopBar(dp), LinearLayout.LayoutParams(MATCH_PARENT, (48 * dp).toInt()))

        web = WebView(this)
        setupMainWebView()
        column.addView(web, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
        root.addView(column, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))

        fab = TextView(this).apply {
            text = "EQ"
            gravity = Gravity.CENTER
            setTextColor(Color.BLACK)
            setTypeface(typeface, Typeface.BOLD)
            textSize = 15f
            elevation = 8 * dp
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(Color.parseColor("#00f2ff"))
            }
            setOnClickListener { togglePanel(true) }
        }
        root.addView(
            fab,
            FrameLayout.LayoutParams((56 * dp).toInt(), (56 * dp).toInt(), Gravity.BOTTOM or Gravity.END)
                .apply { setMargins(0, 0, (16 * dp).toInt(), (24 * dp).toInt()) }
        )

        panel = buildPanel(dp)
        root.addView(
            panel,
            FrameLayout.LayoutParams(MATCH_PARENT, (resources.displayMetrics.heightPixels * 0.82).toInt(), Gravity.BOTTOM)
        )

        setContentView(root)
        web.loadUrl(intent?.data?.toString() ?: "https://m.youtube.com/")
    }

    private fun buildTopBar(dp: Float): LinearLayout {
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setBackgroundColor(Color.parseColor("#050505"))
        }
        fun item(label: String, onClick: () -> Unit) {
            bar.addView(
                TextView(this).apply {
                    text = label
                    gravity = Gravity.CENTER
                    textSize = 12f
                    setTextColor(Color.parseColor("#00f2ff"))
                    setOnClickListener { onClick() }
                },
                LinearLayout.LayoutParams(0, MATCH_PARENT, 1f)
            )
        }
        item("◀") { if (web.canGoBack()) web.goBack() }
        item("YouTube") { web.loadUrl("https://m.youtube.com/") }
        item("SoundCloud") { web.loadUrl("https://soundcloud.com/") }
        item("Twitch") { web.loadUrl("https://www.twitch.tv/") }
        item("Vimeo") { web.loadUrl("https://vimeo.com/") }
        return bar
    }

    @SuppressLint("SetJavaScriptEnabled", "AddJavascriptInterface")
    private fun buildPanel(dp: Float): LinearLayout {
        val p = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#050505"))
            visibility = View.GONE
            elevation = 16 * dp
        }
        p.addView(
            TextView(this).apply {
                text = "SONICLAYER PRO        ✕ CLOSE"
                gravity = Gravity.CENTER
                textSize = 12f
                setTextColor(Color.parseColor("#00f2ff"))
                setBackgroundColor(Color.parseColor("#101018"))
                setOnClickListener { togglePanel(false) }
            },
            LinearLayout.LayoutParams(MATCH_PARENT, (40 * dp).toInt())
        )

        popup = WebView(this)
        popup.settings.javaScriptEnabled = true
        popup.settings.domStorageEnabled = true
        popup.setBackgroundColor(Color.parseColor("#050505"))
        popup.addJavascriptInterface(Bridge(), "AndroidBridge")
        popup.webChromeClient = object : WebChromeClient() {
            override fun onJsAlert(view: WebView?, url: String?, message: String?, result: JsResult?): Boolean {
                AlertDialog.Builder(this@MainActivity)
                    .setMessage(message)
                    .setPositiveButton("OK") { _, _ -> result?.confirm() }
                    .setOnCancelListener { result?.cancel() }
                    .show()
                return true
            }

            override fun onShowFileChooser(
                webView: WebView?,
                callback: ValueCallback<Array<Uri>>?,
                params: FileChooserParams?
            ): Boolean {
                fileCb?.onReceiveValue(null)
                fileCb = callback
                val i = Intent(Intent.ACTION_GET_CONTENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "*/*"
                }
                startActivityForResult(i, FILE_CHOOSER)
                return true
            }
        }
        p.addView(popup, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
        return p
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupMainWebView() {
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
        }
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true)

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val scheme = request.url.scheme ?: return true
                return scheme != "http" && scheme != "https" // block intent://, app deep links, etc.
            }

            override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
                currentUrl = url
            }

            override fun onPageFinished(view: WebView, url: String) {
                currentUrl = url
                view.evaluateJavascript(injectScript, null)
                // Mirror background.js: restore this site's saved profile automatically.
                ui.postDelayed({ applySavedProfile() }, 1500)
                ui.postDelayed({ applySavedProfile() }, 5000)
            }
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onShowCustomView(view: View, callback: CustomViewCallback) {
                if (customView != null) { callback.onCustomViewHidden(); return }
                customView = view
                customViewCb = callback
                root.addView(view, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
                @Suppress("DEPRECATION")
                window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_FULLSCREEN or
                    View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            }

            override fun onHideCustomView() {
                customView?.let { root.removeView(it) }
                customView = null
                customViewCb?.onCustomViewHidden()
                customViewCb = null
                @Suppress("DEPRECATION")
                window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_VISIBLE
            }
        }
    }

    // --------------------------------------------------------------- behaviour

    private fun togglePanel(open: Boolean) {
        if (open) {
            popup.loadDataWithBaseURL("https://soniclayer.local/", popupHtml, "text/html", "utf-8", null)
            panel.visibility = View.VISIBLE
            fab.visibility = View.GONE
        } else {
            panel.visibility = View.GONE
            fab.visibility = View.VISIBLE
            popup.loadUrl("about:blank") // stops the visualizer loop while hidden
        }
    }

    @Suppress("OVERRIDE_DEPRECATION")
    override fun onBackPressed() {
        when {
            customView != null -> web.webChromeClient?.onHideCustomView()
            panel.visibility == View.VISIBLE -> togglePanel(false)
            web.canGoBack() -> web.goBack()
            else -> super.onBackPressed()
        }
    }

    @Suppress("OVERRIDE_DEPRECATION")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == FILE_CHOOSER) {
            val result = if (resultCode == RESULT_OK && data?.data != null) arrayOf(data.data!!) else null
            fileCb?.onReceiveValue(result)
            fileCb = null
        } else {
            @Suppress("DEPRECATION")
            super.onActivityResult(requestCode, resultCode, data)
        }
    }

    private fun normHost(url: String): String {
        val h = try { Uri.parse(url).host ?: "" } catch (e: Exception) { "" }
        return when (h) {
            "m.youtube.com", "youtube.com", "music.youtube.com" -> "www.youtube.com"
            "www.soundcloud.com", "m.soundcloud.com" -> "soundcloud.com"
            "m.twitch.tv", "twitch.tv" -> "www.twitch.tv"
            "www.vimeo.com" -> "vimeo.com"
            else -> h
        }
    }

    /** Evaluates a message against the content script in the page. [cb] gets JSON or "__norec__". */
    private fun deliver(msgJson: String, cb: ((String?) -> Unit)? = null) {
        web.evaluateJavascript(
            "(function(){try{if(!window.__sonicDeliver)return '__norec__';" +
                "var r=window.__sonicDeliver($msgJson);return r===undefined?null:r}catch(e){return null}})()"
        ) { cb?.invoke(it) }
    }

    private fun readStore(): JSONObject = synchronized(prefs) {
        try { JSONObject(prefs.getString("store", "{}") ?: "{}") } catch (e: Exception) { JSONObject() }
    }

    private fun applySavedProfile() {
        val host = normHost(currentUrl)
        if (host !in SUPPORTED) return
        val store = readStore()
        val profile = store.optJSONObject("profiles")?.optJSONObject(host)
            ?: store.optJSONObject("defaultProfile") ?: return
        val msg = JSONObject(profile.toString())
        msg.put("type", "SET_AUDIO")
        msg.put("enabled", store.optBoolean("power", true))
        deliver(msg.toString())
    }

    override fun onDestroy() {
        web.destroy()
        popup.destroy()
        super.onDestroy()
    }

    // ------------------------------------------------- chrome.* replacement

    /** Methods run on a WebView binder thread; anything touching a WebView hops to [ui]. */
    inner class Bridge {

        @JavascriptInterface
        fun getTabUrl(): String {
            val url = currentUrl
            val host = normHost(url)
            return if (host in SUPPORTED) "https://$host/" else url
        }

        @JavascriptInterface
        fun storageGet(keysJson: String): String {
            val s = readStore()
            val keys = JSONTokener(keysJson).nextValue()
            val wanted: List<String> = when (keys) {
                is JSONArray -> (0 until keys.length()).map { keys.getString(it) }
                is String -> listOf(keys)
                else -> return s.toString() // null / undefined -> everything
            }
            val out = JSONObject()
            for (k in wanted) if (s.has(k)) out.put(k, s.get(k))
            return out.toString()
        }

        @JavascriptInterface
        fun storageSet(json: String) {
            synchronized(prefs) {
                val s = readStore()
                val incoming = JSONObject(json)
                for (k in incoming.keys()) s.put(k, incoming.get(k))
                prefs.edit().putString("store", s.toString()).apply()
            }
        }

        @JavascriptInterface
        fun sendToTab(msgJson: String, cbId: Int) {
            ui.post {
                deliver(msgJson) { res ->
                    popup.evaluateJavascript("window.__sonicCb($cbId, ${res ?: "null"})", null)
                }
            }
        }

        @JavascriptInterface
        fun saveDownload(name: String, text: String) {
            ui.post {
                try {
                    val values = ContentValues().apply {
                        put(MediaStore.Downloads.DISPLAY_NAME, name)
                        put(MediaStore.Downloads.MIME_TYPE, "application/json")
                        put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
                    }
                    val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                        ?: throw IllegalStateException("insert failed")
                    contentResolver.openOutputStream(uri)?.use { it.write(text.toByteArray(Charsets.UTF_8)) }
                    Toast.makeText(this@MainActivity, "Saved to Downloads/$name", Toast.LENGTH_LONG).show()
                } catch (e: Exception) {
                    Toast.makeText(this@MainActivity, "Export failed: ${e.message}", Toast.LENGTH_LONG).show()
                }
            }
        }
    }
}
