import XCTest
import SnorlaxKit

final class FixtureDecodingTests: XCTestCase {
    func testDecodesEveryProtocolFixture() throws {
        _ = try JSONDecoder().decode(Bucket.self, from: Fixtures.data("bucket"))
        _ = try JSONDecoder().decode(Doctor.self, from: Fixtures.data("doctor"))
        let failure = try JSONDecoder().decode(Failure.self, from: Fixtures.data("failure"))
        XCTAssertEqual(failure.error.code, "data-dir")
        XCTAssertFalse(failure.ok)
        _ = try JSONDecoder().decode(Ok.self, from: Fixtures.data("ok"))
        _ = try JSONDecoder().decode(PairResult.self, from: Fixtures.data("pair-result"))
        let refresh = try JSONDecoder().decode(RefreshResult.self, from: Fixtures.data("refresh-result"))
        XCTAssertEqual(refresh.records, 412)
        XCTAssertEqual(refresh.sync.pushed, 9)
        let snapshot = try SnapshotLoader.load(Fixtures.data("snapshot"))
        XCTAssertEqual(snapshot.schemaVersion, 1)
        XCTAssertEqual(snapshot.timeZone, "Asia/Shanghai")
        XCTAssertEqual(snapshot.totals.today.tokens, 81_234_567)
        _ = try JSONDecoder().decode(Status.self, from: Fixtures.data("status"))
    }

    func testRefusesANewerSchemaVersionWithThePlanMessage() throws {
        let newer = try replacingSchemaVersion(Fixtures.data("snapshot"), with: 2)
        XCTAssertThrowsError(try SnapshotLoader.load(newer)) { error in
            XCTAssertEqual(error as? SchemaError, .newerCollector)
            XCTAssertEqual(
                (error as? LocalizedError)?.errorDescription,
                "The collector is newer than the app; update the app."
            )
        }
    }

    func testRefusesAnOlderSchemaVersion() throws {
        let older = try replacingSchemaVersion(Fixtures.data("snapshot"), with: 0)
        XCTAssertThrowsError(try SnapshotLoader.load(older)) { error in
            XCTAssertEqual(error as? SchemaError, .unsupported)
        }
    }

    private func replacingSchemaVersion(_ data: Data, with version: Int) throws -> Data {
        var text = String(decoding: data, as: UTF8.self)
        guard let range = text.range(of: "\"schemaVersion\": 1") else {
            XCTFail("fixture has no schemaVersion")
            return data
        }
        text.replaceSubrange(range, with: "\"schemaVersion\": \(version)")
        return Data(text.utf8)
    }
}
