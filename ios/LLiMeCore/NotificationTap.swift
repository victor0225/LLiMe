import Foundation

/// The four opaque identifiers a tapped notification carries. The shell never interprets them: the
/// page resolves them against the backend, which decides whether that exact activity can open.
struct NotificationTap: Equatable, Sendable {
    let notificationId: String
    let runId: String
    let activityId: String
    let activityRevision: Int
}

enum NotificationPayloadError: Error, Equatable {
    /// A field the contract does not define, at its dotted path. Extra fields are how a payload would
    /// smuggle a URL, a category action or a command, so any of them rejects the whole tap.
    case unexpectedKey(String)
    case missingKey(String)
    case wrongType(String)
    case invalidIdentifier(String)
    case invalidRevision
    case unexpectedSound
    case tooLarge
}

/// Strict reader for the simulated push the backend sends after an activity commit:
/// `{aps: {alert: {title, body}, sound: "default"}, notificationId, runId, activityId, activityRevision}`.
enum NotificationPayload {
    // The simulator refuses larger payloads; a larger one did not come from our dispatcher.
    static let maxEncodedBytes = 4096
    static let maxIdentifierLength = 180
    static let sound = "default"
    // JavaScript integers are exact only up to 2^53 - 1, and the backend writes revisions from JavaScript.
    private static let maxRevision = 9_007_199_254_740_991

    private static let topLevelKeys: Set<String> = ["aps", "notificationId", "runId", "activityId", "activityRevision"]
    private static let apsKeys: Set<String> = ["alert", "sound"]
    private static let alertKeys: Set<String> = ["title", "body"]
    static let allKeys = topLevelKeys.union(apsKeys).union(alertKeys)

    static func parse(_ userInfo: [AnyHashable: Any]) -> Result<NotificationTap, NotificationPayloadError> {
        Result { () throws(NotificationPayloadError) -> NotificationTap in
            let root = try stringKeyed(userInfo, path: "")
            try requireSize(of: root)
            try requireExactKeys(of: root, allowed: topLevelKeys, path: "")
            let aps = try stringKeyed(root["aps"], path: "aps")
            try requireExactKeys(of: aps, allowed: apsKeys, path: "aps")
            let alert = try stringKeyed(aps["alert"], path: "aps.alert")
            try requireExactKeys(of: alert, allowed: alertKeys, path: "aps.alert")
            try requireText(alert["title"], path: "aps.alert.title")
            try requireText(alert["body"], path: "aps.alert.body")
            guard aps["sound"] as? String == sound else { throw NotificationPayloadError.unexpectedSound }
            return NotificationTap(
                notificationId: try identifier(root, "notificationId"),
                runId: try identifier(root, "runId"),
                activityId: try identifier(root, "activityId"),
                activityRevision: try revision(root["activityRevision"])
            )
        }
    }

    private static func stringKeyed(_ value: Any?, path: String) throws(NotificationPayloadError) -> [String: Any] {
        guard let dictionary = value as? [AnyHashable: Any] else { throw NotificationPayloadError.wrongType(path) }
        var result: [String: Any] = [:]
        for (key, entry) in dictionary {
            guard let name = key as? String else { throw NotificationPayloadError.wrongType(path) }
            result[name] = entry
        }
        return result
    }

    private static func requireSize(of root: [String: Any]) throws(NotificationPayloadError) {
        let encoded = try? JSONSerialization.data(withJSONObject: root, options: [.withoutEscapingSlashes])
        guard let encoded, encoded.count <= maxEncodedBytes else { throw NotificationPayloadError.tooLarge }
    }

    /// Unknown keys are reported before missing ones, sorted, so the rejection reason is stable.
    private static func requireExactKeys(of dictionary: [String: Any], allowed: Set<String>, path: String) throws(NotificationPayloadError) {
        let keys = Set(dictionary.keys)
        if let extra = keys.subtracting(allowed).sorted().first {
            throw NotificationPayloadError.unexpectedKey(dotted(path, extra))
        }
        if let missing = allowed.subtracting(keys).sorted().first {
            throw NotificationPayloadError.missingKey(dotted(path, missing))
        }
    }

    private static func requireText(_ value: Any?, path: String) throws(NotificationPayloadError) {
        guard let text = value as? String, !text.isEmpty else { throw NotificationPayloadError.wrongType(path) }
    }

    /// Lengths count UTF-16 code units, matching the backend's JavaScript string limit.
    private static func identifier(_ root: [String: Any], _ key: String) throws(NotificationPayloadError) -> String {
        guard let text = root[key] as? String, (1...maxIdentifierLength).contains(text.utf16.count) else {
            throw NotificationPayloadError.invalidIdentifier(key)
        }
        return text
    }

    private static func revision(_ value: Any?) throws(NotificationPayloadError) -> Int {
        // JSON booleans also arrive as NSNumber; only a real number is a revision.
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else {
            throw NotificationPayloadError.invalidRevision
        }
        let real = number.doubleValue
        guard real.isFinite, real.rounded() == real, real >= 0, real <= Double(maxRevision) else {
            throw NotificationPayloadError.invalidRevision
        }
        return Int(real)
    }

    private static func dotted(_ path: String, _ key: String) -> String {
        path.isEmpty ? key : "\(path).\(key)"
    }
}
