import XCTest
import SnorlaxKit

final class UsageSummaryTests: XCTestCase {
    func testDayWindowsTopListsAndStatusComeFromTheSnapshot() throws {
        let summary = try UsageSummaryBuilder.make(SnapshotLoader.load(Fixtures.data("snapshot")))

        XCTAssertEqual(summary.menuTitle, "81.2M")
        XCTAssertEqual(summary.windows.map(\.id), ["today", "last7d", "last30d"])
        XCTAssertEqual(summary.windows.map(\.title), ["Today", "7 days", "30 days"])
        XCTAssertEqual(summary.windows.map(\.tokensText), ["81.2M", "412M", "1.61B"])
        XCTAssertEqual(summary.windows.map(\.costText), ["$312.40", "$1,583.20", "$6,190.70"])
        XCTAssertEqual(summary.windows.map(\.unpriced), [false, false, false])

        XCTAssertEqual(summary.topAgents.map(\.name), ["claude-code", "codex"])
        XCTAssertEqual(summary.topAgents.map(\.tokensText), ["81.2M", "12.3M"])
        XCTAssertEqual(summary.topModels.map(\.name), ["claude-opus-5-5", "gpt-6.2"])
        XCTAssertEqual(summary.devices.map(\.name), ["MacBook Pro", "Mac mini"])
        XCTAssertEqual(summary.devices.map(\.isThisDevice), [true, false])
        XCTAssertEqual(Array(summary.topAgents.prefix(UsageSummaryBuilder.widgetAgentLimit)).map(\.name), [
            "claude-code", "codex"
        ])

        XCTAssertEqual(summary.daily.map(\.date), ["2026-09-24", "2026-10-22", "2026-10-23"])
        XCTAssertEqual(summary.daily.map(\.tokens), [41_234_567, 81_234_567, 12_345_678])
        XCTAssertEqual(
            summary.statusLine,
            "Last scan 2026-10-23T02:35:10.205Z · sync ok at 2026-10-23T02:35:11.901Z · grok 2"
        )
    }

    func testUnpricedTodayIsMarkedAndOtherWindowsAreNot() throws {
        var text = String(decoding: try Fixtures.data("snapshot"), as: UTF8.self)
        let range = try XCTUnwrap(text.range(of: "\"unpricedRequests\": 0"))
        text.replaceSubrange(range, with: "\"unpricedRequests\": 3")
        let summary = try UsageSummaryBuilder.make(SnapshotLoader.load(Data(text.utf8)))
        XCTAssertEqual(summary.windows.map(\.unpriced), [true, false, false])
        XCTAssertEqual(summary.windows[0].costLabel, "$312.40 unpriced")
        XCTAssertEqual(summary.windows[1].costLabel, "$1,583.20")
    }
}
