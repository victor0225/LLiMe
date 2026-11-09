import UIKit
import UserNotifications

@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate {
    let shell = ShellModel(origin: ShellOrigin.resolve())
    private lazy var tapReceiver = NotificationTapReceiver(shell: shell)

    func application(
        _ application: UIApplication,
        willFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        // The delegate has to be in place before launch finishes, or the tap that launched the app is lost.
        UNUserNotificationCenter.current().delegate = tapReceiver
        if case .success(let origin) = shell.origin, ShellOrigin.isFromLaunchArgument {
            ShellOrigin.remember(origin)
        }
        AudioSession.configureForVoice()
        ShellLog.write("app.launch", "origin=\(describe(shell.origin))")
        return true
    }

    private func describe(_ origin: Result<URL, ShellOriginError>) -> String {
        switch origin {
        case .success(let url): url.absoluteString
        case .failure(let error): "invalid (\(error.localizedDescription))"
        }
    }
}
