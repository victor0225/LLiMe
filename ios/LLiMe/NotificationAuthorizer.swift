import Observation
import UserNotifications

@MainActor
@Observable
final class NotificationAuthorizer {
    private(set) var status = "unknown"

    func refresh() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        record(settings.authorizationStatus)
    }

    /// Called only from an explicit button press: the system asks once and remembers the answer.
    func request() async {
        ShellLog.write("notification.authorization.request")
        do {
            let granted = try await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .sound, .badge])
            ShellLog.write("notification.authorization.result", "granted=\(granted)")
        } catch {
            ShellLog.write("notification.authorization.error", error.localizedDescription)
        }
        await refresh()
    }

    private func record(_ authorization: UNAuthorizationStatus) {
        status = Self.describe(authorization)
        ShellLog.write("notification.authorization.status", status)
    }

    private static func describe(_ authorization: UNAuthorizationStatus) -> String {
        switch authorization {
        case .notDetermined: "notDetermined"
        case .denied: "denied"
        case .authorized: "authorized"
        case .provisional: "provisional"
        case .ephemeral: "ephemeral"
        @unknown default: "unknown"
        }
    }
}
