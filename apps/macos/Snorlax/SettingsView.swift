import ServiceManagement
import SnorlaxKit
import SwiftUI

/// File name passed to `SMAppService.agent(plistName:)`. The plist is copied to
/// `Contents/Library/LaunchAgents`. `register()` bootstraps the agent immediately,
/// so only the Settings toggle calls it. Launching the app must not.
enum LaunchAgentPlist {
    static let name = "io.github.perfectpan.snorlax.refresh.plist"
}

@MainActor
final class LoginItemModel: ObservableObject {
    @Published private(set) var statusText = "not read"
    @Published private(set) var enabled = false
    @Published private(set) var errorText: String?

    private var service: SMAppService?

    func refreshStatus() {
        let service = currentService()
        statusText = Self.describe(service.status)
        enabled = service.status == .enabled || service.status == .requiresApproval
    }

    func setEnabled(_ on: Bool) {
        let service = currentService()
        do {
            if on {
                try service.register()
            } else {
                try service.unregister()
            }
            errorText = nil
        } catch {
            errorText = error.localizedDescription
        }
        refreshStatus()
    }

    func openSettings() {
        SMAppService.openSystemSettingsLoginItems()
    }

    private func currentService() -> SMAppService {
        if let service { return service }
        let created = SMAppService.agent(plistName: LaunchAgentPlist.name)
        service = created
        return created
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

struct SettingsView: View {
    @ObservedObject var model: MenuModel
    @StateObject private var loginItem = LoginItemModel()

    var body: some View {
        Form {
            Section("Device") {
                TextField("Device name", text: Binding(
                    get: { model.deviceName },
                    set: { _ in }
                ))
                .disabled(true)
                Text(model.deviceNameNote)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Section("Launch at login") {
                Toggle("Launch at login", isOn: Binding(
                    get: { loginItem.enabled },
                    set: { loginItem.setEnabled($0) }
                ))
                Text("Login item: \(loginItem.statusText)")
                    .font(.caption)
                if let errorText = loginItem.errorText {
                    Text(errorText)
                        .font(.caption)
                        .textSelection(.enabled)
                }
                Button("Open Login Items Settings") {
                    loginItem.openSettings()
                }
            }
            Section("Diagnostics") {
                Button("Run diagnostics") {
                    model.runDiagnostics()
                }
                if let doctor = model.diagnostics {
                    Text(doctor.healthy ? "Healthy" : "Problems found")
                    ForEach(Array(doctor.checks.enumerated()), id: \.offset) { _, check in
                        Text("\(check.id): \(check.status.rawValue) — \(check.detail)")
                            .font(.caption)
                            .textSelection(.enabled)
                    }
                }
                if let diagnosticsError = model.diagnosticsError {
                    Text(diagnosticsError)
                        .font(.caption)
                        .textSelection(.enabled)
                }
            }
            Section("Days") {
                Text(model.timeZoneHelp)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .padding(8)
        .onAppear {
            loginItem.refreshStatus()
            model.loadDeviceName()
        }
    }
}
