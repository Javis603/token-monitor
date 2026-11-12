package com.javis.tokenmonitor.remote.ui

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.provider.Settings
import android.text.TextUtils
import android.view.animation.PathInterpolator
import android.content.res.Configuration
import android.graphics.Outline
import android.graphics.Path
import android.graphics.RectF
import android.graphics.drawable.GradientDrawable
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.javis.tokenmonitor.remote.R

private const val TAG = "HyperGlass"

object HyperOsGlass {
    val supported: Boolean by lazy {
        View::class.java.methods.any { it.name == "setMiBackgroundBlurMode" }
    }

    private val methods = HashMap<String, java.lang.reflect.Method?>()

    fun attachCapsule(view: View, radiusPx: Float) {
        if (!supported) return
        val mark = mark(view, "hyper-capsule")
        if (mark.fresh) {
            applyPlate(view, radiusPx, capsule = true)
            mark.fresh = false
        }
        if (mark.width == view.width && mark.height == view.height && mark.corner == radiusPx) return
        mark.width = view.width
        mark.height = view.height
        mark.corner = radiusPx
        invoke(view, "setMiGlass", floatArrayOf(1f, 100f, radiusPx, 1.05f, 1f))
        if (view.width > 0 && view.height > 0) {
            val path = Path().apply {
                addRoundRect(RectF(0f, 0f, view.width.toFloat(), view.height.toFloat()), radiusPx, radiusPx, Path.Direction.CW)
            }
            invoke(view, "setMiBackgroundBlurPath", path)
        }
        applyOutline(view, radiusPx, capsule = true)
    }

    fun attach(view: View, cornerPx: Float) {
        if (!supported) return
        val mark = mark(view, "hyper-glass")
        if (mark.fresh) {
            applyPlate(view, cornerPx, capsule = false)
            mark.fresh = false
        }
        if (mark.width == view.width && mark.height == view.height && mark.corner == cornerPx) return
        mark.width = view.width
        mark.height = view.height
        mark.corner = cornerPx
        applyOutline(view, cornerPx, capsule = false)
    }

    private fun mark(view: View, kind: String): GlassMark {
        val current = view.tag as? GlassMark
        if (current != null && current.kind == kind) return current
        val created = GlassMark(kind)
        view.tag = created
        return created
    }

