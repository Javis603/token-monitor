'use strict';

let probe = null;

function loadProbe() {
  if (probe !== null) return probe;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const rect = koffi.struct('TM_AUTOHIDE_RECT', {
      left: 'int32_t', top: 'int32_t', right: 'int32_t', bottom: 'int32_t'
    });
    const monitorInfo = koffi.struct('TM_AUTOHIDE_MONITORINFO', {
      cbSize: 'uint32_t', rcMonitor: rect, rcWork: rect, dwFlags: 'uint32_t'
    });
    probe = {
      GetForegroundWindow: user32.func('void * __stdcall GetForegroundWindow()'),
      GetWindowThreadProcessId: user32.func('uint32_t __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32_t *pid)'),
      GetWindowRect: user32.func('bool __stdcall GetWindowRect(void *hwnd, _Out_ TM_AUTOHIDE_RECT *rect)'),
      MonitorFromWindow: user32.func('void * __stdcall MonitorFromWindow(void *hwnd, uint32_t flags)'),
      GetMonitorInfo: user32.func('bool __stdcall GetMonitorInfoW(void *monitor, _Inout_ TM_AUTOHIDE_MONITORINFO *info)'),
      monitorInfoSize: koffi.sizeof(monitorInfo)
    };
  } catch {
    probe = false;
  }
  return probe;
}

function isOtherAppFullscreen(dockedBounds) {
  if (process.platform !== 'win32') return false;
  const api = loadProbe();
  if (!api) return false;
  try {
    const hwnd = api.GetForegroundWindow();
    if (!hwnd) return false;
    const pid = [0];
    api.GetWindowThreadProcessId(hwnd, pid);
    if (pid[0] === process.pid) return false;
    const bounds = {};
    if (!api.GetWindowRect(hwnd, bounds)) return false;
    const monitor = api.MonitorFromWindow(hwnd, 2);
    if (!monitor) return false;
    const info = { cbSize: api.monitorInfoSize };
    if (!api.GetMonitorInfo(monitor, info)) return false;
    const screen = info.rcMonitor;
    if (!dockedBounds || Math.abs(screen.left - dockedBounds.x) > 2
      || Math.abs(screen.top - dockedBounds.y) > 2
      || Math.abs(screen.right - dockedBounds.x - dockedBounds.width) > 2
      || Math.abs(screen.bottom - dockedBounds.y - dockedBounds.height) > 2) return false;
    return bounds.left <= screen.left + 2 && bounds.top <= screen.top + 2
      && bounds.right >= screen.right - 2 && bounds.bottom >= screen.bottom - 2;
  } catch {
    return false;
  }
}

module.exports = { isOtherAppFullscreen };
