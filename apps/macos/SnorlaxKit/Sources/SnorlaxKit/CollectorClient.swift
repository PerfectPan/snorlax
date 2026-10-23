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
    case timedOut
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
        case .timedOut:
            return "The collector did not finish within 120 seconds."
        case let .launchFailed(message):
            return message
        case let .unreadable(_, stdout, stderr):
            if !stderr.isEmpty { return stderr }
            if !stdout.isEmpty { return stdout }
            return "The collector returned an unreadable result."
        }
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
        as type: Success.Type
    ) async throws -> Success {
        var args = arguments
        if !args.contains("--json") {
            args.append("--json")
        }
        let output: ProcessOutput
        do {
            output = try await runner.run(executable: executable, arguments: args, stdin: stdin, timeout: timeout)
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
                if finished.wait(timeout: .now() + timeout.seconds) == .timedOut {
                    if process.isRunning { process.terminate() }
                    guard terminated.wait(timeout: .now() + 1) == .success else {
                        once.resume(throwing: CollectorClientError.timedOut)
                        return
                    }
                    switch CollectorClient.timeoutPlan(terminatedBySignal: process.terminationReason != .exit) {
                    case .collect:
                        // The child ended by itself but a pipe never reached
                        // EOF, for example a grandchild holding the write
                        // end; finish with what arrived instead of a false
                        // timeout.
                        once.resume(returning: ProcessOutput(status: process.terminationStatus, stdout: out.collected(), stderr: err.collected()))
                    case .reportTimeout:
                        once.resume(throwing: CollectorClientError.timedOut)
                    }
                    return
                }
                once.resume(returning: ProcessOutput(status: process.terminationStatus, stdout: out.drain(), stderr: err.drain()))
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
