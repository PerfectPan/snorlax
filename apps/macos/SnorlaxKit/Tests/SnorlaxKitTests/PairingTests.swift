import XCTest
import SnorlaxKit

@MainActor
final class PairingModelTests: XCTestCase {
    func testPairSendsTheTokenOnlyOnStdin() async {
        let token = "snorlax-test-admin-token"
        let runner = ScriptedRunner()
        runner.enqueue(output(pairResult(name: "MacBook Pro"), status: 0))
        let model = prepared(runner, token: token)

        await model.pair()

        XCTAssertEqual(runner.calls.count, 1)
        XCTAssertEqual(
            runner.calls[0].arguments,
            ["pair", "--url", "https://snorlax.example.com", "--name", "MacBook Pro", "--json"]
        )
        XCTAssertEqual(runner.calls[0].stdin, Data((token + "\n").utf8))
        XCTAssertFalse(runner.calls[0].arguments.contains { $0.contains(token) })
        XCTAssertEqual(model.adminToken, "")
        XCTAssertFalse(model.running)
        let stored = UserDefaults.standard.dictionaryRepresentation().contains { key, value in
            key.contains(token) || String(describing: value).contains(token)
        }
        XCTAssertFalse(stored)
    }

    func testTokenIsClearedAfterAFailedPair() async {
        let runner = ScriptedRunner()
        runner.enqueue(output(failure(code: "network", message: "connection refused"), status: 1))
        let model = prepared(runner, token: "snorlax-test-admin-token")

        await model.pair()

        XCTAssertEqual(model.adminToken, "")
        XCTAssertEqual(model.notice, "The backend could not be reached. connection refused")
    }

    func testFailureCodesKeepTheCollectorMessage() async {
        let cases: [(String, Int32, String)] = [
            ("unauthorized", 1, "The admin token was not accepted."),
            ("conflict", 1, "This device is already registered and has not been revoked. Revoke it with the admin token, then pair again."),
            ("network", 1, "The backend could not be reached."),
            ("keychain", 1, "The backend registered this device, but the device token was not saved in the keychain. Revoke the device, then pair again."),
            ("forbidden", 1, "The backend refused this pairing."),
            ("invalid-response", 1, "The collector could not read the backend's response."),
            ("invalid-arguments", 2, "The backend URL or the device name was not accepted. The URL must use https, except http for localhost, 127.0.0.1, and [::1]."),
            ("pricing", 1, "Pairing failed (pricing).")
        ]
        for (code, status, summary) in cases {
            let runner = ScriptedRunner()
            let detail = "detail-\(code)"
            runner.enqueue(output(failure(code: code, message: detail), status: status))
            let model = prepared(runner, token: "token-\(code)")

            await model.pair()

            XCTAssertEqual(model.adminToken, "", code)
            XCTAssertEqual(model.notice, "\(summary) \(detail)", code)
            XCTAssertEqual(runner.calls.count, 1, code)
            XCTAssertFalse(runner.calls[0].arguments.contains { $0.contains("token-\(code)") }, code)
        }
    }

    func testUnpairArguments() async {
        let runner = ScriptedRunner()
        runner.enqueue(output(Ok(ok: true, schemaVersion: 1), status: 0))
        let model = PairingModel(client: client(runner))
        model.adminToken = "left-in-the-field"

        await model.unpair()

        XCTAssertEqual(runner.calls.count, 1)
        XCTAssertEqual(runner.calls[0].arguments, ["unpair", "--json"])
        XCTAssertNil(runner.calls[0].stdin)
        XCTAssertEqual(model.adminToken, "left-in-the-field")
        XCTAssertNil(model.notice)
    }

    func testASecondTriggerWhileRunningStartsNoProcess() async {
        let runner = HoldingRunner()
        let model = prepared(runner, token: "snorlax-test-admin-token")
        let first = Task { await model.pair() }
        await runner.waitForCalls(1)

        await model.pair()
        await model.unpair()

        XCTAssertEqual(runner.calls.count, 1)
        XCTAssertEqual(model.adminToken, "snorlax-test-admin-token")
        runner.resume(output(pairResult(name: "MacBook Pro"), status: 0))
        await first.value
        XCTAssertEqual(runner.calls.count, 1)
        XCTAssertEqual(model.adminToken, "")
        XCTAssertFalse(model.running)
    }

    func testEmptyFieldsDoNotStartPairingOrClearTheToken() async {
        let runner = ScriptedRunner()
        let model = PairingModel(client: client(runner))
        model.adminToken = "snorlax-test-admin-token"
        model.deviceName = "MacBook Pro"

        await model.pair()

        XCTAssertTrue(runner.calls.isEmpty)
        XCTAssertEqual(model.adminToken, "snorlax-test-admin-token")
        XCTAssertFalse(model.canPair)
    }

    func testDeviceNameDefaultsFromStatusOnlyWhenTheFieldIsEmpty() async {
        let named = ScriptedRunner()
        named.enqueue(output(status(name: "MacBook Pro"), status: 0))
        let fill = PairingModel(client: client(named))
        await fill.loadDefaultDeviceName()
        XCTAssertEqual(fill.deviceName, "MacBook Pro")

        let blank = ScriptedRunner()
        blank.enqueue(output(status(name: nil), status: 0))
        let stayEmpty = PairingModel(client: client(blank))
        await stayEmpty.loadDefaultDeviceName()
        XCTAssertEqual(stayEmpty.deviceName, "")

        let kept = ScriptedRunner()
        kept.enqueue(output(status(name: "MacBook Pro"), status: 0))
        let existing = PairingModel(client: client(kept))
        existing.deviceName = "Work"
        await existing.loadDefaultDeviceName()
        XCTAssertEqual(existing.deviceName, "Work")
    }

