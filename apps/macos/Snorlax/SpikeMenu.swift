import ServiceManagement
import SwiftUI

/// File name passed to `SMAppService.agent(plistName:)`. The plist is copied to
/// `Contents/Library/LaunchAgents`. `register()` bootstraps the agent immediately,
/// so only the menu buttons call it. Launching the app must not.
enum LaunchAgentPlist {
    static let name = "io.github.perfectpan.snorlax.refresh.plist"
}

@MainActor
final class LoginItemModel: ObservableObject {
    @Published private(set) var statusText = "not read"
    @Published private(set) var errorText: String?

    private let service = SMAppService.agent(plistName: LaunchAgentPlist.name)

    func refreshStatus() {
        statusText = Self.describe(service.status)
    }

    func register() {
        do {
            try service.register()
            errorText = nil
        } catch {
            errorText = error.localizedDescription
        }
        refreshStatus()
    }

    func unregister() {
        do {
            try service.unregister()
            errorText = nil
        } catch {
            errorText = error.localizedDescription
        }
        refreshStatus()
    }

    func openSettings() {
        SMAppService.openSystemSettingsLoginItems()
    }

    private static func describe(_ status: SMAppService.Status) -> String {
        switch status {
        case .notRegistered:
            return "not registered"
        case .enabled:
            return "enabled"
        case .requiresApproval:
            return "requires approval in System Settings"
        case .notFound:
            return "not found (plist is missing from the bundle)"
        default:
            return "unknown"
        }
    }
}

struct SpikeMenu: View {
    @ObservedObject var model: SpikeModel
    @StateObject private var loginItem = LoginItemModel()

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Spike value")
                .font(.headline)
            Text(model.valueText)
                .font(.title2)
            Text("App Group")
                .font(.headline)
            Text(model.appGroupIdentifier)
                .font(.caption)
                .textSelection(.enabled)
            Text(model.containerDetail)
                .font(.caption)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            Divider()
            Text("Login item: \(loginItem.statusText)")
            if let errorText = loginItem.errorText {
                Text(errorText)
                    .font(.caption)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Button("Register login item") {
                loginItem.register()
            }
            Button("Unregister login item") {
                loginItem.unregister()
            }
            Button("Open Login Items Settings") {
                loginItem.openSettings()
            }
            Divider()
            Button("Quit") {
                NSApplication.shared.terminate(nil)
            }
        }
        .padding(12)
        .frame(width: 360)
        .onAppear {
            loginItem.refreshStatus()
        }
    }
}
