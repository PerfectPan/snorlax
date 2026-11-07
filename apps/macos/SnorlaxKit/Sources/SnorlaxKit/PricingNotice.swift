import Foundation

extension Status {
    /// Only a confirmed pricing-table mismatch shows advice. Repricing is an
    /// explicit owner action: the app must not rescan logs automatically.
    public var pricingNotice: String? {
        pricingChanged
            ? "The pricing table has changed. Costs may be out of date. Run `snorlax rebuild --days 180` to update them."
            : nil
    }
}