    func testApplyReadsPairingFromTheSnapshot() {
        let model = PairingModel(client: client(ScriptedRunner()))
        let now = UsageFormat.instant("2026-10-23T02:38:10Z")!
        model.apply(
            status: SnapshotStatus(
                failuresByAgent: [:],
                lastScanAt: nil,
                paired: true,
                sync: SnapshotSync(at: "2026-10-23T02:35:10Z", state: .ok)
            ),
            now: now,
            timeZone: TimeZone(secondsFromGMT: 0)!
        )
        XCTAssertTrue(model.paired)
        XCTAssertEqual(model.syncStateText, "ok")
        XCTAssertEqual(model.lastSyncText, "3 min ago")

        model.apply(
            status: SnapshotStatus(
                failuresByAgent: [:],
                lastScanAt: nil,
                paired: true,
                sync: SnapshotSync(at: nil, state: .failed)
            ),
            now: now
        )
        XCTAssertEqual(model.syncStateText, "failed")
        XCTAssertEqual(model.lastSyncText, "—")

        model.apply(status: nil, now: now)
        XCTAssertFalse(model.paired)
        XCTAssertEqual(model.syncStateText, "—")
    }

    private func prepared(_ runner: any ProcessRunning, token: String) -> PairingModel {
        let model = PairingModel(client: client(runner))
        model.backendURL = "https://snorlax.example.com"
        model.deviceName = "MacBook Pro"
        model.adminToken = token
        return model
    }

    private func client(_ runner: any ProcessRunning) -> CollectorClient {
        CollectorClient(executable: URL(fileURLWithPath: "/usr/bin/false"), runner: runner)
    }

    private func pairResult(name: String) -> PairResult {
        PairResult(deviceId: "device-1", name: name, ok: true, schemaVersion: 1)
    }

    private func failure(code: String, message: String) -> Failure {
        Failure(error: FailureError(code: code, message: message), ok: false, schemaVersion: 1)
    }

    private func status(name: String?) -> Status {
        Status(
            agents: [],
            dataDir: "~/Library/Application Support/snorlax",
            device: Device(id: nil, name: name),
            failuresByAgent: [:],
            lastScanAt: nil,
            ok: true,
            pricingChanged: false,
            schemaVersion: 1,
            sync: StatusSync(at: nil, state: .unpaired),
            version: "0.0.0"
        )
    }

    private func output(_ value: some Encodable, status: Int32) -> ProcessOutput {
        ProcessOutput(status: status, stdout: try! JSONEncoder().encode(value), stderr: Data())
    }
}

private final class ScriptedRunner: ProcessRunning, @unchecked Sendable {
    private let lock = NSLock()
    private var scripts: [ProcessOutput] = []
    private(set) var calls: [(arguments: [String], stdin: Data?)] = []

    func enqueue(_ output: ProcessOutput) {
        lock.lock()
        scripts.append(output)
        lock.unlock()
    }

    func run(executable: URL, arguments: [String], stdin: Data?, timeout: Duration) async throws -> ProcessOutput {
        if let output = next(arguments: arguments, stdin: stdin) { return output }
        throw CollectorClientError.launchFailed("no scripted output")
    }

    /// The lock stays in a synchronous function. `NSLock` is unavailable directly
    /// in an async function.
    private func next(arguments: [String], stdin: Data?) -> ProcessOutput? {
        lock.lock()
        defer { lock.unlock() }
        calls.append((arguments, stdin))
        return scripts.isEmpty ? nil : scripts.removeFirst()
    }
}

/// Suspends the first `run` until `resume`, so a second trigger can be attempted
/// while the first attempt is still inside the collector.
private final class HoldingRunner: ProcessRunning, @unchecked Sendable {
    private let lock = NSLock()
    private var pending: CheckedContinuation<ProcessOutput, Error>?
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private(set) var calls: [(arguments: [String], stdin: Data?)] = []

    func run(executable: URL, arguments: [String], stdin: Data?, timeout: Duration) async throws -> ProcessOutput {
        try await withCheckedThrowingContinuation { continuation in
            let toWake = begin(arguments: arguments, stdin: stdin, continuation: continuation)
            // Resume waiters after this function has suspended. Resuming them
            // inline would continue the test before `pending` is waiting.
            Task { toWake.forEach { $0.resume() } }
        }
    }

    func waitForCalls(_ count: Int) async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            if park(count, continuation) {
                Task { continuation.resume() }
            }
        }
    }

    func resume(_ output: ProcessOutput) {
        let continuation = takePending()
        continuation?.resume(returning: output)
    }

    private func begin(
        arguments: [String],
        stdin: Data?,
        continuation: CheckedContinuation<ProcessOutput, Error>
    ) -> [CheckedContinuation<Void, Never>] {
        lock.lock()
        defer { lock.unlock() }
        calls.append((arguments, stdin))
        pending = continuation
        let toWake = waiters
        waiters.removeAll()
        return toWake
    }

    /// True when the call is already recorded. Otherwise the continuation is
    /// parked under the same lock, so it cannot miss the `run` that records it.
    private func park(_ count: Int, _ continuation: CheckedContinuation<Void, Never>) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if calls.count >= count { return true }
        waiters.append(continuation)
        return false
    }

    private func takePending() -> CheckedContinuation<ProcessOutput, Error>? {
        lock.lock()
        defer { lock.unlock() }
        let continuation = pending
        pending = nil
        return continuation
    }
}
