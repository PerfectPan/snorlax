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
    public init() {}

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
            process.terminationHandler = { process in
                let out = stdout.fileHandleForReading.readDataToEndOfFile()
                let err = stderr.fileHandleForReading.readDataToEndOfFile()
                once.resume(returning: ProcessOutput(status: process.terminationStatus, stdout: out, stderr: err))
            }
            do {
                try process.run()
            } catch {
                once.resume(throwing: CollectorClientError.launchFailed(error.localizedDescription))
                return
            }
            if let stdin {
                try? standardInput.fileHandleForWriting.write(contentsOf: stdin)
            }
            try? standardInput.fileHandleForWriting.close()
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout.seconds) {
                guard process.isRunning else { return }
                process.terminate()
                once.resume(throwing: CollectorClientError.timedOut)
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
