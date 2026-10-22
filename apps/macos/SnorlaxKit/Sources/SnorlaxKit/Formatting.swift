import Foundation

/// Display strings for token totals and USD cost.
///
/// Token totals use a 1000-based short form so `812345678` is `812M` (plan 3.11).
/// Fraction digits are 0 at 100 and above, 1 at 10 and above, and 2 below that;
/// trailing zeros after the decimal point are dropped. A number that rounds to
/// 1000 of a unit is shown in the next unit (`999500` is `1M`).
/// Cost always uses a `$` prefix, two fraction digits, and `,` grouping, so the
/// menu does not follow the Mac's locale.
public enum UsageFormat {
    public static func shortTokens(_ tokens: Int) -> String {
        if tokens < 1000 {
            return String(tokens)
        }
        let suffixes = ["K", "M", "B", "T"]
        var value = Double(tokens) / 1000
        var unit = 0
        while unit < suffixes.count - 1 && value >= 1000 {
            value /= 1000
            unit += 1
        }
        var places = fractionPlaces(value)
        var rounded = round(value, places: places)
        if rounded >= 1000, unit < suffixes.count - 1 {
            rounded /= 1000
            unit += 1
            places = fractionPlaces(rounded)
            rounded = round(rounded, places: places)
        }
        return render(rounded, places: places) + suffixes[unit]
    }

    public static func cost(_ usd: Double) -> String {
        let negative = usd < 0
        let cents = Int((abs(usd) * 100).rounded())
        let whole = cents / 100
        let fraction = cents % 100
        let text = "$\(grouped(whole)).\(String(format: "%02d", fraction))"
        return negative ? "-\(text)" : text
    }

    /// Cost plus the unpriced marker when the window counted requests with no price (Spec R9).
    public static func costLabel(usd: Double, unpricedRequests: Int) -> String {
        let text = cost(usd)
        return unpricedRequests > 0 ? "\(text) unpriced" : text
    }

    private static func fractionPlaces(_ value: Double) -> Int {
        if value >= 100 { return 0 }
        if value >= 10 { return 1 }
        return 2
    }

    private static func round(_ value: Double, places: Int) -> Double {
        let factor = pow(10, Double(places))
        return (value * factor).rounded() / factor
    }

    private static func render(_ value: Double, places: Int) -> String {
        if places == 0 {
            return String(Int(value.rounded()))
        }
        var text = String(format: "%.\(places)f", locale: Locale(identifier: "en_US_POSIX"), value)
        while text.hasSuffix("0") {
            text.removeLast()
        }
        if text.hasSuffix(".") {
            text.removeLast()
        }
        return text
    }

    private static func grouped(_ whole: Int) -> String {
        let digits = String(whole)
        var grouped = ""
        for (index, character) in digits.reversed().enumerated() {
            if index != 0, index.isMultiple(of: 3) {
                grouped.append(",")
            }
            grouped.append(character)
        }
        return String(grouped.reversed())
    }
}
