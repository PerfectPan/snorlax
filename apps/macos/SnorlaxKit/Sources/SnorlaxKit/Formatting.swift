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

    /// Cost plus the unpriced marker (Spec R9). When every request in the window
    /// is unpriced the amount says nothing, so the label is just `unpriced`;
    /// when some are, the shown total is a lower bound: `≥ $x.xx`.
    public static func costLabel(costText: String, requests: Int, unpricedRequests: Int) -> String {
        guard unpricedRequests > 0 else { return costText }
        if requests > 0, unpricedRequests >= requests {
            return "unpriced"
        }
        return "≥ \(costText)"
    }

    /// A daily date like `2026-10-22` as the start of that day in `timeZone`
    /// (R8: the snapshot cut its days there). Days whose midnight does not
    /// exist in a DST-switching zone resolve to that zone's first moment of
    /// the day. nil when unparseable; the date must format back to the input,
    /// so separators and out-of-range days cannot drift.
    public static func dayDate(_ text: String, timeZone: TimeZone) -> Date? {
        let parts = text.split(separator: "-", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 3,
              let year = parts[0].count == 4 ? Int(parts[0]) : nil,
              let month = parts[1].count == 2 ? Int(parts[1]) : nil,
              let day = parts[2].count == 2 ? Int(parts[2]) : nil
        else {
            return nil
        }
        var components = DateComponents()
        components.year = year
        components.month = month
        components.day = day
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        guard let date = calendar.date(from: components),
              dayFormatter(timeZone).string(from: date) == text else {
            return nil
        }
        return date
    }

    /// Chart axis label `M/d`, formatted in the zone the days were parsed in.
    public static func dayLabel(_ date: Date, timeZone: TimeZone) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = timeZone
        formatter.dateFormat = "M/d"
        return formatter.string(from: date)
    }

    /// The calendar Swift Charts must bin and stride the daily marks with:
    /// `unit: .day` follows the calendar passed to the mark and the axis, not
    /// the environment time zone (R8).
    public static func dayCalendar(_ timeZone: TimeZone) -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return calendar
    }

    /// An ISO 8601 instant as a relative text: `just now`, `3 min ago`,
    /// `2 hr ago`, `1 day ago`; a week or older (or in the future) shows the
    /// local date-time. nil when unparseable. Handles timestamps with and
    /// without fractional seconds.
    public static func instantText(_ iso: String, now: Date, timeZone: TimeZone) -> String? {
        guard let date = instant(iso) else { return nil }
        let delta = now.timeIntervalSince(date)
        if delta < 0 || delta >= 7 * 86_400 {
            return localText(date, timeZone: timeZone)
        }
        if delta < 60 { return "just now" }
        if delta < 3_600 { return "\(Int(delta / 60)) min ago" }
        if delta < 86_400 { return "\(Int(delta / 3_600)) hr ago" }
        let days = Int(delta / 86_400)
        return days == 1 ? "1 day ago" : "\(days) days ago"
    }

    /// ISO 8601 with or without fractional seconds.
    public static func instant(_ iso: String) -> Date? {
        if let date = fractionalSecondsFormatter.date(from: iso) { return date }
        return wholeSecondsFormatter.date(from: iso)
    }

    private static func localText(_ date: Date, timeZone: TimeZone) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = timeZone
        formatter.dateFormat = "yyyy-MM-dd HH:mm"
        return formatter.string(from: date)
    }

    private static func dayFormatter(_ timeZone: TimeZone) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = timeZone
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }

    private static let fractionalSecondsFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let wholeSecondsFormatter = ISO8601DateFormatter()

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
