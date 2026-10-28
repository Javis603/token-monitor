import CoreServices
import Darwin
import Foundation
import WidgetKit

private func containingHostURL() -> URL? {
    let executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
        .standardizedFileURL
        .resolvingSymlinksInPath()
    let resourcesURL = executableURL.deletingLastPathComponent()
    let contentsURL = resourcesURL.deletingLastPathComponent()
    let hostAppURL = contentsURL.deletingLastPathComponent()

    guard
        resourcesURL.lastPathComponent == "Resources",
        contentsURL.lastPathComponent == "Contents",
        hostAppURL.pathExtension == "app"
    else {
        return nil
    }

    return hostAppURL
}

private func registerContainingHost() -> Never {
    guard let hostAppURL = containingHostURL() else { exit(EXIT_FAILURE) }
    let status = LSRegisterURL(hostAppURL as CFURL, true)
    exit(status == noErr ? EXIT_SUCCESS : EXIT_FAILURE)
}

private struct WidgetProcess: Equatable {
    let pid: pid_t
    let startedSeconds: UInt64
    let startedMicroseconds: UInt64
}

private func launchExecutablePath(_ pid: pid_t) -> String? {
    var query: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
    var size = 0
    guard
        sysctl(&query, UInt32(query.count), nil, &size, nil, 0) == 0,
        size > MemoryLayout<Int32>.size,
        size <= 4 * 1024 * 1024
    else { return nil }
    var bytes = [UInt8](repeating: 0, count: size)
    guard
        sysctl(&query, UInt32(query.count), &bytes, &size, nil, 0) == 0,
        size > MemoryLayout<Int32>.size,
        size <= bytes.count
    else { return nil }
    // KERN_PROCARGS2 begins with argc, then the kernel's original executable
    // path. Read only that first field; argv (including argv[0]) and env are
    // neither searched nor logged. The original path survives updater renames.
    let start = MemoryLayout<Int32>.size
    guard let end = bytes[start..<size].firstIndex(of: 0), end > start,
          let path = String(bytes: bytes[start..<end], encoding: .utf8),
          path.hasPrefix("/") else { return nil }
    return URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath().path
}

private enum WidgetProcessLookupError: Error {
    case unavailable
}

private func processHasExited(_ pid: pid_t) -> Bool {
    // A failed identity query is not evidence of exit. Only ESRCH confirms it;
    // permission errors leave the process state unknown.
    kill(pid, 0) != 0 && errno == ESRCH
}

private func widgetProcess(_ pid: pid_t, executablePath: String) throws -> WidgetProcess? {
    guard pid > 0, pid != getpid() else { return nil }
    var info = proc_bsdinfo()
    let infoSize = Int32(MemoryLayout<proc_bsdinfo>.size)
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, infoSize) == infoSize else {
        if processHasExited(pid) { return nil }
        throw WidgetProcessLookupError.unavailable
    }
    guard info.pbi_uid == getuid() else { return nil }

    // PROC_PIDPATHINFO_MAXSIZE is 4 * MAXPATHLEN in the public SDK header,
    // but its expression is not imported as a Swift constant.
    var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
    var matchesCurrentPath = false
    if proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 {
        let processURL = URL(fileURLWithPath: String(cString: buffer))
            .standardizedFileURL.resolvingSymlinksInPath()
        guard processURL.lastPathComponent == "TokenMonitorWidget" else { return nil }
        matchesCurrentPath = processURL.path == executablePath
    }
    // An updated executable may no longer have a resolvable current path.
    // The launch-time path is still usable even when proc_pidpath fails.
    if !matchesCurrentPath {
        guard let originalPath = launchExecutablePath(pid) else {
            if processHasExited(pid) { return nil }
            throw WidgetProcessLookupError.unavailable
        }
        guard originalPath == executablePath else { return nil }
    }
    return WidgetProcess(
        pid: pid,
        startedSeconds: info.pbi_start_tvsec,
        startedMicroseconds: info.pbi_start_tvusec
    )
}

private func stopResidentWidgetProcesses(executablePath: String) -> Bool {
    let requiredBytes = proc_listpids(UInt32(PROC_UID_ONLY), getuid(), nil, 0)
    guard requiredBytes > 0 else { return false }
    // Leave room for processes that start between the size query and enumeration.
    var pids = [pid_t](repeating: 0, count: Int(requiredBytes) / MemoryLayout<pid_t>.size + 64)
    let capacityBytes = Int32(pids.count * MemoryLayout<pid_t>.size)
    let writtenBytes = proc_listpids(UInt32(PROC_UID_ONLY), getuid(), &pids, capacityBytes)
    guard writtenBytes > 0, writtenBytes < capacityBytes else { return false }
    do {
        let processes = try pids.prefix(Int(writtenBytes) / MemoryLayout<pid_t>.size)
            .compactMap { try widgetProcess($0, executablePath: executablePath) }

        for process in processes {
            // Recheck the path, owner and start time so a reused PID is not signalled.
            guard try widgetProcess(process.pid, executablePath: executablePath) == process else { continue }
            if kill(process.pid, SIGTERM) != 0 && errno != ESRCH { return false }
        }

        let deadline = ProcessInfo.processInfo.systemUptime + 2
        repeat {
            if try processes.allSatisfy({ try widgetProcess($0.pid, executablePath: executablePath) != $0 }) {
                return true
            }
            usleep(50_000)
        } while ProcessInfo.processInfo.systemUptime < deadline
        return false
    } catch {
        // Do not persist successful recovery when any candidate remains unknown.
        return false
    }
}

private func recoverContainingHost() -> Never {
    guard let hostAppURL = containingHostURL() else { exit(EXIT_FAILURE) }
    let executableURL = hostAppURL.appendingPathComponent(
        "Contents/PlugIns/TokenMonitorWidget.appex/Contents/MacOS/TokenMonitorWidget"
    ).standardizedFileURL.resolvingSymlinksInPath()
    guard FileManager.default.isExecutableFile(atPath: executableURL.path) else {
        exit(EXIT_FAILURE)
    }
    guard LSRegisterURL(hostAppURL as CFURL, true) == noErr else { exit(EXIT_FAILURE) }

    // Re-registering an updated app does not retire the old running extension.
    // Its archives can retain the previous bundle version and be rejected by
    // chronod. The caller holds snapshot publication during this one-time repair,
    // then resumes publication and requests new timelines afterwards.
    exit(stopResidentWidgetProcesses(executablePath: executableURL.path) ? EXIT_SUCCESS : EXIT_FAILURE)
}

if Array(CommandLine.arguments.dropFirst()) == ["--mode", "register-host"] {
    registerContainingHost()
}

if Array(CommandLine.arguments.dropFirst()) == ["--mode", "recover-host"] {
    recoverContainingHost()
}

let kind = CommandLine.arguments.dropFirst().first ?? "com.tokenmonitor.dashboard"
let kinds = [kind, "\(kind).summary", "\(kind).activity", "\(kind).breakdown", "\(kind).quota"]

if #available(macOS 14.0, *) {
    for kind in kinds {
        WidgetCenter.shared.reloadTimelines(ofKind: kind)
    }
}
