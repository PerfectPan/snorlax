import XCTest
import SnorlaxKit

final class NodeDiscoveryTests: XCTestCase {
    func testParsesNodeVersionLines() {
        XCTAssertEqual(NodeDiscovery.parseVersion("v22.13.0\n"), NodeVersion(major: 22, minor: 13, patch: 0))
        XCTAssertEqual(NodeDiscovery.parseVersion("v24.11.0"), NodeVersion(major: 24, minor: 11, patch: 0))
        XCTAssertNil(NodeDiscovery.parseVersion("not-node"))
        XCTAssertTrue(NodeVersion(major: 22, minor: 13, patch: 0).isAtLeast(NodeDiscovery.minimum))
        XCTAssertTrue(NodeVersion(major: 22, minor: 13, patch: 1).isAtLeast(NodeDiscovery.minimum))
        XCTAssertTrue(NodeVersion(major: 24, minor: 0, patch: 0).isAtLeast(NodeDiscovery.minimum))
        XCTAssertFalse(NodeVersion(major: 22, minor: 12, patch: 9).isAtLeast(NodeDiscovery.minimum))
        XCTAssertFalse(NodeVersion(major: 21, minor: 99, patch: 0).isAtLeast(NodeDiscovery.minimum))
    }

    func testTakesTheLastPathLineFromLoginShellOutput() {
        // A login shell may print banners before `command -v node` answers.
        XCTAssertEqual(NodeDiscovery.nodePath(fromOutput: "loading nvm...\n/opt/homebrew/bin/node\n"), "/opt/homebrew/bin/node")
        XCTAssertEqual(NodeDiscovery.nodePath(fromOutput: "banner\n/usr/bin/node\nmore banner\n/usr/local/bin/node\n"), "/usr/local/bin/node")
        XCTAssertEqual(NodeDiscovery.nodePath(fromOutput: "  /usr/bin/node  \n"), "/usr/bin/node")
        XCTAssertNil(NodeDiscovery.nodePath(fromOutput: "banner without a path\n"))
        XCTAssertNil(NodeDiscovery.nodePath(fromOutput: ""))
    }

    func testReadPlanDecidesFromInjectedState() {
        XCTAssertEqual(NodeDiscovery.readPlan(terminatedBySignal: true, eofReceived: true), .none)
        XCTAssertEqual(NodeDiscovery.readPlan(terminatedBySignal: true, eofReceived: false), .none)
        XCTAssertEqual(NodeDiscovery.readPlan(terminatedBySignal: false, eofReceived: true), .readFully)
        XCTAssertEqual(NodeDiscovery.readPlan(terminatedBySignal: false, eofReceived: false), .readWhatArrived)
    }

    func testOutputIsKeptWhenTheProcessExitedButThePipeStaysOpen() async throws {
        let temp = try TempDirectory()
        defer { temp.remove() }
        // Prints the version, exits, and leaves a background `sleep` holding
        // stdout: EOF never arrives. The budget goes to the exit event, so
        // the probe returns without waiting for the pipes. The stub records
        // the background PID so the test kills it and leaves no orphan.
        let stub = try temp.writeExecutable(named: "node", contents: """
        #!/bin/sh
        dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
        echo "v22.13.0"
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
        // itself finishes at once. The watchdog bounds the call far below the
        // sleeper: waiting on the pipes instead of the exit event fails here.
        let probe = ProcessNodeProbe(timeout: 30)
        let done = DispatchSemaphore(value: 0)
        var output: String?
        let run = Task.detached {
            output = probe.versionOutput(executable: stub.path)
            done.signal()
        }
        if done.wait(timeout: .now() + 5) == .timedOut {
            XCTFail("the probe waited on the pipes instead of the exit event")
            return
        }
        await run.value

        XCTAssertEqual(output, "v22.13.0\n")
    }

    func testKeepsASavedNodeThatMeetsTheMinimum() throws {
        let temp = try TempDirectory()
        defer { temp.remove() }
        let node = try temp.writeExecutable(named: "node", contents: "#!/bin/sh\nexit 0\n")
        try Data("\(node.path)\n".utf8).write(to: temp.url.appendingPathComponent(NodeDiscovery.fileName))
        let probe = FakeProbe(versions: [node.path: "v22.13.0\n"])

        let resolution = try NodeDiscovery.resolve(dataDirectory: temp.url, probe: probe)

        XCTAssertEqual(resolution, .ready(node.path))
        XCTAssertEqual(probe.loginCalls, 0)
        let saved = try String(contentsOf: temp.url.appendingPathComponent(NodeDiscovery.fileName), encoding: .utf8)
        XCTAssertEqual(saved, "\(node.path)\n")
    }

    func testWritesTheLoginShellNodeWhenTheSavedOneIsTooOld() throws {
        let temp = try TempDirectory()
        defer { temp.remove() }
        let old = try temp.writeExecutable(named: "old-node", contents: "#!/bin/sh\nexit 0\n")
        let current = try temp.writeExecutable(named: "current-node", contents: "#!/bin/sh\nexit 0\n")
        try Data("\(old.path)\n".utf8).write(to: temp.url.appendingPathComponent(NodeDiscovery.fileName))
        let probe = FakeProbe(versions: [old.path: "v22.12.9\n", current.path: "v24.11.0\n"], loginPath: current.path)

        let resolution = try NodeDiscovery.resolve(dataDirectory: temp.url, probe: probe)

        XCTAssertEqual(resolution, .ready(current.path))
        XCTAssertEqual(probe.loginCalls, 1)
        let saved = try String(contentsOf: temp.url.appendingPathComponent(NodeDiscovery.fileName), encoding: .utf8)
        XCTAssertEqual(saved, "\(current.path)\n")
    }

    func testMissingNodeRemovesABadSavedPath() throws {
        let temp = try TempDirectory()
        defer { temp.remove() }
        let old = try temp.writeExecutable(named: "old-node", contents: "#!/bin/sh\nexit 0\n")
        try Data("\(old.path)\n".utf8).write(to: temp.url.appendingPathComponent(NodeDiscovery.fileName))
        let probe = FakeProbe(versions: [old.path: "v18.0.0\n"], loginPath: nil)

        let resolution = try NodeDiscovery.resolve(dataDirectory: temp.url, probe: probe)

        XCTAssertEqual(resolution, .missing)
        XCTAssertFalse(FileManager.default.fileExists(atPath: temp.url.appendingPathComponent(NodeDiscovery.fileName).path))
    }

    func testDataDirectoryPrefersSnorlaxHome() {
        let home = URL(fileURLWithPath: "/tmp/snorlax-not-used", isDirectory: true)
        let overridden = DataDirectory.resolve(environment: ["SNORLAX_HOME": "/tmp/snorlax-data"], home: home)
        XCTAssertEqual(overridden.path, "/tmp/snorlax-data")
        let fallback = DataDirectory.resolve(environment: [:], home: home)
        XCTAssertEqual(fallback.path, "/tmp/snorlax-not-used/Library/Application Support/snorlax")
    }
}

private final class FakeProbe: NodeProbing, @unchecked Sendable {
    var versions: [String: String]
    var loginPath: String?
    var loginCalls = 0

    init(versions: [String: String], loginPath: String? = nil) {
        self.versions = versions
        self.loginPath = loginPath
    }

    func versionOutput(executable: String) -> String? {
        versions[executable]
    }

    func loginShellNodePath() -> String? {
        loginCalls += 1
        return loginPath
    }
}
