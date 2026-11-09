import SwiftUI

@main
struct LLiMeApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup {
            ShellView(shell: appDelegate.shell)
        }
    }
}
