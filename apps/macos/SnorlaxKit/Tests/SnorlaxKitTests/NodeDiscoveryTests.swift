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