    private fun applyPlate(view: View, cornerPx: Float, capsule: Boolean) {
        val night = (view.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
            Configuration.UI_MODE_NIGHT_YES
        // miuix 高级材质：背后模糊、按轮廓取形、两层混色。浅色是减淡白 + 一层很薄的正片叠底。
        invoke(view, "clearMiBackgroundBlendColor")
        invoke(view, "setMiBackgroundBlurMode", 1)
        invoke(view, "setMiBackgroundBlurRadius", 80)
        invoke(view, "setMiViewBlurMode", 1)
        if (night) {
            invoke(view, "addMiBackgroundBlendColor", 0x8C2A2A2A.toInt(), 19)
            invoke(view, "addMiBackgroundBlendColor", 0x66000000, 3)
        } else {
            invoke(view, "addMiBackgroundBlendColor", 0xA6FFFFFF.toInt(), 18)
            invoke(view, "addMiBackgroundBlendColor", 0x14000000, 3)
        }
        if (capsule) {
            invoke(view, "setMiGlassClip", true)
        } else {
            invoke(view, "setMiGlass", floatArrayOf(1f, 80f, cornerPx, 1.05f, 1f))
        }
    }

    private fun applyOutline(view: View, cornerPx: Float, capsule: Boolean) {
        view.outlineProvider = object : ViewOutlineProvider() {
            override fun getOutline(target: View, outline: Outline) {
                if (target.width == 0 || target.height == 0) return
                val radius = if (capsule) target.height / 2f else cornerPx
                outline.setRoundRect(0, 0, target.width, target.height, radius)
            }
        }
        view.clipToOutline = true
    }

    private fun invoke(view: View, name: String, vararg args: Any?) {
        val types = args.map { arg ->
            when (arg) {
                is Int -> Int::class.javaPrimitiveType
                is Boolean -> Boolean::class.javaPrimitiveType
                is Float -> Float::class.javaPrimitiveType
                is FloatArray -> FloatArray::class.java
                else -> arg?.javaClass
            }
        }.toTypedArray()
        val key = buildString {
            append(name)
            types.forEach { append(':').append(it?.name) }
        }
        val method = synchronized(methods) {
            if (methods.containsKey(key)) {
                methods[key]
            } else {
                val found = view.javaClass.methods.firstOrNull { candidate ->
                    candidate.name == name && candidate.parameterTypes.contentEquals(types)
                }
                methods[key] = found
                found
            }
        } ?: return
        runCatching { method.invoke(view, *args) }
            .onFailure { Log.i(TAG, "$name failed ${it.message}") }
    }

    private class GlassMark(val kind: String) {
        var fresh = true
        var width = -1
        var height = -1
        var corner = Float.NaN
    }
}

@Composable
fun SoftGlass(
    modifier: Modifier = Modifier,
    shape: Shape = RoundedCornerShape(28.dp),
    corner: Dp = 28.dp,
    veil: Float = 0.72f,
    blur: Boolean = false,
    content: @Composable BoxScope.() -> Unit
) {
    val dark = isSystemInDarkTheme()
    val density = LocalDensity.current
    val cornerPx = with(density) { corner.toPx() }
    val frost = veil.coerceIn(0.22f, 0.42f)
    val tint = if (dark) Color.Black.copy(alpha = frost) else Color.White.copy(alpha = frost)
    val stroke = if (dark) Color.White.copy(alpha = 0.14f) else Color.White.copy(alpha = 0.72f)
    Box(modifier.clip(shape)) {
        if (blur && HyperOsGlass.supported) {
            AndroidView(
                modifier = Modifier.matchParentSize(),
                factory = { context -> View(context) },
                update = { view -> HyperOsGlass.attach(view, cornerPx) }
            )
        }
        Box(Modifier.matchParentSize().background(tint))
        Box(Modifier.matchParentSize().border(0.5.dp, stroke, shape))
        Box(content = content)
    }
}

@Composable
fun SystemGlassNav(selected: Int, visible: Boolean, onSelect: (Int) -> Unit) {
    val host = LocalView.current
    val bar = androidx.compose.runtime.remember { NavGlassBar(host.context) }
    DisposableEffect(host) {
        val parent = generateSequence(host as View?) { it.parent as? View }
            .firstOrNull { it.id == android.R.id.content } as? ViewGroup
        if (parent == null) {
            onDispose {}
        } else {
            val density = host.resources.displayMetrics.density
            val params = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                (62f * density).toInt()
            ).apply {
                gravity = Gravity.BOTTOM
                val side = (18f * density).toInt()
                marginStart = side
                marginEnd = side
                bottomMargin = (10f * density).toInt()
            }
            ViewCompat.setOnApplyWindowInsetsListener(bar) { view, insets ->
                val nav = insets.getInsets(WindowInsetsCompat.Type.navigationBars()).bottom
                val layout = view.layoutParams as FrameLayout.LayoutParams
                layout.bottomMargin = nav + (10f * density).toInt()
                view.layoutParams = layout
                insets
            }
            parent.addView(bar, params)
            bar.bringToFront()
            ViewCompat.requestApplyInsets(bar)
            onDispose {
                ViewCompat.setOnApplyWindowInsetsListener(bar, null)
                parent.removeView(bar)
            }
        }
    }
    SideEffect {
        bar.onSelect = onSelect
        bar.setSelected(selected)
        bar.setShown(visible)
    }
}

private class NavGlassBar(context: Context) : LinearLayout(context) {
    var onSelect: ((Int) -> Unit)? = null
    private val slots: List<LinearLayout>
    private val night = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
        Configuration.UI_MODE_NIGHT_YES

    init {
        orientation = HORIZONTAL
        val density = resources.displayMetrics.density
        setPadding((4f * density).toInt(), (4f * density).toInt(), (4f * density).toInt(), (4f * density).toInt())
        val entries = listOf(
            R.drawable.ic_nav_overview to R.string.nav_home,
            R.drawable.ic_nav_tools to R.string.nav_tools,
            R.drawable.ic_nav_models to R.string.nav_models,
            R.drawable.ic_nav_analysis to R.string.nav_analysis
        )
        slots = entries.mapIndexed { index, (icon, label) ->
            slot(icon, label, index, density).also { addView(it, LayoutParams(0, LayoutParams.MATCH_PARENT, 1f)) }
        }
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        val radius = h / 2f
        val density = resources.displayMetrics.density
        background = GradientDrawable().apply {
            cornerRadius = radius
            setColor(android.graphics.Color.TRANSPARENT)
            setStroke((1f * density).toInt().coerceAtLeast(1), if (night) 0x40FFFFFF else 0xE6FFFFFF.toInt())
        }
        HyperOsGlass.attachCapsule(this, radius)
        invalidate()
    }

