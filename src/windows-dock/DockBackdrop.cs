using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Numerics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using Windows.UI.Composition;

[ComImport, Guid("29E691FA-4567-4DCA-B319-D0F207EB6807"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IDesktopCompositorInterop {
    void CreateDesktopWindowTarget(IntPtr hwnd, bool topmost, out IntPtr target);
}

// One STA/compositor for every dock surface. Only this thread touches visuals;
// stdin is a private parent pipe, and EOF or parent exit removes every HWND.
class DockBackdrop {
    delegate IntPtr WindowProc(IntPtr hwnd, uint message, UIntPtr wparam, IntPtr lparam);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct WindowClass {
        public uint size, style;
        public WindowProc proc;
        public int clsExtra, winExtra;
        public IntPtr instance, icon, cursor, background;
        public string menu, name;
        public IntPtr smallIcon;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct Message {
        public IntPtr hwnd; public uint message; public UIntPtr wparam; public IntPtr lparam;
        public uint time; public int x, y; public uint extra;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct QueueOptions { public int size, thread, apartment; }
    [StructLayout(LayoutKind.Sequential)]
    struct Rect { public int left, top, right, bottom; }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern ushort RegisterClassExW(ref WindowClass data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateWindowExW(uint ex, string cls, string name, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr data);
    [DllImport("user32.dll")] static extern IntPtr DefWindowProcW(IntPtr hwnd, uint message, UIntPtr wparam, IntPtr lparam);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool EnableWindow(IntPtr hwnd, bool enable);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll")] static extern int GetMessageW(out Message message, IntPtr hwnd, uint min, uint max);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref Message message);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessageW(ref Message message);
    [DllImport("user32.dll")] static extern bool PostMessageW(IntPtr hwnd, uint message, UIntPtr wparam, IntPtr lparam);
    [DllImport("user32.dll")] static extern void PostQuitMessage(int code);
    [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern UIntPtr SetTimer(IntPtr hwnd, UIntPtr id, uint delay, IntPtr proc);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);
    [DllImport("CoreMessaging.dll")] static extern int CreateDispatcherQueueController(QueueOptions options, out IntPtr controller);

    public class Command {
        public string op { get; set; }
        public string id { get; set; }
        public string hwnd { get; set; }
        public string shapeKey { get; set; }
        public int x { get; set; }
        public int y { get; set; }
        public int width { get; set; }
        public int height { get; set; }
        public float opacity { get; set; }
        public object[][] commands { get; set; }
    }

    sealed class Surface : IDisposable {
        public IntPtr hwnd, owner;
        CompositionTarget target;
        ContainerVisual root;
        SpriteVisual visual;
        CompositionBrush brush;
        CompositionGeometricClip clip;
        CompositionPathGeometry path;
        NativeCurveGeometry geometry;
        string shapeKey;

        public Surface(Command command) {
            owner = new IntPtr(long.Parse(command.hwnd));
            // No redirection bitmap: transparent pixels belong to the desktop.
            // TOOLWINDOW/NOACTIVATE/TRANSPARENT keep this underlay out of input,
            // Alt-Tab and the taskbar. HWND material APIs must NOT be added here.
            hwnd = CreateWindowExW(0x00200000 | 0x08000000 | 0x80 | 0x20 | 0x8,
                ClassName, "Token Monitor Dock Backdrop", 0x80000000,
                command.x, command.y, command.width, command.height,
                IntPtr.Zero, IntPtr.Zero, instance, IntPtr.Zero);
            if (hwnd == IntPtr.Zero) throw new Exception("Cannot create backdrop window");
            EnableWindow(hwnd, false);
            try {
                int enabled = 1;
                Marshal.ThrowExceptionForHR(DwmSetWindowAttribute(hwnd, 17, ref enabled, 4));
                IntPtr raw;
                ((IDesktopCompositorInterop)(object)compositor).CreateDesktopWindowTarget(hwnd, true, out raw);
                try { target = (CompositionTarget)Marshal.GetObjectForIUnknown(raw); }
                finally { Marshal.Release(raw); }
                root = compositor.CreateContainerVisual();
                root.Opacity = 0;
                brush = compositor.CreateHostBackdropBrush();
                visual = compositor.CreateSpriteVisual();
                visual.Brush = brush;
                visual.BorderMode = CompositionBorderMode.Soft;
                root.Children.InsertAtTop(visual);
                target.Root = root;
            } catch { Dispose(); throw; }
        }

        public void Update(Command command) {
            if (!IsWindow(owner)) throw new Exception("Dock content window no longer exists");
            // Electron's DIP round-trip can add 1–2 physical pixels, especially
            // on small cards at 125/150% DPI. Follow the real content HWND, not
            // a second conversion of its already-rounded getBounds() result.
            Rect bounds;
            if (!GetWindowRect(owner, out bounds)) throw new Exception("Cannot read dock window bounds");
            int width = bounds.right - bounds.left, height = bounds.bottom - bounds.top;
            var size = new Vector2(width, height);
            if (shapeKey != command.shapeKey) {
                var nextGeometry = new NativeCurveGeometry(command.commands);
                CompositionPathGeometry nextPath = null;
                CompositionGeometricClip nextClip = null;
                try {
                    nextPath = compositor.CreatePathGeometry(new CompositionPath(nextGeometry));
                    nextClip = compositor.CreateGeometricClip(nextPath);
                    visual.Clip = nextClip;
                } catch {
                    if (nextClip != null) nextClip.Dispose();
                    if (nextPath != null) nextPath.Dispose();
                    nextGeometry.Dispose();
                    throw;
                }
                if (clip != null) clip.Dispose();
                if (path != null) path.Dispose();
                if (geometry != null) geometry.Dispose();
                geometry = nextGeometry; path = nextPath; clip = nextClip;
                shapeKey = command.shapeKey;
            }
            if (root.Size != size) { root.Size = size; visual.Size = size; }
            var opacity = Math.Max(0, Math.Min(1, command.opacity));
            if (root.Opacity != opacity) root.Opacity = opacity;
            // Position directly BELOW its own Electron surface, never above the
            // text or another surface that is already above that content HWND.
            Rect previous;
            bool moved = !GetWindowRect(hwnd, out previous) || previous.left != bounds.left
                || previous.top != bounds.top || previous.right != bounds.right || previous.bottom != bounds.bottom;
            bool visible = IsWindowVisible(hwnd);
            bool wanted = opacity > 0 && IsWindowVisible(owner);
            bool reorder = wanted && GetWindow(hwnd, 3) != owner; // GW_HWNDPREV
            if (moved || visible != wanted || reorder) {
                uint flags = 0x10 | 0x200; // NOACTIVATE | NOOWNERZORDER
                if (!moved) flags |= 0x3; // NOMOVE | NOSIZE
                if (!reorder) flags |= 0x4; // NOZORDER
                if (visible != wanted) flags |= wanted ? 0x40u : 0x80u;
                // Showing and ordering are one transaction. Re-showing an
                // already-visible HostBackdrop on each fade/hover update can
                // expose an intermediate compositor frame above its content.
                if (!SetWindowPos(hwnd, owner, bounds.left, bounds.top, width, height, flags))
                    throw new Exception("Cannot position backdrop window");
            }
        }

        // A stalled parent must not leave detached glass at a previous position.
        public bool OwnerExists() { return IsWindow(owner); }
        public void HideIfDetached() {
            if (!IsWindowVisible(hwnd)) return;
            Rect a, b;
            if (!IsWindowVisible(owner) || !GetWindowRect(owner, out a) || !GetWindowRect(hwnd, out b)
                || a.left != b.left || a.top != b.top || a.right != b.right || a.bottom != b.bottom)
                ShowWindow(hwnd, 0);
        }
        public void Dispose() {
            if (hwnd != IntPtr.Zero) { ShowWindow(hwnd, 0); DestroyWindow(hwnd); hwnd = IntPtr.Zero; }
            if (target != null) { target.Root = null; target.Dispose(); target = null; }
            if (visual != null) { visual.Clip = null; visual.Dispose(); visual = null; }
            if (clip != null) { clip.Dispose(); clip = null; }
            if (path != null) { path.Dispose(); path = null; }
            if (geometry != null) { geometry.Dispose(); geometry = null; }
            if (brush != null) { brush.Dispose(); brush = null; }
            if (root != null) { root.Dispose(); root = null; }
        }
    }

    const string ClassName = "TokenMonitorDockBackdrop";
    const uint UpdateMessage = 0x8001, EndMessage = 0x8002;
    static readonly WindowProc callback = Proc;
    static readonly ConcurrentQueue<string> input = new ConcurrentQueue<string>();
    static readonly Dictionary<string, Surface> surfaces = new Dictionary<string, Surface>();
    static readonly JavaScriptSerializer json = new JavaScriptSerializer();
    static Compositor compositor;
    static IntPtr instance, host, queue;
    static Process parent;

    static void Report(object message) { Console.WriteLine(json.Serialize(message)); Console.Out.Flush(); }
    static void Apply(string line) {
        var command = json.Deserialize<Command>(line);
        if (command.op == "dispose") {
            Surface old;
            if (surfaces.TryGetValue(command.id, out old)) { surfaces.Remove(command.id); old.Dispose(); }
            return;
        }
        if (command.op != "update" || command.width <= 0 || command.height <= 0
            || command.width > 32768 || command.height > 32768 || command.commands == null
            || String.IsNullOrEmpty(command.shapeKey)) throw new Exception("Invalid backdrop update");
        Surface surface;
        bool created = !surfaces.TryGetValue(command.id, out surface);
        if (created) { surface = new Surface(command); surfaces.Add(command.id, surface); }
        surface.Update(command);
        if (created) Report(new { type = "attached", id = command.id, hwnd = surface.hwnd.ToInt64().ToString() });
    }

    static IntPtr Proc(IntPtr hwnd, uint message, UIntPtr wparam, IntPtr lparam) {
        try {
            if (message == 0x84) return new IntPtr(-1); // HTTRANSPARENT
            if (message == 0x21) return new IntPtr(3);  // MA_NOACTIVATE
            if (message == UpdateMessage) {
                string line;
                while (input.TryDequeue(out line)) Apply(line);
                return IntPtr.Zero;
            }
            if (message == EndMessage) { PostQuitMessage(0); return IntPtr.Zero; }
            if (message == 0x113) {
                if (parent.HasExited) PostQuitMessage(0);
                foreach (var id in new List<string>(surfaces.Keys)) {
                    var surface = surfaces[id];
                    if (!surface.OwnerExists()) { surfaces.Remove(id); surface.Dispose(); }
                    else surface.HideIfDetached();
                }
                return IntPtr.Zero;
            }
            return DefWindowProcW(hwnd, message, wparam, lparam);
        } catch (Exception error) {
            try { Report(new { type = "error", message = error.Message }); } catch { }
            PostQuitMessage(1);
            return IntPtr.Zero;
        }
    }

    [STAThread] static int Main(string[] args) {
        try {
            Console.SetOut(new StreamWriter(Console.OpenStandardOutput()) { AutoFlush = true });
            parent = Process.GetProcessById(int.Parse(args[0]));
            SetProcessDpiAwarenessContext(new IntPtr(-4));
            Marshal.ThrowExceptionForHR(CreateDispatcherQueueController(new QueueOptions { size = 12, thread = 2, apartment = 2 }, out queue));
            compositor = new Compositor();
            instance = Marshal.GetHINSTANCE(typeof(DockBackdrop).Module);
            var cls = new WindowClass { name = ClassName, size = (uint)Marshal.SizeOf(typeof(WindowClass)), proc = callback, instance = instance };
            if (RegisterClassExW(ref cls) == 0) throw new Exception("Cannot register backdrop window class");
            host = CreateWindowExW(0, ClassName, "", 0, 0, 0, 0, 0, new IntPtr(-3), IntPtr.Zero, instance, IntPtr.Zero);
            if (host == IntPtr.Zero) throw new Exception("Cannot create backdrop message window");
            SetTimer(host, new UIntPtr(1), 500, IntPtr.Zero);
            var reader = new Thread(() => {
                try {
                    using (var stream = new StreamReader(Console.OpenStandardInput())) {
                        string line;
                        while ((line = stream.ReadLine()) != null) {
                            if (line.Length > 65536) break;
                            input.Enqueue(line);
                            if (!PostMessageW(host, UpdateMessage, UIntPtr.Zero, IntPtr.Zero)) break;
                        }
                    }
                } catch { }
                PostMessageW(host, EndMessage, UIntPtr.Zero, IntPtr.Zero);
            });
            reader.IsBackground = true;
            reader.Start();
            Report(new { type = "ready", protocol = 1 });
            Message message;
            while (GetMessageW(out message, IntPtr.Zero, 0, 0) > 0) {
                TranslateMessage(ref message); DispatchMessageW(ref message);
            }
            return (int)message.wparam.ToUInt64();
        } catch (Exception error) {
            try { Report(new { type = "error", message = error.Message }); } catch { }
            return 1;
        } finally {
            foreach (var surface in surfaces.Values) surface.Dispose();
            if (host != IntPtr.Zero) DestroyWindow(host);
            if (compositor != null) compositor.Dispose();
            if (queue != IntPtr.Zero) Marshal.Release(queue);
            if (parent != null) parent.Dispose();
        }
    }
}
