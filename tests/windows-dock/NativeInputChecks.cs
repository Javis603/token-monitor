using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

class NativeInputChecks {
    delegate IntPtr WindowProc(IntPtr hwnd, uint message, UIntPtr wparam, IntPtr lparam);
    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    [return: MarshalAs(UnmanagedType.Bool)]
    delegate bool InstallInput(IntPtr hwnd);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct WindowClass {
        public uint size, style;
        public WindowProc proc;
        public int clsExtra, winExtra;
        public IntPtr instance, icon, cursor, background;
        public string menu, name;
        public IntPtr smallIcon;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr LoadLibraryW(string path);
    [DllImport("kernel32.dll", CharSet = CharSet.Ansi)] static extern IntPtr GetProcAddress(IntPtr module, string name);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern ushort RegisterClassExW(ref WindowClass data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateWindowExW(uint ex, string cls, string name, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr data);
    [DllImport("user32.dll")] static extern IntPtr DefWindowProcW(IntPtr hwnd, uint message, UIntPtr wparam, IntPtr lparam);
    [DllImport("user32.dll")] static extern IntPtr SendMessageW(IntPtr hwnd, uint message, UIntPtr wparam, IntPtr lparam);
    [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr hwnd);
    static readonly WindowProc callback = Proc;
    static int activationCalls, messageCalls, destroyCalls;
    static IntPtr Proc(IntPtr hwnd, uint message, UIntPtr wparam, IntPtr lparam) {
        if (message == 0x21) { activationCalls++; return new IntPtr(4); }
        if (message == 0x8001) { messageCalls++; return new IntPtr(-123); }
        if (message == 0x82) destroyCalls++;
        return DefWindowProcW(hwnd, message, wparam, lparam);
    }
    static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    static int Main(string[] args) {
        try {
            IntPtr module = LoadLibraryW(args[0]);
            Check(module != IntPtr.Zero, "Cannot load native input DLL");
            IntPtr address = GetProcAddress(module, "TokenMonitorInstallNonActivatingInput");
            Check(address != IntPtr.Zero, "Missing native install export");
            var install = (InstallInput)Marshal.GetDelegateForFunctionPointer(address, typeof(InstallInput));
            var instance = Marshal.GetHINSTANCE(typeof(NativeInputChecks).Module);
            string name = "TokenMonitorInputChecks" + Process.GetCurrentProcess().Id;
            var cls = new WindowClass { size = (uint)Marshal.SizeOf(typeof(WindowClass)), proc = callback, instance = instance, name = name };
            Check(RegisterClassExW(ref cls) != 0, "Cannot register test window");
            for (int i = 0; i < 10; i++) {
                IntPtr hwnd = CreateWindowExW(0x08000000, name, "", 0x80000000, 0, 0, 100, 100, IntPtr.Zero, IntPtr.Zero, instance, IntPtr.Zero);
                Check(hwnd != IntPtr.Zero, "Cannot create test window");
                try {
                    Check(install(hwnd) && install(hwnd), "Input installation failed");
                    Check(SendMessageW(hwnd, 0x21, UIntPtr.Zero, IntPtr.Zero).ToInt64() == 3, "Activation must retain the press without activating");
                    Check(SendMessageW(hwnd, 0x8001, UIntPtr.Zero, IntPtr.Zero).ToInt64() == -123, "Other messages must retain their signed native result");
                } finally { DestroyWindow(hwnd); }
            }
            Check(activationCalls == 0, "Activation reached the click-eating original handler");
            Check(messageCalls == 10 && destroyCalls == 10, "Subclass chain duplicated or lost messages");
            Console.WriteLine("10 native windows: activation, chaining, repeated installation and destruction passed");
            return 0;
        } catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }
}
