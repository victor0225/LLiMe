import Foundation

/// Paths on the backend origin that the shell itself uses. Everything else is the page's business.
enum BackendRoute {
    /// Answers 200 once the backend can serve a session; the shell opens nothing before that.
    static let bootstrapPath = "/api/bootstrap"
    static let studentPath = "/student"
}

extension NotificationTap {
    // RFC 3986 unreserved characters. Everything else is percent-encoded, so an identifier can never
    // end the query, start a fragment, or turn into a host, path or scheme of its own.
    private static let queryValueCharacters = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

    /// The student page for exactly this activity, on the configured origin. Only the origin's scheme,
    /// host and port are kept; nothing from the payload chooses where the shell navigates.
    func destination(on origin: URL) -> URL? {
        var components = URLComponents()
        components.scheme = origin.scheme
        components.host = origin.host
        components.port = origin.port
        components.path = BackendRoute.studentPath
        let query: [(String, String)] = [
            ("runId", runId),
            ("activityId", activityId),
            ("activityRevision", String(activityRevision)),
            ("notificationId", notificationId),
        ]
        var encoded: [URLQueryItem] = []
        for (name, value) in query {
            guard let escaped = value.addingPercentEncoding(withAllowedCharacters: Self.queryValueCharacters) else { return nil }
            encoded.append(URLQueryItem(name: name, value: escaped))
        }
        components.percentEncodedQueryItems = encoded
        return components.url
    }
}