    private var selectedIndex = 0
    private var highlightX = 0f
    private var shown = true
    private var slide: ValueAnimator? = null
    private val highlight = GradientDrawable()

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        HyperOsGlass.attachCapsule(this, height / 2f)
        applyColors(selectedIndex)
    }

    override fun dispatchDraw(canvas: Canvas) {
        if (slots.isNotEmpty() && width > 0) {
            val span = (width - paddingLeft - paddingRight).toFloat()
            val slot = span / slots.size
            val top = paddingTop.toFloat()
            val bottom = (height - paddingBottom).toFloat()
            highlight.cornerRadius = (bottom - top) / 2f
            highlight.setColor(if (night) 0x38FFFFFF else 0xB8FFFFFF.toInt())
            val left = paddingLeft + highlightX * slot
            highlight.setBounds(left.toInt(), top.toInt(), (left + slot).toInt(), bottom.toInt())
            highlight.draw(canvas)
        }
        super.dispatchDraw(canvas)
    }

    fun setShown(value: Boolean) {
        if (value == shown) return
        shown = value
        val duration = motionDuration(Motion.PageMs.toLong())
        animate().cancel()
        if (duration == 0L) {
            alpha = if (value) 1f else 0f
            translationY = if (value) 0f else height * 0.25f
            visibility = if (value) VISIBLE else INVISIBLE
            return
        }
        if (value) visibility = VISIBLE
        animate()
            .alpha(if (value) 1f else 0f)
            .translationY(if (value) 0f else height * 0.25f)
            .setDuration(duration)
            .withEndAction { if (!shown) visibility = INVISIBLE }
            .start()
    }

    fun setSelected(index: Int) {
        if (index == selectedIndex && kotlin.math.abs(highlightX - index) < 0.01f) return
        val from = highlightX
        selectedIndex = index
        applyColors(index)
        slide?.cancel()
        val duration = motionDuration(Motion.CountMs.toLong())
        if (duration == 0L) {
            highlightX = index.toFloat()
            invalidate()
            return
        }
        slide = ValueAnimator.ofFloat(from, index.toFloat()).apply {
            this.duration = duration
            interpolator = PathInterpolator(0.2f, 0f, 0f, 1f)
            addUpdateListener {
                highlightX = it.animatedValue as Float
                invalidate()
            }
            start()
        }
    }

    private fun applyColors(index: Int) {
        val selectedColor = if (night) 0xFFF5F5F7.toInt() else 0xFF2563EB.toInt()
        val idleColor = if (night) 0xFFAEAEB2.toInt() else 0xFF5B626D.toInt()
        slots.forEachIndexed { slot, view ->
            view.background = null
            val color = if (slot == index) selectedColor else idleColor
            tint(view, color)
            (view.getChildAt(1) as TextView).paint.isFakeBoldText = slot == index
        }
    }

    private fun tint(view: LinearLayout, color: Int) {
        val icon = view.getChildAt(0) as ImageView
        val label = view.getChildAt(1) as TextView
        val from = label.currentTextColor
        val duration = motionDuration(Motion.FadeMs.toLong())
        if (duration == 0L || from == color) {
            icon.setColorFilter(color)
            label.setTextColor(color)
            return
        }
        ValueAnimator.ofArgb(from, color).apply {
            this.duration = duration
            addUpdateListener {
                val next = it.animatedValue as Int
                icon.setColorFilter(next)
                label.setTextColor(next)
            }
            start()
        }
    }

    private fun motionDuration(ms: Long): Long {
        val scale = Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
        return if (scale <= 0f) 0L else (ms * scale).toLong()
    }

    private fun slot(icon: Int, label: Int, index: Int, density: Float): LinearLayout {
        return LinearLayout(context).apply {
            orientation = VERTICAL
            gravity = Gravity.CENTER
            val horizontal = (2f * density).toInt()
            setPadding(horizontal, 0, horizontal, 0)
            addView(ImageView(context).apply {
                setImageResource(icon)
                layoutParams = LayoutParams((22f * density).toInt(), (22f * density).toInt())
            })
            addView(TextView(context).apply {
                text = context.getString(label)
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
                gravity = Gravity.CENTER
                maxLines = 1
                ellipsize = TextUtils.TruncateAt.END
                layoutParams = LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply {
                    topMargin = (2f * density).toInt()
                }
            })
            setOnClickListener { onSelect?.invoke(index) }
        }
    }
}
