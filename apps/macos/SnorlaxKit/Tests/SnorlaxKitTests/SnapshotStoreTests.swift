import XCTest
import SnorlaxKit

final class SnapshotStoreTests: XCTestCase {
    func testPublishWritesTheSnapshotAndReloadsTimelines() throws {
        let temp = try TempDirectory()
        defer { temp.remove() }
        let reloader = RecordingReloader()
        let copy = AppGroupSnapshotCopy(container: temp.url, reloader: reloader)
        let data = try Fixtures.data("snapshot")

        try copy.publish(data)

        XCTAssertEqual(try Data(contentsOf: copy.fileURL), data)
        XCTAssertEqual(reloader.reloads, 1)
        let loaded = try SnapshotLoader.load(contentsOf: copy.fileURL)
        XCTAssertEqual(loaded.totals.today.tokens, 81_234_567)
    }

    func testPublishRefusesANewerSnapshotWithoutWritingOrReloading() throws {
        let temp = try TempDirectory()
        defer { temp.remove() }
        let reloader = RecordingReloader()
        let copy = AppGroupSnapshotCopy(container: temp.url, reloader: reloader)
        var text = String(decoding: try Fixtures.data("snapshot"), as: UTF8.self)
        text = text.replacingOccurrences(of: "\"schemaVersion\": 1", with: "\"schemaVersion\": 2")

        XCTAssertThrowsError(try copy.publish(Data(text.utf8))) { error in
            XCTAssertEqual(error as? SchemaError, .newerCollector)
        }
        XCTAssertEqual(reloader.reloads, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: copy.fileURL.path))
    }

    func testAnUnchangedSnapshotIsPublishedOnlyOnce() throws {
        let temp = try TempDirectory()
        defer { temp.remove() }
        let reloader = RecordingReloader()
        var publisher = AppGroupSnapshotPublisher(container: temp.url, reloader: reloader)
        let data = try Fixtures.data("snapshot")

        XCTAssertTrue(try publisher.publish(data))
        XCTAssertFalse(try publisher.publish(data))
        XCTAssertFalse(try publisher.publish(data))

        XCTAssertEqual(reloader.reloads, 1)
        XCTAssertEqual(try Data(contentsOf: publisher.fileURL), data)
    }

    func testAChangedSnapshotIsPublishedAgain() throws {
        let temp = try TempDirectory()
        defer { temp.remove() }
        let reloader = RecordingReloader()
        var publisher = AppGroupSnapshotPublisher(container: temp.url, reloader: reloader)
        let data = try Fixtures.data("snapshot")

        try publisher.publish(data)
        var text = String(decoding: data, as: UTF8.self)
        text = text.replacingOccurrences(of: "\"generatedAt\": \"2026-10-23T02:35:12.482Z\"", with: "\"generatedAt\": \"2026-10-23T02:40:12.482Z\"")
        let changed = Data(text.utf8)
        let published = try publisher.publish(changed)

        XCTAssertTrue(published)
        XCTAssertEqual(reloader.reloads, 2)
        XCTAssertEqual(try Data(contentsOf: publisher.fileURL), changed)
    }
}

private final class RecordingReloader: TimelineReloading {
    var reloads = 0
    func reloadAllTimelines() { reloads += 1 }
}
