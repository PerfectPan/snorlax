import Darwin
import Foundation

/// Cancels one scheduled watcher callback.
public protocol WatchCanceling: AnyObject {
    func cancel()
}

/// Schedules the directory debounce and the fallback poll.
/// Production uses `DispatchWatchScheduler`. Tests advance a manual clock.
public protocol WatchScheduling: AnyObject {
    func schedule(after delay: Duration, execute: @escaping () -> Void) -> any WatchCanceling
    func scheduleRepeating(every interval: Duration, execute: @escaping () -> Void) -> any WatchCanceling
}

/// Watches the data directory because a refresh replaces `snapshot.json` by rename (plan 3.11).
/// Directory events are debounced 200 ms. A 60 s timer polls in case an event is missed.
public final class SnapshotWatcher {
    public static let debounce: Duration = .milliseconds(200)
    public static let fallbackInterval: Duration = .seconds(60)

    private let scheduler: any WatchScheduling
    private var onChange: () -> Void
    private var debounceToken: (any WatchCanceling)?
    private var fallbackToken: (any WatchCanceling)?
    private var source: DispatchSourceFileSystemObject?

    public init(scheduler: any WatchScheduling, onChange: @escaping () -> Void = {}) {
        self.scheduler = scheduler
        self.onChange = onChange
    }

    /// Replaces the callback after `init`, so a caller can capture itself once it exists.
    public func setHandler(_ onChange: @escaping () -> Void) {
        self.onChange = onChange
    }

    /// Starts the fallback timer and a file-system source on `directory`.
    /// The source delivers events on the main queue, so `scheduler` should too.
    public func start(directory: URL) {
        stop()
        startFallback()
        let fd = open(directory.path, O_EVTONLY)
        guard fd >= 0 else { return }
        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd,
            eventMask: [.write, .rename, .delete, .extend, .link, .attrib],
            queue: .main
        )
        source.setEventHandler { [weak self] in
            self?.noteDirectoryEvent()
        }
        source.setCancelHandler {
            close(fd)
        }
        source.resume()
        self.source = source
    }

    /// Starts only the 60 s poll. Tests use this so they do not open a file-system source.
    public func startFallback() {
        fallbackToken?.cancel()
        fallbackToken = scheduler.scheduleRepeating(every: Self.fallbackInterval) { [weak self] in
            self?.onChange()
        }
    }

    public func stop() {
        debounceToken?.cancel()
        debounceToken = nil
        fallbackToken?.cancel()
        fallbackToken = nil
        source?.cancel()
        source = nil
    }

    /// File-system events call this. Tests call it and advance an injected scheduler.
    public func noteDirectoryEvent() {
        debounceToken?.cancel()
        debounceToken = scheduler.schedule(after: Self.debounce) { [weak self] in
            self?.onChange()
        }
    }

    deinit {
        stop()
    }
}

public final class DispatchWatchScheduler: WatchScheduling {
    private let queue: DispatchQueue

    public init(queue: DispatchQueue = .main) {
        self.queue = queue
    }

    public func schedule(after delay: Duration, execute: @escaping () -> Void) -> any WatchCanceling {
        let work = DispatchWorkItem(block: execute)
        queue.asyncAfter(deadline: .now() + delay.seconds, execute: work)
        return WorkCancel(work)
    }

    public func scheduleRepeating(every interval: Duration, execute: @escaping () -> Void) -> any WatchCanceling {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        let seconds = interval.seconds
        timer.schedule(deadline: .now() + seconds, repeating: seconds)
        timer.setEventHandler(handler: execute)
        timer.resume()
        return TimerCancel(timer)
    }
}

private final class WorkCancel: WatchCanceling {
    private let work: DispatchWorkItem
    init(_ work: DispatchWorkItem) { self.work = work }
    func cancel() { work.cancel() }
}

private final class TimerCancel: WatchCanceling {
    private let timer: DispatchSourceTimer
    init(_ timer: DispatchSourceTimer) { self.timer = timer }
    func cancel() { timer.cancel() }
}

private extension Duration {
    var seconds: TimeInterval {
        let parts = components
        return TimeInterval(parts.seconds) + TimeInterval(parts.attoseconds) / 1e18
    }
}
