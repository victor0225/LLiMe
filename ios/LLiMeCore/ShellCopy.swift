/// Words the native shell shows itself. The shared copy module owns them; a unit test reads every
/// property here and fails when any of them drifts from it.
struct ShellCopy {
    let offlineTitle = "Can’t connect right now"
    /// Shown only while a tapped activity is held; the shell opens it once the backend answers.
    let offlineBody = "Your activity will open when the connection is back."
    let retry = "Retry"

    static let text = ShellCopy()
}
