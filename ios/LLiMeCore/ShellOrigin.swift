import Foundation

enum ShellOriginError: LocalizedError, Equatable {
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
    private static let rememberedKey = "LLIME_ORIGIN_LAST_ARGUMENT"
    private static let loopbackHosts: Set<String> = ["127.0.0.1", "localhost"]
    private static let defaultPorts = ["http": 80, "https": 443]

    /// Reads the `-LLIME_ORIGIN <url>` launch argument, the origin remembered from the last such
    /// argument, and the Info.plist default, in that order.
    static func resolve() -> Result<URL, ShellOriginError> {
        let defaults = UserDefaults.standard
        let argument = defaults.volatileDomain(forName: UserDefaults.argumentDomain)[key] as? String
        let bundled = Bundle.main.object(forInfoDictionaryKey: key) as? String
        return choose(argument: argument, remembered: defaults.string(forKey: rememberedKey), bundled: bundled)
    }

    /// Keeps a valid launch-argument origin for later launches. The OS launches the app from a
    /// notification tap without any arguments, and that launch must reach the same backend.
    static func remember(_ origin: URL) {
        UserDefaults.standard.set(origin.absoluteString, forKey: rememberedKey)
    }

    static var isFromLaunchArgument: Bool {
        UserDefaults.standard.volatileDomain(forName: UserDefaults.argumentDomain)[key] != nil
    }

    /// An explicit but invalid choice is an error, never a silent fall back to a lower-priority origin.
    static func choose(argument: String?, remembered: String?, bundled: String?) -> Result<URL, ShellOriginError> {
        guard let configured = argument ?? remembered ?? bundled, !configured.isEmpty else { return .failure(.missing) }
        guard let url = URL(string: configured), isLoopback(url) else {
            return .failure(.notLoopback(configured))
        }
        return .success(url)
    }

    static func isLoopback(_ url: URL) -> Bool {
        guard let scheme = url.scheme, defaultPorts[scheme] != nil,
              let host = url.host, url.user == nil else { return false }
        return loopbackHosts.contains(host)
    }

    /// Same scheme, host and effective port: the shell stays on its one configured backend, not on
    /// any loopback port (another worker's backend listens on the same interface).
    static func isSameOrigin(_ url: URL, as origin: URL) -> Bool {
        guard let scheme = url.scheme, let host = url.host else { return false }
        return isSameOrigin(scheme: scheme, host: host, port: url.port, as: origin)
    }

    static func isSameOrigin(scheme: String, host: String, port: Int?, as origin: URL) -> Bool {
        guard let originScheme = origin.scheme?.lowercased(), let originHost = origin.host?.lowercased() else { return false }
        let scheme = scheme.lowercased()
        let effectivePort = port ?? defaultPorts[scheme]
        let originPort = origin.port ?? defaultPorts[originScheme]
        return scheme == originScheme && host.lowercased() == originHost && effectivePort != nil && effectivePort == originPort
    }
}
