import XCTest
@testable import SnorlaxKit

final class SpikeValueTests: XCTestCase {
    func testDecodesDocumentedJSON() throws {
        let data = Data("{\"value\":\"812M\"}".utf8)
        let decoded = try JSONDecoder().decode(SpikeValue.self, from: data)
        XCTAssertEqual(decoded, SpikeValue(value: "812M"))
    }

    func testRoundTrip() throws {
        let value = SpikeValue(value: "0")
        let data = try JSONEncoder().encode(value)
        let decoded = try JSONDecoder().decode(SpikeValue.self, from: data)
        XCTAssertEqual(decoded, value)
    }

    func testMissingValueThrows() {
        let data = Data("{}".utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(SpikeValue.self, from: data))
    }
}
