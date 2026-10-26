import Darwin
import Foundation

public struct ProcessOutput: Equatable, Sendable {
    public var status: Int32
    public var stdout: Data
    public var stderr: Data

    public init(status: Int32, stdout: Data, stderr: Data) {
        self.status = status
        self.stdout = stdout
        self.stderr = stderr
    }
}

public protocol ProcessRunning: Sendable {
    func run(executable: URL, arguments: [String], stdin: Data?, timeout: Duration) async throws -> ProcessOutput
}

public enum CollectorClientError: Error, Equatable {
    case failed(Failure)
    case newerCollector
    /// `timeout` is the budget this run actually used, not the client's default.
    case timedOut(Duration)
    case launchFailed(String)
    case unreadable(exitCode: Int32, stdout: String, stderr: String)
}

extension CollectorClientError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case let .failed(failure):
            return failure.error.message
        case .newerCollector:
            return SchemaGate.newerCollectorMessage
        case let .timedOut(timeout):
            return "The collector did not finish within \(Self.seconds(timeout)) seconds."
        case let .launchFailed(message):
            return message
        case let .unreadable(_, stdout, stderr):
            if !stderr.isEmpty { return stderr }
            if !stdout.isEmpty { return stdout }
            return "The collector returned an unreadable result."
        }
    }

    /// Whole seconds when the budget is whole. A fractional budget keeps its
    /// fraction so the sentence cannot name a shorter timeout than the one used.
    private static func seconds(_ timeout: Duration) -> String {
        let (seconds, attoseconds) = timeout.components
        if attoseconds == 0 {
            return String(seconds)
        }
        return String(Double(seconds) + Double(attoseconds) / 1e18)
    }
}

/// Runs the bundled launcher with `--json`, optional stdin, and a 120 s timeout (plan 3.11).
/// Exit 0 decodes `Success`. Any other exit decodes the failure shape.
public struct CollectorClient: Sendable {
    public var executable: URL
    public var runner: any ProcessRunning
    public var timeout: Duration

    public init(
        executable: URL,
        runner: any ProcessRunning = FoundationProcessRunner(),
        timeout: Duration = .seconds(120)
    ) {
        self.executable = executable
        self.runner = runner
        self.timeout = timeout
    }

    public func run<Success: Decodable>(
        _ arguments: [String],
        stdin: Data? = nil,
        timeout: Duration? = nil,
        as type: Success.Type
    ) async throws -> Success {
        var args = arguments
        if !args.contains("--json") {
            args.append("--json")
        }
        let output: ProcessOutput
        do {
            // `timeout` is this command's budget. `pair` passes a longer one;
            // every other caller keeps the client's 120 seconds.
            output = try await runner.run(
                executable: executable,
                arguments: args,
                stdin: stdin,
                timeout: timeout ?? self.timeout
            )
        } catch let error as CollectorClientError {
            throw error
        } catch {
            throw CollectorClientError.launchFailed(error.localizedDescription)
        }
        do {
            try SchemaGate.rejectIfUnsupported(output.stdout)
        } catch SchemaError.newerCollector {
            throw CollectorClientError.newerCollector
        }
        if output.status != 0 {
            do {
                throw CollectorClientError.failed(try JSONDecoder().decode(Failure.self, from: output.stdout))
            } catch let error as CollectorClientError {
                throw error
            } catch {
                throw unreadable(output)
            }
        }
        do {
            return try JSONDecoder().decode(Success.self, from: output.stdout)
        } catch {
            throw unreadable(output)
        }
    }

    private func unreadable(_ output: ProcessOutput) -> CollectorClientError {
        CollectorClientError.unreadable(
            exitCode: output.status,
            stdout: String(data: output.stdout, encoding: .utf8) ?? "",
            stderr: String(data: output.stderr, encoding: .utf8) ?? ""
        )
    }

    /// What a run that ran out of budget does once the exit event has settled.
    public enum TimeoutPlan: Equatable, Sendable {
        /// The child ended by itself: its output is the result.
        case collect
        /// The child had to be killed: report the timeout.
        case reportTimeout
    }

    /// Decides from the termination reason — the exit EVENT — not from
    /// `isRunning`, whose reaping can lag the actual exit.
    public static func timeoutPlan(terminatedBySignal: Bool) -> TimeoutPlan {
        terminatedBySignal ? .reportTimeout : .collect
    }
}

public struct FoundationProcessRunner: ProcessRunning {
    public init() {
        // A child that exits without reading stdin must not take the app down:
        // with SIGPIPE ignored, write(2) fails with EPIPE and the writer stops.
        signal(SIGPIPE, SIG_IGN)
    }

