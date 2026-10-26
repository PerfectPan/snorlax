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
            SyncSection(pairing: model.pairing)
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
                // S1 debug info: the App Group id and where the widget copy lives.
                Text(model.appGroupIdentifier)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                Text(model.appGroupDetail)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
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
            model.pairing.apply(status: model.snapshotStatus)
            Task { await model.pairing.loadDefaultDeviceName() }
        }
        .onChange(of: model.snapshotStatus) { _, status in
            model.pairing.apply(status: status)
        }
        .onDisappear {
            model.pairing.settingsDisappeared()
        }
    }
}

/// Backend URL, admin token, and pair or unpair. The fields and the buttons bind
/// to `PairingModel`; this view does not run the collector itself.
private struct SyncSection: View {
    @ObservedObject var pairing: PairingModel

    var body: some View {
        Section("Sync") {
            if pairing.paired {
                Text("Paired")
                Text("Sync: \(pairing.syncStateText)")
                Text("Last sync: \(pairing.lastSyncText)")
                Button("Unpair") {
                    Task { await pairing.unpair() }
                }
                .disabled(pairing.running)
            } else {
                TextField("Backend URL", text: $pairing.backendURL)
                    .autocorrectionDisabled()
                    .disabled(pairing.running)
                TextField("Device name", text: $pairing.deviceName)
                    .autocorrectionDisabled()
                    .disabled(pairing.running)
                SecureField("Admin token", text: $pairing.adminToken)
                    .disabled(pairing.running)
                Text("The admin token is used only for this pairing. It is not saved. Closing this window, finishing pairing, or unpairing clears it. Minimizing, hiding, or switching apps does not, so close the window when you are done.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button("Pair") {
                    Task { await pairing.pair() }
                }
                .disabled(!pairing.canPair)
            }
            if let notice = pairing.notice {
                Text(notice)
                    .font(.caption)
                    .textSelection(.enabled)
            }
        }
    }
}
