import XCTest
import SnorlaxKit

final class UsageSummaryTests: XCTestCase {
    /// 3 minutes after the fixture's sync at 2026-10-23T02:35:11.901Z.
    private let now = UsageFormat.instant("2026-10-23T02:38:11.901Z")!

    func testDayWindowsTopListsAndStatusComeFromTheSnapshot() throws {
        let summary = try UsageSummaryBuilder.make(
            SnapshotLoader.load(Fixtures.data("snapshot")),
            now: now,
            timeZone: TimeZone(identifier: "Asia/Shanghai")!
        )

        XCTAssertEqual(summary.menuTitle, "81.2M")
        XCTAssertEqual(summary.windows.map(\.id), ["today", "last7d", "last30d"])
        XCTAssertEqual(summary.windows.map(\.title), ["Today", "7 days", "30 days"])
        XCTAssertEqual(summary.windows.map(\.tokensText), ["81.2M", "412M", "1.61B"])
        XCTAssertEqual(summary.windows.map(\.costText), ["$312.40", "$1,583.20", "$6,190.70"])
        XCTAssertEqual(summary.windows.map(\.unpricedRequests), [0, 0, 0])

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
        XCTAssertEqual(summary.timeZone.identifier, "Asia/Shanghai")

        XCTAssertEqual(
            summary.statusLine,
            "Last scan 3 min ago · sync ok at 3 min ago · grok 2"
        )
    }

    func testDailyBarsCarryRealDatesInTheSnapshotZone() throws {
        let summary = try UsageSummaryBuilder.make(SnapshotLoader.load(Fixtures.data("snapshot")))

        XCTAssertEqual(summary.daily.map { UsageFormat.dayLabel($0.day!, timeZone: summary.timeZone) }, [
            "9/24", "10/22", "10/23"
        ])
        // 2026-10-22 00:00 in Asia/Shanghai is 2026-10-21 16:00 UTC.
        XCTAssertEqual(summary.daily[1].day?.timeIntervalSince1970, UsageFormat.dayDate("2026-10-22", timeZone: summary.timeZone)?.timeIntervalSince1970)
    }

    func testPartiallyUnpricedWindowsShowALowerBound() throws {
        var text = String(decoding: try Fixtures.data("snapshot"), as: UTF8.self)
        let range = try XCTUnwrap(text.range(of: "\"unpricedRequests\": 0"))
        text.replaceSubrange(range, with: "\"unpricedRequests\": 3")
        let summary = try UsageSummaryBuilder.make(SnapshotLoader.load(Data(text.utf8)))
        XCTAssertEqual(summary.windows.map(\.unpricedRequests), [3, 0, 0])
        XCTAssertEqual(summary.windows[0].costLabel, "≥ $312.40")
        XCTAssertEqual(summary.windows[1].costLabel, "$1,583.20")
    }

    func testAFullyUnpricedWindowShowsUnpricedWithoutAnAmount() throws {
        // The fixture's today window counts 2210 requests; make all of them unpriced.
        var text = String(decoding: try Fixtures.data("snapshot"), as: UTF8.self)
        let range = try XCTUnwrap(text.range(of: "\"unpricedRequests\": 0"))
        text.replaceSubrange(range, with: "\"unpricedRequests\": 2210")
        let summary = try UsageSummaryBuilder.make(SnapshotLoader.load(Data(text.utf8)))

        XCTAssertEqual(summary.windows[0].costLabel, "unpriced")
        XCTAssertEqual(summary.windows[1].costLabel, "$1,583.20")
    }

    func testRowsWithoutTodayTokensAreFiltered() throws {
        let snapshot = self.snapshot(
            agents: [("claude-code", 100), ("gemini", 0)],
            models: [("claude-opus-5-5", 100), ("idle-model", 0)],
            devices: [
                ("6f1c8d2e-4a3b-4c5d-9e6f-7a8b9c0d1e2f", "MacBook Pro", true, 100),
                ("0b2a4d6c-8e9f-4a1b-b3c5-d7e9f0a1b2c3", nil, false, 0)
            ]
        )
        let summary = try UsageSummaryBuilder.make(SnapshotLoader.load(snapshot))

        XCTAssertEqual(summary.topAgents.map(\.name), ["claude-code"])
        XCTAssertEqual(summary.topModels.map(\.name), ["claude-opus-5-5"])
        XCTAssertEqual(summary.devices.map(\.name), ["MacBook Pro"])
    }

    func testUnnamedDevicesAreDescribed() throws {
        let snapshot = self.snapshot(
            agents: [("claude-code", 100)],
            models: [("claude-opus-5-5", 100)],
            devices: [
                ("aaaaaaaa-4a3b-4c5d-9e6f-7a8b9c0d1e2f", nil, true, 100),
                ("0123abcd-8e9f-4a1b-b3c5-d7e9f0a1b2c3", "  ", false, 50)
            ]
        )
        let summary = try UsageSummaryBuilder.make(SnapshotLoader.load(snapshot))

        XCTAssertEqual(summary.devices.map(\.name), ["This Mac", "0123abcd"])
    }

    func testASingleLocalDeviceNeedsNoDevicesSection() throws {
        let snapshot = self.snapshot(
            agents: [("claude-code", 100)],
            models: [("claude-opus-5-5", 100)],
            devices: [("6f1c8d2e-4a3b-4c5d-9e6f-7a8b9c0d1e2f", "MacBook Pro", true, 100)]
        )
        let summary = try UsageSummaryBuilder.make(SnapshotLoader.load(snapshot))

        XCTAssertTrue(summary.devices.isEmpty)
    }

