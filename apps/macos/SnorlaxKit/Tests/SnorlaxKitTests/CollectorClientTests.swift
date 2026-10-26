import XCTest
import SnorlaxKit

final class CollectorClientTests: XCTestCase {
    func testDefaultTimeoutIs120Seconds() {
        let client = CollectorClient(executable: URL(fileURLWithPath: "/usr/bin/true"))
        XCTAssertEqual(client.timeout, .seconds(120))
    }

    func testFailureExitDecodesTheFailureShapeFromAStub() async throws {
        let temp = try TempDirectory()
        defer { temp.remove() }
        let fixture = try Fixtures.data("failure")
        try fixture.write(to: temp.url.appendingPathComponent("body.json"))
        try Data("1\n".utf8).write(to: temp.url.appendingPathComponent("exit-code"))
        let stub = try temp.writeExecutable(named: "stub", contents: stubScript)
        let client = CollectorClient(executable: stub)

        do {
            _ = try await client.run(["refresh"], stdin: Data("admin-token".utf8), as: RefreshResult.self)
            XCTFail("refresh should fail")
        } catch let error as CollectorClientError {
            guard case let .failed(failure) = error else {
                XCTFail("expected the failure shape, got \(error)")
                return
            }
            XCTAssertEqual(failure.schemaVersion, 1)
            XCTAssertEqual(failure.ok, false)
            XCTAssertEqual(failure.error.code, "data-dir")
            XCTAssertEqual(
                failure.error.message,
                "the data directory is not writable: ~/Library/Application Support/snorlax"
            )
        }
        let args = try String(contentsOf: temp.url.appendingPathComponent("args"), encoding: .utf8)
        XCTAssertEqual(args, "refresh\n--json\n")
        let stdin = try Data(contentsOf: temp.url.appendingPathComponent("stdin"))
        XCTAssertEqual(stdin, Data("admin-token".utf8))
    }

    func testSuccessExitDecodesTheRequestedType() async throws {
        let temp = try TempDirectory()
        defer { temp.remove() }
        try Fixtures.data("refresh-result").write(to: temp.url.appendingPathComponent("body.json"))
        try Data("0\n".utf8).write(to: temp.url.appendingPathComponent("exit-code"))
        let client = CollectorClient(executable: try temp.writeExecutable(named: "stub", contents: stubScript))

        let result = try await client.run(["refresh"], as: RefreshResult.self)
        XCTAssertEqual(result.records, 412)
        XCTAssertEqual(result.sync.pulled, 23)
        XCTAssertTrue(result.ok)
    }

    func testNewerSchemaVersionUsesThePlanMessage() async throws {
        let temp = try TempDirectory()
        defer { temp.remove() }
        var text = String(decoding: try Fixtures.data("failure"), as: UTF8.self)
        text = text.replacingOccurrences(of: "\"schemaVersion\": 1", with: "\"schemaVersion\": 2")
        try Data(text.utf8).write(to: temp.url.appendingPathComponent("body.json"))
        try Data("1\n".utf8).write(to: temp.url.appendingPathComponent("exit-code"))
        let client = CollectorClient(executable: try temp.writeExecutable(named: "stub", contents: stubScript))

        do {
            _ = try await client.run(["doctor"], as: Doctor.self)
            XCTFail("a newer collector should be refused")
        } catch let error as CollectorClientError {
            XCTAssertEqual(error, .newerCollector)
            XCTAssertEqual(error.errorDescription, "The collector is newer than the app; update the app.")
        }
    }

    func testLargeStdoutStreamsPastThePipeBuffer() async throws {
        let temp = try TempDirectory()
        defer { temp.remove() }
        try Fixtures.data("refresh-result").write(to: temp.url.appendingPathComponent("body.json"))
        try Data("0\n".utf8).write(to: temp.url.appendingPathComponent("exit-code"))
        // Over 1 MB of whitespace before the JSON: a runner that only reads in
        // its termination handler deadlocks on the full pipe buffer instead.
        let stub = try temp.writeExecutable(named: "stub", contents: """
        #!/bin/sh
        dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
        head -c 1048576 /dev/zero | tr '\\0' '\\n'
        cat "$dir/body.json"
        exit "$(cat "$dir/exit-code")"
        """)
        let client = CollectorClient(executable: stub, timeout: .seconds(60))

        let result = try await client.run(["refresh"], as: RefreshResult.self)

        XCTAssertEqual(result.records, 412)
        XCTAssertTrue(result.ok)
    }