    public func run(executable: URL, arguments: [String], stdin: Data?, timeout: Duration) async throws -> ProcessOutput {
        try await withCheckedThrowingContinuation { continuation in
            let process = Process()
            process.executableURL = executable
            process.arguments = arguments
            let stdoutPipe = Pipe()
            let stderrPipe = Pipe()
            let standardInput = Pipe()
            process.standardOutput = stdoutPipe
            process.standardError = stderrPipe
            process.standardInput = standardInput
            let once = ResumeOnce(continuation)
            let out = PipeOutput(stdoutPipe)
            let err = PipeOutput(stderrPipe)
            // The run completes when the process ended and both pipes reached
            // EOF, so every output byte was already collected when it resumes.
            let finished = DispatchGroup()
            finished.enter() // process termination
            out.start(onWait: finished.enter, onEOF: finished.leave)
            err.start(onWait: finished.enter, onEOF: finished.leave)
            let terminated = DispatchGroup()
            terminated.enter()
            process.terminationHandler = { _ in
                finished.leave()
                terminated.leave()
            }
            do {
                try process.run()
            } catch {
                once.resume(throwing: CollectorClientError.launchFailed(error.localizedDescription))
                return
            }
            // The timeout starts with the process, before any stdin is written:
            // a child stuck on a full pipe must still be terminated in time.
            DispatchQueue.global().async {
                // The whole budget goes to the exit event, never to pipes: a
                // grandchild holding the write end must not consume it.
                var endedBySignal = false
                if terminated.wait(timeout: .now() + timeout.seconds) == .timedOut {
                    if process.isRunning { process.terminate() }
                    if terminated.wait(timeout: .now() + 1) == .timedOut {
                        kill(process.processIdentifier, SIGKILL)
                        if terminated.wait(timeout: .now() + 1) == .timedOut {
                            once.resume(throwing: CollectorClientError.timedOut(timeout))
                            return
                        }
                    }
                    endedBySignal = process.terminationReason != .exit
                }
                // A child a signal ended reports the timeout without pipe
                // grace; a self-exited one gets a short grace, then what
                // arrived is the result even if a grandchild holds the pipe.
                let eofMissing = endedBySignal || finished.wait(timeout: .now() + PipeOutput.eofGrace) == .timedOut
                switch CollectorClient.timeoutPlan(terminatedBySignal: endedBySignal) {
                case .collect:
                    let output = eofMissing
                        ? ProcessOutput(status: process.terminationStatus, stdout: out.collected(), stderr: err.collected())
                        : ProcessOutput(status: process.terminationStatus, stdout: out.drain(), stderr: err.drain())
                    once.resume(returning: output)
                case .reportTimeout:
                    once.resume(throwing: CollectorClientError.timedOut(timeout))
                }
            }
            let writer = standardInput.fileHandleForWriting
            if let stdin {
                // Written off the run's flow: a large body must not block, and
                // a child that exited early must not crash the app on EPIPE.
                DispatchQueue.global().async {
                    Self.writeAll(stdin, to: writer)
                    try? writer.close()
                }
            } else {
                try? writer.close()
            }
        }
    }

    /// POSIX write loop. `FileHandle.write` raises an exception on EPIPE, so a
    /// reader that is already gone is handled here as a plain error instead.
    private static func writeAll(_ data: Data, to handle: FileHandle) {
        data.withUnsafeBytes { (buffer: UnsafeRawBufferPointer) in
            var offset = 0
            while offset < buffer.count {
                let written = write(handle.fileDescriptor, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
                if written < 0 {
                    if errno == EINTR { continue }
                    return
                }
                if written == 0 { return }
                offset += written
            }
        }
    }
}

private final class ResumeOnce: @unchecked Sendable {
    private let continuation: CheckedContinuation<ProcessOutput, Error>
    private let lock = NSLock()
    private var resumed = false

    init(_ continuation: CheckedContinuation<ProcessOutput, Error>) {
        self.continuation = continuation
    }

    func resume(returning output: ProcessOutput) {
        finish { continuation.resume(returning: output) }
    }

    func resume(throwing error: Error) {
        finish { continuation.resume(throwing: error) }
    }

    private func finish(_ body: () -> Void) {
        lock.lock()
        defer { lock.unlock() }
        guard !resumed else { return }
        resumed = true
        body()
    }
}

private extension Duration {
    var seconds: TimeInterval {
        let parts = components
        return TimeInterval(parts.seconds) + TimeInterval(parts.attoseconds) / 1e18
    }
}
