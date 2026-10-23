import XCTest
import SnorlaxKit

final class WidgetStateTests: XCTestCase {
    private let zone = TimeZone(identifier: "Asia/Shanghai")!
    /// 5 minutes after the fixture's generatedAt, 2026-10-23T02:35:12.482Z.
    private let now = UsageFormat.instant("2026-10-23T02:40:00Z")!

    func testAMissingContainerAndMissingFileAndNewerSnapshotAreDistinct() throws {
        XCTAssertEqual(
            WidgetSnapshot.state(containerURL: nil, now: now, timeZone: zone, load: { _ in
                try SnapshotLoader.load(Fixtures.data("snapshot"))
            }),
            .containerUnavailable
        )

        let temp = try TempDirectory()
        defer { temp.remove() }
        XCTAssertEqual(
            WidgetSnapshot.state(containerURL: temp.url, now: now, timeZone: zone, load: { _ in
                throw CocoaError(.fileReadNoSuchFile)
            }),
            .noSnapshot
        )

        XCTAssertEqual(
            WidgetSnapshot.state(containerURL: temp.url, now: now, timeZone: zone, load: { _ in
                throw SchemaError.newerCollector
            }),
            .newerSnapshot
        )
    }

    func testACurrentSnapshotIsUsableWithATimeOnlyCaption() throws {
        let state = WidgetSnapshot.state(containerURL: URL(fileURLWithPath: "/unused"), now: now, timeZone: zone) { _ in
            try SnapshotLoader.load(Fixtures.data("snapshot"))
        }

        guard case let .usable(usage) = state else {
            XCTFail("expected a usable snapshot, got \(state)")
            return
        }
        XCTAssertTrue(usage.isToday)
        XCTAssertEqual(usage.asOfCaption, "as of 10:35")
        XCTAssertEqual(usage.summary.menuTitle, "81.2M")
    }

    func testASnapshotFromAnotherDayIsMarkedStale() throws {
        let nextDay = UsageFormat.instant("2026-10-24T02:40:00Z")!
        let state = WidgetSnapshot.state(containerURL: URL(fileURLWithPath: "/unused"), now: nextDay, timeZone: zone) { _ in
            try SnapshotLoader.load(Fixtures.data("snapshot"))
        }

        guard case let .usable(usage) = state else {
            XCTFail("expected a usable snapshot, got \(state)")
            return
        }
        XCTAssertFalse(usage.isToday)
        XCTAssertEqual(usage.asOfCaption, "as of 10/23 10:35")
    }

    func testTheDayIsComparedInTheSnapshotZone() throws {
        // 2026-10-23T16:40Z is already 2026-10-24 00:40 in Asia/Shanghai, so the
        // fixture snapshot (2026-10-23) is a past day there even though the UTC
        // date is still the same.
        let boundary = UsageFormat.instant("2026-10-23T16:40:00Z")!
        let state = WidgetSnapshot.state(containerURL: URL(fileURLWithPath: "/unused"), now: boundary, timeZone: zone) { _ in
            try SnapshotLoader.load(Fixtures.data("snapshot"))
        }

        guard case let .usable(usage) = state else {
            XCTFail("expected a usable snapshot, got \(state)")
            return
        }
        XCTAssertFalse(usage.isToday)
    }

    func testAsOfCaption() {
        XCTAssertEqual(
            WidgetSnapshot.asOfCaption(generatedAt: "2026-10-23T02:35:12.482Z", isToday: true, timeZone: zone),
            "as of 10:35"
        )
        XCTAssertEqual(
            WidgetSnapshot.asOfCaption(generatedAt: "2026-10-23T02:35:12.482Z", isToday: false, timeZone: zone),
            "as of 10/23 10:35"
        )
        XCTAssertNil(WidgetSnapshot.asOfCaption(generatedAt: "not a time", isToday: true, timeZone: zone))
    }
}
