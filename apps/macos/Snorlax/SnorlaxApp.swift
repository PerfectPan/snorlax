import SnorlaxKit
import SwiftUI

@main
struct SnorlaxApp: App {
    @StateObject private var model = MenuModel()

    var body: some Scene {
        MenuBarExtra {
            PopoverView(model: model)
        } label: {
            Text(model.menuTitle)
        }
        .menuBarExtraStyle(.window)

        Window("Settings", id: "settings") {
            SettingsView(model: model)
                .frame(minWidth: 440, minHeight: 420)
        }
    }
}
