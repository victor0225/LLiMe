import Foundation

enum ShellOriginError: LocalizedError {
    case missing
    case notLoopback(String)

    var errorDescription: String? {
        switch self {
        case .missing:
            return "No student UI origin is configured."
        case .notLoopback(let value):
            return "Origin \(value) is not a loopback http(s) address."
        }
    }
}

/// The student UI is served by the Mac backend on the loopback interface; the shell
/// refuses any other host so a bad launch argument cannot point the WebView at the network.
enum ShellOrigin {
    private static let key = "LLIME_ORIGIN"
    private static let loopbackHosts: Set<String> = ["127.0.0.1", "localhost"]

    /// A `-LLIME_ORIGIN <url>` launch argument (surfaced through UserDefaults) overrides the
    /// default stored in Info.plist, so each Task can pass its own port.
    static func resolve() -> Result<URL, ShellOriginError> {
        let configured = UserDefaults.standard.string(forKey: key)
            ?? Bundle.main.object(forInfoDictionaryKey: key) as? String
        guard let configured, !configured.isEmpty else { return .failure(.missing) }
        guard let url = URL(string: configured), isLoopback(url) else {
            return .failure(.notLoopback(configured))
        }
        return .success(url)
    }

    static func isLoopback(_ url: URL) -> Bool {
        guard let scheme = url.scheme, scheme == "http" || scheme == "https",
              let host = url.host else { return false }
        return loopbackHosts.contains(host)
    }
}
