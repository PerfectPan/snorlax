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

    private let stubScript = """
    #!/bin/sh
    dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
    printf '%s\\n' "$@" > "$dir/args"
    cat > "$dir/stdin"
    cat "$dir/body.json"
    exit "$(cat "$dir/exit-code")"
    """
}
