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

private final class ManualScheduler: WatchScheduling {
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
