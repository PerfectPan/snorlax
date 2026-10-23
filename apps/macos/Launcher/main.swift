import Darwin
import Foundation
import SnorlaxKit

// Compiled launcher (plan 3.11): picks Node the same way the previous /bin/sh
// script did, then replaces this process with `node <collector> <arguments…>` so
// launchd sees one short-lived process. Never searches PATH or a login shell.

let fileSystem = LauncherNode.FileSystem()
let home = FileManager.default.homeDirectoryForCurrentUser
let dataDirectory = DataDirectory.resolve(environment: ProcessInfo.processInfo.environment, home: home)

guard let node = LauncherNode.resolve(dataDirectory: dataDirectory, fileSystem: fileSystem) else {
    FileHandle.standardError.write(Data((LauncherNode.missingNodeMessage + "\n").utf8))
    exit(1)
}

let collector = LauncherNode.collectorPath(executablePath: currentExecutablePath())
guard fileSystem.fileExists(collector) else {
    FileHandle.standardError.write(Data("snorlax: bundled collector is missing at \(collector)\n".utf8))
    exit(1)
}

var arguments = [node, collector] + CommandLine.arguments.dropFirst()
var pointers: [UnsafeMutablePointer<CChar>?] = arguments.map { strdup($0) } + [nil]
let status = pointers.withUnsafeMutableBufferPointer { buffer in
    execv(arguments[0], buffer.baseAddress)
}
// `execv` only returns when it failed.
FileHandle.standardError.write(Data("snorlax: cannot exec \(node) (status \(status))\n".utf8))
exit(127)

/// Absolute path of this process's own executable, asked from the kernel so the
/// working directory and `argv[0]` do not matter.
private func currentExecutablePath() -> String {
    var size: UInt32 = 0
    _NSGetExecutablePath(nil, &size)
    var buffer = [CChar](repeating: 0, count: Int(size))
    guard _NSGetExecutablePath(&buffer, &size) == 0, let path = String(validatingUTF8: buffer) else {
        return CommandLine.arguments.first ?? ""
    }
    return path
}
