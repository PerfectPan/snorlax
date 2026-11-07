import Foundation
import XCTest
@testable import SnorlaxKit

@MainActor
final class PricingRebuildTests: XCTestCase {
    func testExplicitRebuildUses180DaysAndReloadsOnSuccess() async throws {
        let runner = RebuildRunner(output: .success(try output()))
        let model = model(runner)
        var reloads = 0
        model.refreshSnapshot = { reloads += 1 }
        XCTAssertFalse(model.running)
        XCTAssertNil(model.notice)
        let initialCalls = await runner.count
        XCTAssertEqual(initialCalls, 0)

        await model.rebuild()

        XCTAssertFalse(model.running)
        XCTAssertEqual(model.notice, "Rebuilt the last 180 days.")
        XCTAssertEqual(reloads, 1)
        let calls = await runner.count
        XCTAssertEqual(calls, 1)
    }

    func testDuplicateClickWhileRunningDoesNotStartAnotherCommand() async throws {
        let runner = RebuildRunner(output: .success(try output()), held: true)
        let model = model(runner)
        let first = Task { await model.rebuild() }
        await runner.waitUntilStarted()
        XCTAssertTrue(model.running)
        await model.rebuild()
        let calls = await runner.count
        XCTAssertEqual(calls, 1)
        await runner.release()
        await first.value
        XCTAssertFalse(model.running)
    }

    func testTimeoutReportsUncertaintyReloadsAndDoesNotRetry() async {
        let runner = RebuildRunner(output: .failure(CollectorClientError.timedOut(.seconds(600))))
        let model = model(runner)
        var reloads = 0
        model.refreshSnapshot = { reloads += 1 }
        await model.rebuild()
        XCTAssertFalse(model.running)
        XCTAssertTrue(model.notice?.contains("could not be confirmed") == true)
        XCTAssertTrue(model.notice?.contains("600 seconds") == true)
        XCTAssertEqual(reloads, 1)
        let calls = await runner.count
        XCTAssertEqual(calls, 1)
    }

    func testParsingAndSyncFailuresAreNotPresentedAsCleanSuccess() async throws {
        var text = String(decoding: try Fixtures.data("refresh-result"), as: UTF8.self)
        text = text.replacingOccurrences(of: "\"failures\": 0", with: "\"failures\": 2")
        text = text.replacingOccurrences(of: "\"state\": \"ok\"", with: "\"state\": \"failed\"")
        text = text.replacingOccurrences(of: "\"sync\": {\n    \"ok\": true", with: "\"sync\": {\n    \"ok\": false")
        let runner = RebuildRunner(output: .success(ProcessOutput(status: 0, stdout: Data(text.utf8), stderr: Data())))
        let model = model(runner)
        await model.rebuild()
        XCTAssertTrue(model.notice?.contains("2 parsing failures") == true)
        XCTAssertTrue(model.notice?.contains("Sync did not complete") == true)
    }

    func testCommandFailureIsVisibleAndExplicitRetryCanSucceed() async throws {
        let failure = ProcessOutput(status: 1, stdout: try Fixtures.data("failure"), stderr: Data())
        let runner = RebuildRunner(output: .success(failure))
        let model = model(runner)
        await model.rebuild()
        XCTAssertTrue(model.notice?.contains("could not be confirmed") == true)
        XCTAssertFalse(model.running)
        await runner.setOutput(.success(try output()))
        await model.rebuild()
        XCTAssertEqual(model.notice, "Rebuilt the last 180 days.")
        let calls = await runner.count
        XCTAssertEqual(calls, 2)
    }

    private func model(_ runner: RebuildRunner) -> PricingRebuildModel {
        PricingRebuildModel(client: CollectorClient(executable: URL(fileURLWithPath: "/fictional/snorlax"), runner: runner))
    }

    private func output() throws -> ProcessOutput {
        ProcessOutput(status: 0, stdout: try Fixtures.data("refresh-result"), stderr: Data())
    }
}

private actor RebuildRunner: ProcessRunning {
    private var output: Result<ProcessOutput, Error>
    private let held: Bool
    private var pending: CheckedContinuation<Void, Never>?
    private var started: CheckedContinuation<Void, Never>?
    private(set) var count = 0

    init(output: Result<ProcessOutput, Error>, held: Bool = false) {
        self.output = output
        self.held = held
    }

    func run(executable: URL, arguments: [String], stdin: Data?, timeout: Duration) async throws -> ProcessOutput {
        XCTAssertEqual(arguments, ["rebuild", "--days", "180", "--json"])
        XCTAssertEqual(timeout, .seconds(600))
        XCTAssertNil(stdin)
        count += 1
        if held {
            await withCheckedContinuation { continuation in
                pending = continuation
                started?.resume()
                started = nil
            }
        }
        return try output.get()
    }

    func waitUntilStarted() async {
        if count > 0 { return }
        await withCheckedContinuation { started = $0 }
    }

    func release() {
        pending?.resume()
        pending = nil
    }

    func setOutput(_ output: Result<ProcessOutput, Error>) {
        self.output = output
    }
}