    func testAChildThatNeverReadsStdinDoesNotCrashOrBlock() async throws {
        let temp = try TempDirectory()
        defer { temp.remove() }
        // Exits without reading stdin and without printing JSON.
        let stub = try temp.writeExecutable(named: "stub", contents: "#!/bin/sh\nexit 0\n")
        let client = CollectorClient(executable: stub, timeout: .seconds(60))
        let large = Data(repeating: 0x21, count: 300_000)

        do {
            _ = try await client.run(["refresh"], stdin: large, as: RefreshResult.self)
            XCTFail("an empty result should not decode")
        } catch let error as CollectorClientError {
            guard case .unreadable = error else {
                XCTFail("expected an unreadable result, got \(error)")
                return
            }
        }
    }

    func testTheTimeoutMessageNamesTheBudgetThatExpired() {
        XCTAssertEqual(
            CollectorClientError.timedOut(.seconds(120)).errorDescription,
            "The collector did not finish within 120 seconds."
        )
        XCTAssertEqual(
            CollectorClientError.timedOut(.seconds(300)).errorDescription,
            "The collector did not finish within 300 seconds."
        )
    }

    func testTimeoutPlanFollowsTheTerminationReason() {
        XCTAssertEqual(CollectorClient.timeoutPlan(terminatedBySignal: false), .collect)
        XCTAssertEqual(CollectorClient.timeoutPlan(terminatedBySignal: true), .reportTimeout)
    }

    func testAChildThatIgnoresSIGTERMIsKilledAndReportedAsTimeout() async throws {
        let temp = try TempDirectory()
        defer { temp.remove() }
        // Records its own PID and the sleeper's, ignores SIGTERM, and hangs:
        // the run must escalate to SIGKILL and report a timeout. The test
        // kills the sleeper so no orphan is left.
        let stub = try temp.writeExecutable(named: "stub", contents: """
        #!/bin/sh
        dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
        printf '%s\\n' "$$" > "$dir/child-pid"
        trap '' TERM
        sleep 30 &
        printf '%s\\n' "$!" > "$dir/sleep-pid"
        wait
        """)
        defer {
            for name in ["child-pid", "sleep-pid"] {
                if let text = try? String(contentsOf: temp.url.appendingPathComponent(name), encoding: .utf8),
                   let processIdentifier = Int32(text.trimmingCharacters(in: .whitespacesAndNewlines)) {
                    kill(processIdentifier, SIGKILL)
                }
            }
        }
        // A 2 s budget keeps the test in seconds: SIGTERM at the budget is
        // ignored, SIGKILL ends the child about a second later. The test
        // asserts no real-time threshold.
        let client = CollectorClient(executable: stub, timeout: .seconds(2))

        do {
            _ = try await client.run(["refresh"], as: RefreshResult.self)
            XCTFail("a killed child is a timeout")
        } catch let error as CollectorClientError {
            XCTAssertEqual(error, .timedOut(.seconds(2)))
            XCTAssertEqual(error.errorDescription, "The collector did not finish within 2 seconds.")
        }

        // The SIGKILLed child is gone, not lingering unreaped.
        let childPID = try String(contentsOf: temp.url.appendingPathComponent("child-pid"), encoding: .utf8)
        kill(Int32(childPID.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0, 0)
        XCTAssertEqual(errno, ESRCH)
    }

    func testAChildWhosePipeStaysOpenAfterSelfExitStillReturnsItsOutput() async throws {
        let temp = try TempDirectory()
        defer { temp.remove() }
        try Fixtures.data("refresh-result").write(to: temp.url.appendingPathComponent("body.json"))
        // Prints the result, exits, and leaves a background `sleep` holding
        // stdout: EOF never arrives, so the budget ends the run and the
        // termination reason must decide. The stub records the background
        // PID so the test kills it and leaves no orphan behind.
        let stub = try temp.writeExecutable(named: "stub", contents: """
        #!/bin/sh
        dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
        cat "$dir/body.json"
        sleep 30 &
        printf '%s\\n' "$!" > "$dir/background-pid"
        exit 0
        """)
        defer {
            if let text = try? String(contentsOf: temp.url.appendingPathComponent("background-pid"), encoding: .utf8),
               let processIdentifier = Int32(text.trimmingCharacters(in: .whitespacesAndNewlines)) {
                kill(processIdentifier, SIGTERM)
            }
        }
        // A 30 s budget keeps the run independent of machine load; the stub
        // itself finishes at once. The test asserts no real-time threshold.
        let client = CollectorClient(executable: stub, timeout: .seconds(30))

        let result = try await client.run(["refresh"], as: RefreshResult.self)

        XCTAssertEqual(result.records, 412)
    }

    private let stubScript = """
    #!/bin/sh
    dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
    printf '%s\\n' "$@" > "$dir/args"
    cat > "$dir/stdin"
    cat "$dir/body.json"
    exit "$(cat "$dir/exit-code")"
    """
}
