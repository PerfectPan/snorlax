import XCTest
import SnorlaxKit

final class LaunchSequenceTests: XCTestCase {
    func testSnapshotLoadsAndTheWatcherStartsWhileDiscoveryBlocks() async throws {
        let temp = try TempDirectory()
        defer { temp.remove() }
        let scheduler = ManualScheduler()
        let watcher = SnapshotWatcher(scheduler: scheduler)
        let reloads = Counter()
        let fallbacks = Counter()
        watcher.setHandler { fallbacks.increment() }
        // Discovery signals once it started and then stays blocked: this is
        // the stuck login shell the launch order must survive.
        let entered = DispatchSemaphore(value: 0)
        let release = DispatchSemaphore(value: 0)
        let run = Task.detached {
            LaunchSequence.run(
                dataDirectory: temp.url,
                watcher: watcher,
                reloadSnapshot: { reloads.increment() },
                discover: {
                    entered.signal()
                    _ = release.wait(timeout: .now() + 10)
                    return .missing
                },
                onDiscovery: { _, _ in }
            )
        }
        XCTAssert(entered.wait(timeout: .now() + 10) == .success, "discovery should have started")

        XCTAssertEqual(reloads.current, 1, "the snapshot must load before discovery finishes")
        scheduler.advance(milliseconds: 60_000)
        XCTAssertEqual(fallbacks.current, 1, "the fallback poll must run before discovery finishes")

        release.signal()
        await run.value
    }
}

private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0

    func increment() {
        lock.lock()
        value += 1
        lock.unlock()
    }

    var current: Int {
        lock.lock()
        defer { lock.unlock() }
        return value
    }
}
