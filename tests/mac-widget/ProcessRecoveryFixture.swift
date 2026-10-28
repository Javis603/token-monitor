// Appended to the production helper's process functions by the Node test.
// Every process syscall is substituted; this executable cannot signal a real PID.
let scenario = CommandLine.arguments[1]
let targetPath = "/fixture/TokenMonitorWidget"
var lookups = 0
var signals = 0
var exited = scenario == "already-exited"
var fixtureTime: Double = 0

func failing(_ kind: String) -> Bool {
    (scenario == "probe-denied" && kind == "paths")
        || scenario == "\(kind)-fail-scan"
        || (scenario == "\(kind)-fail-recheck" && lookups >= 2)
        || (scenario == "\(kind)-fail-wait" && lookups >= 3)
}

func fixture_proc_listpids(_ type: UInt32, _ uid: UInt32,
                          _ buffer: UnsafeMutableRawPointer?, _ size: Int32) -> Int32 {
    buffer?.storeBytes(of: pid_t(Int32.max), as: pid_t.self)
    return Int32(MemoryLayout<pid_t>.size)
}

func fixture_proc_pidinfo(_ pid: Int32, _ flavor: Int32, _ arg: UInt64,
                         _ buffer: UnsafeMutableRawPointer, _ size: Int32) -> Int32 {
    lookups += 1
    if exited || failing("info") {
        errno = exited ? ESRCH : EACCES
        return 0
    }
    var info = proc_bsdinfo()
    info.pbi_uid = scenario == "foreign-owner" ? getuid() + 1 : getuid()
    info.pbi_start_tvsec = scenario == "pid-reused" && lookups >= 2 ? 2 : 1
    buffer.storeBytes(of: info, as: proc_bsdinfo.self)
    return size
}

func fixture_proc_pidpath(_ pid: Int32, _ buffer: UnsafeMutableRawPointer,
                         _ size: UInt32) -> Int32 {
    if failing("paths") || scenario.hasSuffix("fallback") {
        errno = EIO
        return 0
    }
    let currentPath = ["renamed-path", "launch-fail"].contains(scenario) ? "/old/TokenMonitorWidget" : targetPath
    return currentPath.withCString { source in
        strcpy(buffer.assumingMemoryBound(to: CChar.self), source)
        return Int32(strlen(source))
    }
}

func fixture_sysctl(_ name: UnsafeMutablePointer<Int32>, _ count: UInt32,
                    _ buffer: UnsafeMutableRawPointer?, _ size: UnsafeMutablePointer<Int>,
                    _ newValue: UnsafeMutableRawPointer?, _ newSize: Int) -> Int32 {
    if failing("paths") || scenario == "launch-fail" { errno = EIO; return -1 }
    let originalPath = scenario == "unrelated-fallback" ? "/other/TokenMonitorWidget" : targetPath
    // An unrelated executable can spoof argv[0]; only the kernel's first path
    // field should be used for matching.
    let paths = Array((originalPath + "\0\0" + targetPath + "\0").utf8)
    size.pointee = MemoryLayout<Int32>.size + paths.count
    if let buffer = buffer {
        buffer.storeBytes(of: Int32(1), as: Int32.self)
        paths.withUnsafeBytes { bytes in
            buffer.advanced(by: MemoryLayout<Int32>.size).copyMemory(from: bytes.baseAddress!, byteCount: paths.count)
        }
    }
    return 0
}

func fixture_kill(_ pid: pid_t, _ signal: Int32) -> Int32 {
    if signal == 0 {
        if scenario == "probe-denied" { errno = EPERM; return -1 }
        if exited { errno = ESRCH; return -1 }
        return 0
    }
    precondition(signal == SIGTERM, "recovery must not escalate to SIGKILL")
    signals += 1
    if scenario == "signal-denied" { errno = EPERM; return -1 }
    if scenario == "signal-exited" { exited = true; errno = ESRCH; return -1 }
    if !scenario.hasSuffix("fail-wait") && scenario != "still-running" { exited = true }
    return 0
}

func fixture_usleep(_ duration: UInt32) -> Int32 {
    fixtureTime += Double(duration) / 1_000_000
    return 0
}

let recovered = stopResidentWidgetProcesses(executablePath: targetPath)
print("signals=\(signals)")
exit(recovered ? EXIT_SUCCESS : EXIT_FAILURE)