    func testRelativeTimes() throws {
        let zone = TimeZone(identifier: "Asia/Shanghai")!
        // "2026-10-23T02:35:10.205Z" with fractional seconds, and 2026-10-23T02:35:10Z without.
        let withFraction = UsageFormat.instant("2026-10-23T02:35:10.205Z")
        let withoutFraction = UsageFormat.instant("2026-10-23T02:35:10Z")

        XCTAssertNotNil(withFraction)
        // The whole-second form sits 205 ms behind the fixture's .205.
        XCTAssertEqual(withoutFraction!.timeIntervalSince(withFraction!), -0.205, accuracy: 0.0001)
        XCTAssertEqual(UsageFormat.instantText("2026-10-23T02:35:10Z", now: UsageFormat.instant("2026-10-23T02:35:40Z")!, timeZone: zone), "just now")
        XCTAssertEqual(UsageFormat.instantText("2026-10-23T02:35:10Z", now: UsageFormat.instant("2026-10-23T02:38:10Z")!, timeZone: zone), "3 min ago")
        XCTAssertEqual(UsageFormat.instantText("2026-10-23T02:35:10Z", now: UsageFormat.instant("2026-10-23T04:35:10Z")!, timeZone: zone), "2 hr ago")
        XCTAssertEqual(UsageFormat.instantText("2026-10-22T02:35:10Z", now: UsageFormat.instant("2026-10-23T02:35:10Z")!, timeZone: zone), "1 day ago")
        XCTAssertEqual(UsageFormat.instantText("2026-10-20T02:35:10Z", now: UsageFormat.instant("2026-10-23T02:35:10Z")!, timeZone: zone), "3 days ago")
        // A week old shows the local date-time in the given zone.
        XCTAssertEqual(UsageFormat.instantText("2026-10-16T02:35:10Z", now: UsageFormat.instant("2026-10-23T02:35:10Z")!, timeZone: zone), "2026-10-16 10:35")
        XCTAssertNil(UsageFormat.instantText("not a time", now: now, timeZone: zone))
    }

    func testChartDayParsing() throws {
        let zone = TimeZone(identifier: "Asia/Shanghai")!
        let day = UsageFormat.dayDate("2026-10-22", timeZone: zone)

        XCTAssertNotNil(day)
        XCTAssertEqual(UsageFormat.dayLabel(day!, timeZone: zone), "10/22")
        XCTAssertNil(UsageFormat.dayDate("2026/10/22", timeZone: zone))
        XCTAssertNil(UsageFormat.dayDate("2026-02-30", timeZone: zone))
    }

    func testChartDayParsingAcrossDSTGapMidnights() throws {
        // Both midnights do not exist: the zones jump from 00:00 straight to
        // 01:00, and a non-lenient date formatter rejects the input entirely.
        let santiago = TimeZone(identifier: "America/Santiago")!
        let santiagoDay = UsageFormat.dayDate("2026-09-06", timeZone: santiago)
        XCTAssertNotNil(santiagoDay)
        XCTAssertEqual(UsageFormat.dayLabel(santiagoDay!, timeZone: santiago), "9/6")
        let havana = TimeZone(identifier: "America/Havana")!
        let havanaDay = UsageFormat.dayDate("2026-03-08", timeZone: havana)
        XCTAssertNotNil(havanaDay)
        XCTAssertEqual(UsageFormat.dayLabel(havanaDay!, timeZone: havana), "3/8")
    }

    // MARK: - Custom snapshots

    private func snapshot(
        agents: [(name: String, tokens: Int)],
        models: [(name: String, tokens: Int)],
        devices: [(id: String, name: String?, isThisDevice: Bool, tokens: Int)]
    ) -> Data {
        func window(_ tokens: Int) -> String {
            "{\"tokens\": \(tokens), \"inputTokens\": \(tokens), \"outputTokens\": 0, \"cacheReadTokens\": 0, \"costUsd\": 0.0, \"requests\": 1, \"sessions\": 0, \"unpricedRequests\": 0}"
        }
        func agent(_ name: String, _ tokens: Int) -> String {
            "{\"agent\": \"\(name)\", \"today\": \(window(tokens)), \"last7d\": \(window(tokens)), \"last30d\": \(window(tokens))}"
        }
        func model(_ name: String, _ tokens: Int) -> String {
            "{\"model\": \"\(name)\", \"today\": \(window(tokens)), \"last7d\": \(window(tokens)), \"last30d\": \(window(tokens))}"
        }
        func device(_ id: String, _ name: String?, _ isThisDevice: Bool, _ tokens: Int) -> String {
            let nameJson = name.map { "\"\($0)\"" } ?? "null"
            return "{\"deviceId\": \"\(id)\", \"name\": \(nameJson), \"isThisDevice\": \(isThisDevice), \"lastPushAt\": null, \"today\": \(window(tokens)), \"last7d\": \(window(tokens)), \"last30d\": \(window(tokens))}"
        }
        let text = """
        {"schemaVersion": 1, "generatedAt": "2026-10-23T02:35:12.482Z", "timeZone": "Asia/Shanghai",
         "totals": {"today": \(window(100)), "last7d": \(window(100)), "last30d": \(window(100))},
         "byAgent": [\(agents.map { agent($0.name, $0.tokens) }.joined(separator: ","))],
         "byModel": [\(models.map { model($0.name, $0.tokens) }.joined(separator: ","))],
         "byDevice": [\(devices.map { device($0.id, $0.name, $0.isThisDevice, $0.tokens) }.joined(separator: ","))],
         "daily": [], "hourlyToday": [],
         "status": {"lastScanAt": null, "sync": {"state": "ok", "at": null}, "failuresByAgent": {}, "paired": false}}
        """
        return Data(text.utf8)
    }
}
