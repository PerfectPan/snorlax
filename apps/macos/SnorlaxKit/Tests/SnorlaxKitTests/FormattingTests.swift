import XCTest
import SnorlaxKit

final class FormattingTests: XCTestCase {
    func testShortTokensUseThe812MForm() {
        XCTAssertEqual(UsageFormat.shortTokens(0), "0")
        XCTAssertEqual(UsageFormat.shortTokens(999), "999")
        XCTAssertEqual(UsageFormat.shortTokens(1000), "1K")
        XCTAssertEqual(UsageFormat.shortTokens(1500), "1.5K")
        XCTAssertEqual(UsageFormat.shortTokens(12_340_000), "12.3M")
        XCTAssertEqual(UsageFormat.shortTokens(81_234_567), "81.2M")
        XCTAssertEqual(UsageFormat.shortTokens(812_345_678), "812M")
        XCTAssertEqual(UsageFormat.shortTokens(999_499), "999K")
        XCTAssertEqual(UsageFormat.shortTokens(999_500), "1M")
        XCTAssertEqual(UsageFormat.shortTokens(1_612_345_678), "1.61B")
        XCTAssertEqual(UsageFormat.shortTokens(10_000_000), "10M")
    }

    func testCostUsesTwoFractionDigitsAndGrouping() {
        XCTAssertEqual(UsageFormat.cost(0), "$0.00")
        XCTAssertEqual(UsageFormat.cost(312.4), "$312.40")
        XCTAssertEqual(UsageFormat.cost(1583.2), "$1,583.20")
        XCTAssertEqual(UsageFormat.cost(6190.7), "$6,190.70")
        XCTAssertEqual(UsageFormat.costLabel(usd: 312.4, unpricedRequests: 0), "$312.40")
        XCTAssertEqual(UsageFormat.costLabel(usd: 312.4, unpricedRequests: 4), "$312.40 unpriced")
    }
}
