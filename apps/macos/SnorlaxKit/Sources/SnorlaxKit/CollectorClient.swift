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
            let stdout = Pipe()
            let stderr = Pipe()
            let standardInput = Pipe()
            process.standardOutput = stdout
            process.standardError = stderr
            process.standardInput = standardInput
            let once = ResumeOnce(continuation)
            let collector = PipeCollector(stdout: stdout, stderr: stderr)
            // The run completes when the process ended and both pipes reached
            // EOF, so every output byte was already collected when it resumes.
            let finished = DispatchGroup()
            finished.enter() // process termination
            collector.start(onWait: finished.enter, onEOF: finished.leave)
            process.terminationHandler = { _ in finished.leave() }
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
                    if process.isRunning {
                        process.terminate()
                        once.resume(throwing: CollectorClientError.timedOut)
                    } else {
                        // The process ended but a pipe never reached EOF, for
                        // example a grandchild holding the write end open.
                        // Finish with what arrived instead of blocking forever.
                        let output = collector.collectedOutput()
                        once.resume(returning: ProcessOutput(status: process.terminationStatus, stdout: output.stdout, stderr: output.stderr))
                    }
                    return
                }
                let output = collector.drain()
                once.resume(returning: ProcessOutput(status: process.terminationStatus, stdout: output.stdout, stderr: output.stderr))
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

/// Collects pipe output as it arrives so the child never blocks on a full pipe
/// buffer, and drains what is left once both pipes are at EOF.
private final class PipeCollector: @unchecked Sendable {
    private let stdout: Pipe
    private let stderr: Pipe
    private let lock = NSLock()
    private var collected: [Channel: Data] = [:]
    private var eofSeen: Set<Channel> = []

    private enum Channel: Int {
        case stdout
        case stderr
    }

    init(stdout: Pipe, stderr: Pipe) {
        self.stdout = stdout
        self.stderr = stderr
    }

    func start(onWait: @escaping () -> Void, onEOF: @escaping () -> Void) {
        collect(stdout, channel: .stdout, onWait: onWait, onEOF: onEOF)
        collect(stderr, channel: .stderr, onWait: onWait, onEOF: onEOF)
    }

    /// Called after both pipes are at EOF, so no handler is in flight and the
    /// remaining reads cannot block.
    func drain() -> (stdout: Data, stderr: Data) {
        stdout.fileHandleForReading.readabilityHandler = nil
        stderr.fileHandleForReading.readabilityHandler = nil
        lock.lock()
        collected[.stdout, default: Data()].append(stdout.fileHandleForReading.readDataToEndOfFile())
        collected[.stderr, default: Data()].append(stderr.fileHandleForReading.readDataToEndOfFile())
        let output = (collected[.stdout] ?? Data(), collected[.stderr] ?? Data())
        lock.unlock()
        return output
    }

    /// What arrived so far, for a process that ended while a pipe is still open.
    func collectedOutput() -> (stdout: Data, stderr: Data) {
        stdout.fileHandleForReading.readabilityHandler = nil
        stderr.fileHandleForReading.readabilityHandler = nil
        lock.lock()
        defer { lock.unlock() }
        return (collected[.stdout] ?? Data(), collected[.stderr] ?? Data())
    }

    private func collect(_ pipe: Pipe, channel: Channel, onWait: @escaping () -> Void, onEOF: @escaping () -> Void) {
        onWait()
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            guard !chunk.isEmpty else {
                handle.readabilityHandler = nil
                self?.noteEOF(channel: channel, onEOF: onEOF)
                return
            }
            self?.append(chunk, channel: channel)
        }
    }

    /// The monitor can deliver a second empty read before the handler removal
    /// takes effect; the group must hear about EOF once per channel.
    private func noteEOF(channel: Channel, onEOF: @escaping () -> Void) {
        lock.lock()
        defer { lock.unlock() }
        guard !eofSeen.contains(channel) else { return }
        eofSeen.insert(channel)
        onEOF()
    }

    private func append(_ chunk: Data, channel: Channel) {
        lock.lock()
        defer { lock.unlock() }
        collected[channel, default: Data()].append(chunk)
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
