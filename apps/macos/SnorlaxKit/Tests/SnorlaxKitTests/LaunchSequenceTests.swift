import XCTest
import SnorlaxKit

final class LaunchSequenceTests: XCTestCase {
    func testSnapshotLoadsAndTheWatcherStartsWhileDiscoveryBlocks() throws {
        let temp = try TempDirectory()
        defer { temp.remove() }
        let scheduler = ManualScheduler()
        let watcher = SnapshotWatcher(scheduler: scheduler)
        var reloads = 0
        var fallbacks = 0
        watcher.setHandler { fallbacks += 1 }
        // Discovery stays blocked for the whole check: this is the stuck
        // login shell the launch order must survive.
        let blocked = DispatchSemaphore(value: 0)
        LaunchSequence.run(
            dataDirectory: temp.url,
            watcher: watcher,
            reloadSnapshot: { reloads += 1 },
            discover: {
                _ = blocked.wait(timeout: .now() + 10)
                return .missing
            },
            onDiscovery: { _, _ in }
        )

        XCTAssertEqual(reloads, 1, "the snapshot must load before discovery finishes")
        scheduler.advance(milliseconds: 60_000)
        XCTAssertEqual(fallbacks, 1, "the fallback poll must run before discovery finishes")
    }
}
