import XCTest
import SnorlaxKit

final class UsageHeatmapTests: XCTestCase {
    private let utc = TimeZone(secondsFromGMT: 0)!

    func testWindowHas180LocalDatesAndSundayFirstPadding() throws {
        let heatmap = try XCTUnwrap(UsageHeatmapBuilder.make(
            daily: [], generatedAt: "2026-11-07T12:00:00Z", timeZone: utc
        ))
        let cells = heatmap.weeks.flatMap(\.days)
        let dates = cells.compactMap(\.date)
        XCTAssertEqual(dates.count, 180)
        XCTAssertEqual(Set(dates).count, 180)
        XCTAssertEqual(heatmap.startDate, "2026-05-12")
        XCTAssertEqual(heatmap.endDate, "2026-11-07")
        XCTAssertEqual(dates.first, heatmap.startDate)
        XCTAssertEqual(dates.last, heatmap.endDate)
        XCTAssertTrue(heatmap.weeks.allSatisfy { $0.days.count == 7 })
        XCTAssertNil(cells[0].date)
        XCTAssertNil(cells[1].date)
        XCTAssertEqual(cells[2].date, "2026-05-12") // Tuesday
        XCTAssertLessThanOrEqual(heatmap.weeks.count, 27)
        XCTAssertEqual(heatmap.weeks.compactMap(\.monthLabel), ["May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov"])
    }

    func testKnownZeroAndMissingAndFuturePaddingAreDistinct() throws {
        let heatmap = try XCTUnwrap(UsageHeatmapBuilder.make(
            daily: [Daily(costUsd: 0, date: "2026-11-02", requests: 1, tokens: 0, unpricedRequests: 0)],
            generatedAt: "2026-11-02T12:00:00Z", timeZone: utc
        ))
        let cells = heatmap.weeks.flatMap(\.days)
        let zero = try XCTUnwrap(cells.first { $0.date == "2026-11-02" })
        let missing = try XCTUnwrap(cells.first { $0.date == "2026-11-01" })
        XCTAssertEqual(zero.tokens, 0)
        XCTAssertEqual(zero.level, 0)
        XCTAssertTrue(zero.detail.contains("0 tokens"))
        XCTAssertNil(missing.tokens)
        XCTAssertTrue(missing.detail.contains("no data"))
        XCTAssertNil(cells.last?.date) // Tuesday–Saturday are not future zero usage.
        XCTAssertTrue(heatmap.hasMissingDays)
    }

    func testLevelsAndTooltipsUseOnlyInWindowEntries() throws {
        let daily = [
            Daily(costUsd: 1.25, date: "2026-11-02", requests: 1, tokens: 1_000, unpricedRequests: 0),
            Daily(costUsd: 2.5, date: "2026-11-03", requests: 1, tokens: 2_000, unpricedRequests: 0),
            Daily(costUsd: 3.75, date: "2026-11-04", requests: 1, tokens: 3_000, unpricedRequests: 0),
            Daily(costUsd: 5, date: "2026-11-05", requests: 1, tokens: 4_000, unpricedRequests: 0),
            Daily(costUsd: 999, date: "2026-11-06", requests: 1, tokens: 9_999_999, unpricedRequests: 0), // after snapshot
            Daily(costUsd: 999, date: "2025-01-01", requests: 1, tokens: 9_999_999, unpricedRequests: 0),
            Daily(costUsd: 999, date: "invalid", requests: 1, tokens: 9_999_999, unpricedRequests: 0)
        ]
        let heatmap = try XCTUnwrap(UsageHeatmapBuilder.make(daily: daily, generatedAt: "2026-11-05T12:00:00Z", timeZone: utc))
        let known = heatmap.weeks.flatMap(\.days).filter { $0.tokens != nil }
        XCTAssertEqual(known.map(\.level), [1, 2, 3, 4])
        XCTAssertEqual(known[0].detail, "2026-11-02: 1,000 tokens · estimated cost $1.25")
    }

