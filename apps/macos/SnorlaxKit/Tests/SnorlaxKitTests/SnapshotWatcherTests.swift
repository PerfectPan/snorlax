import XCTest
import SnorlaxKit

final class SnapshotWatcherTests: XCTestCase {
    func testDebounceConstants() {
        XCTAssertEqual(Milliseconds.of(SnapshotWatcher.debounce), 200)
        XCTAssertEqual(Milliseconds.of(SnapshotWatcher.fallbackInterval), 60_000)
    }

    func testDirectoryEventsCollapseInsideTheDebounceWindow() {
        let scheduler = ManualScheduler()
        var calls = 0
        let watcher = SnapshotWatcher(scheduler: scheduler) { calls += 1 }

        watcher.noteDirectoryEvent()
        scheduler.advance(milliseconds: 199)
        XCTAssertEqual(calls, 0)
        scheduler.advance(milliseconds: 1)
        XCTAssertEqual(calls, 1)

        watcher.noteDirectoryEvent()
        watcher.noteDirectoryEvent()
        scheduler.advance(milliseconds: 200)
        XCTAssertEqual(calls, 2)
    }

    func testFallbackTimerFiresWithoutADirectoryEvent() {
        let scheduler = ManualScheduler()
        var calls = 0
        let watcher = SnapshotWatcher(scheduler: scheduler) { calls += 1 }
        watcher.startFallback()

        scheduler.advance(milliseconds: 59_999)
        XCTAssertEqual(calls, 0)
        scheduler.advance(milliseconds: 1)
        XCTAssertEqual(calls, 1)
        scheduler.advance(milliseconds: 60_000)
        XCTAssertEqual(calls, 2)
    }
}
