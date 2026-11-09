/// Words the native shell shows itself. The shared copy module owns them; a unit test fails when
/// these drift from it.
enum ShellCopy {
    static let offlineTitle = "Can’t connect right now"
    static let offlineBody = "Your activity will open when the connection is back."
    static let retry = "Retry"
}