    func testSnapshotTimezoneAndLeapDayNotViewersCurrentDay() throws {
        let zone = TimeZone(identifier: "Asia/Shanghai")!
        let heatmap = try XCTUnwrap(UsageHeatmapBuilder.make(daily: [], generatedAt: "2024-02-29T20:00:00Z", timeZone: zone))
        XCTAssertEqual(heatmap.endDate, "2024-03-01")
        XCTAssertEqual(heatmap.weeks.flatMap(\.days).compactMap(\.date).suffix(2), ["2024-02-29", "2024-03-01"])
    }

    func testDSTDoesNotSkipOrDuplicateDates() throws {
        for zoneID in ["America/New_York", "America/Santiago"] {
            let heatmap = try XCTUnwrap(UsageHeatmapBuilder.make(
                daily: [], generatedAt: "2026-11-07T12:00:00Z", timeZone: TimeZone(identifier: zoneID)!
            ))
            let dates = heatmap.weeks.flatMap(\.days).compactMap(\.date)
            XCTAssertEqual(dates.count, 180)
            XCTAssertEqual(Set(dates).count, 180)
            XCTAssertTrue(dates.contains("2026-09-06"))
            XCTAssertTrue(dates.contains("2026-11-01"))
        }
    }

    func testAdjacentMonthLabelsDoNotOverlap() throws {
        let heatmap = try XCTUnwrap(UsageHeatmapBuilder.make(
            daily: [], generatedAt: "2026-11-25T12:00:00Z", timeZone: utc
        ))
        // Starts May 30; June starts in the following column.
        let labeled = heatmap.weeks.filter { $0.monthLabel != nil }
        XCTAssertEqual(labeled.first?.monthLabel, "Jun")
    }

    func testCompleteSeriesHasNoMissingDays() throws {
        let skeleton = try XCTUnwrap(UsageHeatmapBuilder.make(daily: [], generatedAt: "2026-11-07T12:00:00Z", timeZone: utc))
        let daily = skeleton.weeks.flatMap(\.days).compactMap { day in
            day.date.map { Daily(costUsd: 0, date: $0, requests: 1, tokens: 0, unpricedRequests: 0) }
        }
        let heatmap = try XCTUnwrap(UsageHeatmapBuilder.make(daily: daily, generatedAt: "2026-11-07T12:00:00Z", timeZone: utc))
        XCTAssertFalse(heatmap.hasMissingDays)
        XCTAssertEqual(heatmap.weeks.flatMap(\.days).filter { $0.tokens == 0 }.count, 180)
    }

    func testPricingCompletenessInTooltipAndAccessibilityDetail() throws {
        let decoder = JSONDecoder()
        let cases: [(String, String)] = [
            (#"{"requests":2,"unpricedRequests":2,"costUsd":0}"#, "unpriced"),
            (#"{"requests":3,"unpricedRequests":1,"costUsd":1.25}"#, "estimated cost ≥ $1.25"),
            (#"{"requests":0,"unpricedRequests":0,"costUsd":0}"#, "estimated cost $0.00"),
            (#"{"costUsd":0}"#, "cost unavailable (pricing completeness unknown)"),
            (#"{"costUsd":1.25}"#, "cost unavailable (pricing completeness unknown)"),
            (#"{"requests":3,"costUsd":1.25}"#, "cost unavailable (pricing completeness unknown)")
        ]
        for (fields, expected) in cases {
            let json = "{\"date\":\"2026-11-07\",\"tokens\":100," + fields.dropFirst()
            let entry = try decoder.decode(Daily.self, from: Data(json.utf8))
            let heatmap = try XCTUnwrap(UsageHeatmapBuilder.make(daily: [entry], generatedAt: "2026-11-07T12:00:00Z", timeZone: utc))
            let day = try XCTUnwrap(heatmap.weeks.flatMap(\.days).last { $0.date != nil })
            XCTAssertEqual(day.detail, "2026-11-07: 100 tokens · \(expected)")
        }
    }

    func testInvalidTimestampIsUnavailable() {
        XCTAssertNil(UsageHeatmapBuilder.make(daily: [], generatedAt: "invalid", timeZone: utc))
    }
}
