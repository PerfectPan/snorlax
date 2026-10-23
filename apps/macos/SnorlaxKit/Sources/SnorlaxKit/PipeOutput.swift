import Foundation

/// Collects one pipe's output as it arrives so a writing child never blocks on
/// a full pipe buffer. EOF is reported to the owner exactly once; the monitor
/// can deliver a second empty read before the handler removal takes effect.
final class PipeOutput: @unchecked Sendable {
    private let handle: FileHandle
    private let lock = NSLock()
    private var data = Data()
    private var eofSeen = false

    init(_ pipe: Pipe) {
        handle = pipe.fileHandleForReading
    }

    /// Starts collecting. `onWait` balances one pending EOF, so a group can
    /// count the pipe as an async completion before any event can fire.
    func start(onWait: @escaping () -> Void, onEOF: @escaping () -> Void) {
        onWait()
        handle.readabilityHandler = { [weak self] fileHandle in
            guard let self else { return }
            let chunk = fileHandle.availableData
            if chunk.isEmpty {
                fileHandle.readabilityHandler = nil
                self.noteEOF(onEOF)
            } else {
                self.append(chunk)
            }
        }
    }

    /// What arrived so far, for a process that ended while the pipe is open.
    func collected() -> Data {
        handle.readabilityHandler = nil
        lock.lock()
        defer { lock.unlock() }
        return data
    }

    /// Everything, after EOF: no handler is in flight and the remaining read
    /// cannot block.
    func drain() -> Data {
        handle.readabilityHandler = nil
        lock.lock()
        data.append(handle.readDataToEndOfFile())
        let all = data
        lock.unlock()
        return all
    }

    private func noteEOF(_ onEOF: @escaping () -> Void) {
        lock.lock()
        defer { lock.unlock() }
        guard !eofSeen else { return }
        eofSeen = true
        onEOF()
    }

    private func append(_ chunk: Data) {
        lock.lock()
        defer { lock.unlock() }
        data.append(chunk)
    }
}
