import Foundation
import XCTest
import SnorlaxKit

enum Fixtures {
    static let directory: URL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .appendingPathComponent("packages/protocol/fixtures")

    static func data(_ name: String) throws -> Data {
        try Data(contentsOf: directory.appendingPathComponent(name).appendingPathExtension("json"))
    }
}

struct TempDirectory {
    let url: URL

    init() throws {
        url = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("snorlax-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    }

    func remove() {
        try? FileManager.default.removeItem(at: url)
    }

    func writeExecutable(named name: String, contents: String) throws -> URL {
        let file = url.appendingPathComponent(name)
        try Data(contents.utf8).write(to: file)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path)
        return file
    }
}

enum Milliseconds {
    static func of(_ duration: Duration) -> Int {
        let parts = duration.components
        return Int(parts.seconds) * 1000 + Int(parts.attoseconds / 1_000_000_000_000_000)
    }
}

/// Injected watch clock shared by the watcher and launch-order tests.
final class ManualScheduler: WatchScheduling {
    final class Token: WatchCanceling {
        var cancelled = false
        func cancel() { cancelled = true }
    }

    private struct Item {
        var token: Token
        var due: Int
        var every: Int?
        var execute: () -> Void
    }

    private var now = 0
    private var items: [Item] = []

    func schedule(after delay: Duration, execute: @escaping () -> Void) -> any WatchCanceling {
        let token = Token()
        items.append(Item(token: token, due: now + Milliseconds.of(delay), every: nil, execute: execute))
        return token
    }

    func scheduleRepeating(every interval: Duration, execute: @escaping () -> Void) -> any WatchCanceling {
        let token = Token()
        let ms = Milliseconds.of(interval)
        items.append(Item(token: token, due: now + ms, every: ms, execute: execute))
        return token
    }

    func advance(milliseconds: Int) {
        let target = now + milliseconds
        while true {
            guard let index = items.indices
                .filter({ !items[$0].token.cancelled && items[$0].due <= target })
                .min(by: { items[$0].due < items[$1].due })
            else { break }
            let item = items[index]
            now = item.due
            guard !item.token.cancelled else { continue }
            item.execute()
            if item.token.cancelled {
                items.removeAll { $0.token === item.token }
                continue
            }
            if let every = item.every, let current = items.firstIndex(where: { $0.token === item.token }) {
                items[current].due = now + every
            } else {
                items.removeAll { $0.token === item.token }
            }
        }
        now = target
    }
}
