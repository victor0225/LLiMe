import UserNotifications

/// Receives notification interactions from the OS, for a warm resume and for a cold launch alike, and
/// hands the parsed identifiers to the shell. Arrival alone never opens anything; only a tap does.
final class NotificationTapReceiver: NSObject, UNUserNotificationCenterDelegate {
    private let shell: ShellModel

    init(shell: ShellModel) {
        self.shell = shell
    }

    /// In the foreground the banner is still shown, so the child decides whether to open it.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping @Sendable (UNNotificationPresentationOptions) -> Void
    ) {
        ShellLog.write("notification.presented.foreground")
        completionHandler([.banner, .list, .sound])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping @Sendable () -> Void
    ) {
        defer { completionHandler() }
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier else {
            ShellLog.write("notification.response.ignored", "action=\(response.actionIdentifier)")
            return
        }
        let parsed = NotificationPayload.parse(response.notification.request.content.userInfo)
        Task { @MainActor [shell] in shell.receive(parsed) }
    }
}
