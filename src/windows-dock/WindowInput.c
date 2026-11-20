#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <commctrl.h>

// Keep the whole subclass chain on the Windows UI stack. Calling
// DefSubclassProc through an FFI stack can re-enter Electron's move/resize
// events and run V8 garbage collection on that foreign stack.
static LRESULT CALLBACK NonActivatingProc(HWND hwnd, UINT message,
    WPARAM wparam, LPARAM lparam, UINT_PTR id, DWORD_PTR data) {
    (void)data;
    if (message == WM_MOUSEACTIVATE) return MA_NOACTIVATE;
    if (message == WM_NCDESTROY) RemoveWindowSubclass(hwnd, NonActivatingProc, id);
    return DefSubclassProc(hwnd, message, wparam, lparam);
}

__declspec(dllexport) BOOL WINAPI TokenMonitorInstallNonActivatingInput(HWND hwnd) {
    return SetWindowSubclass(hwnd, NonActivatingProc, 1, 0);
}
