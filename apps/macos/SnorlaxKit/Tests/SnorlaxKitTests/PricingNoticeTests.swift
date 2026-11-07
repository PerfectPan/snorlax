import Foundation
import XCTest
@testable import SnorlaxKit

final class PricingNoticeTests: XCTestCase {
    func testChangedPricingShowsRebuildAdvice() async throws {
        let status = try await loadStatus(pricingChanged: true)
        XCTAssertEqual(
            status.pricingNotice,
            "The pricing table has changed. Costs may be out of date. Run `snorlax rebuild --days 30` to update them."
        )
    }

    func testCurrentPricingShowsNoNotice() async throws {
        let status = try await loadStatus(pricingChanged: false)
        XCTAssertNil(status.pricingNotice)
    }

    private func loadStatus(pricingChanged: Bool) async throws -> Status {
        let fixture = String(decoding: try Fixtures.data("status"), as: UTF8.self)
            .replacingOccurrences(of: "\"pricingChanged\": false", with: "\"pricingChanged\": \(pricingChanged)")
        let runner = PricingStatusRunner(body: Data(fixture.utf8))
        let client = CollectorClient(executable: URL(fileURLWithPath: "/fictional/snorlax"), runner: runner)
        let status = try await client.run(["status"], as: Status.self)
        XCTAssertEqual(status.pricingChanged, pricingChanged)
        return status
    }
}

private struct PricingStatusRunner: ProcessRunning {
    let body: Data

    func run(executable: URL, arguments: [String], stdin: Data?, timeout: Duration) async throws -> ProcessOutput {
        XCTAssertEqual(arguments, ["status", "--json"])
        XCTAssertNil(stdin)
        return ProcessOutput(status: 0, stdout: body, stderr: Data())
    }
}
