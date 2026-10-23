import XCTest
import SnorlaxKit

final class LauncherNodeTests: XCTestCase {
    func testResolvesANodePathThatNamesAnExecutable() {
        let fileSystem = LauncherNode.FileSystem(fake: FakeFiles(
            files: ["/data/node-path"],
            contents: ["/data/node-path": " /fake/node \nignored\n"],
            executables: ["/fake/node"]
        ))

        let node = LauncherNode.resolve(dataDirectory: URL(fileURLWithPath: "/data"), fileSystem: fileSystem)

        XCTAssertEqual(node, "/fake/node")
    }

    func testSkipsANodePathThatIsMissingOrEmptyOrNotExecutable() {
        for contents in [nil, "", "   \n"] {
            var recorded = [String: String]()
            if let contents {
                recorded["/data/node-path"] = contents
            }
            let fileSystem = LauncherNode.FileSystem(fake: FakeFiles(
                files: recorded.keys.count == 0 ? [] : ["/data/node-path"],
                contents: recorded,
                executables: ["/opt/homebrew/bin/node"]
            ))

            let node = LauncherNode.resolve(dataDirectory: URL(fileURLWithPath: "/data"), fileSystem: fileSystem)

            XCTAssertEqual(node, "/opt/homebrew/bin/node")
        }
    }

    func testPrefersNodePathOverTheFallbackDirectories() {
        let fileSystem = LauncherNode.FileSystem(fake: FakeFiles(
            files: ["/data/node-path"],
            contents: ["/data/node-path": "/fake/node\n"],
            executables: ["/fake/node", "/opt/homebrew/bin/node", "/usr/local/bin/node"]
        ))

        let node = LauncherNode.resolve(dataDirectory: URL(fileURLWithPath: "/data"), fileSystem: fileSystem)

        XCTAssertEqual(node, "/fake/node")
    }

    func testFallsBackToTheFixedDirectoriesInOrder() {
        for (executables, expected) in [
            (["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"], "/opt/homebrew/bin/node"),
            (["/usr/local/bin/node", "/usr/bin/node"], "/usr/local/bin/node"),
            (["/usr/bin/node"], "/usr/bin/node")
        ] {
            let fileSystem = LauncherNode.FileSystem(fake: FakeFiles(files: [], contents: [:], executables: Set(executables)))

            let node = LauncherNode.resolve(dataDirectory: URL(fileURLWithPath: "/data"), fileSystem: fileSystem)

            XCTAssertEqual(node, expected)
        }
    }

    func testAllMissingProducesTheScriptMessage() {
        let fileSystem = LauncherNode.FileSystem(fake: FakeFiles(files: [], contents: [:], executables: []))

        let node = LauncherNode.resolve(dataDirectory: URL(fileURLWithPath: "/data"), fileSystem: fileSystem)

        XCTAssertNil(node)
        XCTAssertEqual(
            LauncherNode.missingNodeMessage,
            "snorlax: node not found (checked node-path, then /opt/homebrew/bin:/usr/local/bin:/usr/bin)"
        )
    }

    func testResolvesTheDataDirectoryFromSnorlaxHomeBeforeLookingForNode() {
        let environment = ["SNORLAX_HOME": "/tmp/snorlax-data"]
        let directory = DataDirectory.resolve(
            environment: environment,
            home: URL(fileURLWithPath: "/tmp/snorlax-home", isDirectory: true)
        )
        let fileSystem = LauncherNode.FileSystem(fake: FakeFiles(
            files: [directory.appendingPathComponent(LauncherNode.fileName).path],
            contents: [directory.appendingPathComponent(LauncherNode.fileName).path: "/tmp/snorlax-node\n"],
            executables: ["/tmp/snorlax-node", "/opt/homebrew/bin/node"]
        ))

        let node = LauncherNode.resolve(dataDirectory: directory, fileSystem: fileSystem)

        XCTAssertEqual(node, "/tmp/snorlax-node")
    }

    func testCollectorPathComesFromTheExecutableThroughASymlink() throws {
        let temp = try TempDirectory()
        defer { temp.remove() }
        let helper = temp.url
            .appendingPathComponent("Snorlax.app/Contents/Helpers/snorlax", isDirectory: false)
        try FileManager.default.createDirectory(at: helper.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data().write(to: helper)
        let link = temp.url.appendingPathComponent("alias", isDirectory: false)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: temp.url.appendingPathComponent("Snorlax.app"))

        let throughLink = LauncherNode.collectorPath(
            executablePath: link.appendingPathComponent("Contents/Helpers/snorlax").path
        )
        let direct = LauncherNode.collectorPath(executablePath: helper.path)

        XCTAssertEqual(direct, temp.url.appendingPathComponent("Snorlax.app/Contents/Resources/collector/snorlax.mjs").path)
        XCTAssertEqual(throughLink, direct)
    }

    func testFirstLineTrimsWhitespaceAndSkipsTheRest() throws {
        let temp = try TempDirectory()
        defer { temp.remove() }
        let file = temp.url.appendingPathComponent("node-path")
        try Data("  /fake/node  \r\n/fake/second\n".utf8).write(to: file)

        XCTAssertEqual(LauncherNode.firstLine(ofFile: file.path), "/fake/node")
    }

    func testFirstLineTakesTheLiteralFirstLineLikeHead() throws {
        let temp = try TempDirectory()
        defer { temp.remove() }
        let file = temp.url.appendingPathComponent("node-path")
        // `head -n 1` reads the blank first line; it does not fall through to
        // the second one, so the launcher falls back to the fixed directories.
        try Data("\n/fake/node\n".utf8).write(to: file)
        XCTAssertNil(LauncherNode.firstLine(ofFile: file.path))
    }

    func testHomeDirectoryPrefersTheEnvironmentLikeTheShell() {
        XCTAssertEqual(
            LauncherNode.homeDirectory(environment: ["HOME": "/tmp/snorlax-home"]),
            URL(fileURLWithPath: "/tmp/snorlax-home", isDirectory: true)
        )
        XCTAssertNil(LauncherNode.homeDirectory(environment: ["HOME": ""]))
        XCTAssertNil(LauncherNode.homeDirectory(environment: [:]))
    }
}

private struct FakeFiles {
    var files: Set<String>
    var contents: [String: String]
    var executables: Set<String>

    func fileExists(_ path: String) -> Bool { files.contains(path) }
    func isExecutableFile(_ path: String) -> Bool { executables.contains(path) }
    func firstLine(_ path: String) -> String? {
        guard let text = contents[path] else { return nil }
        return String(text.split(whereSeparator: \.isNewline).first ?? "")
    }
}

private extension LauncherNode.FileSystem {
    init(fake: FakeFiles) {
        self.init(
            fileExists: { fake.fileExists($0) },
            isExecutableFile: { fake.isExecutableFile($0) },
            firstLine: { fake.firstLine($0) }
        )
    }
}
