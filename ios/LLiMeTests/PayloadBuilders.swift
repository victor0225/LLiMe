import Foundation
import XCTest

/// A valid simulated push, in the exact JSON shape the backend dispatcher sends on stdin.
let validPayloadJSON = """
{
  "aps": { "alert": { "title": "llime", "body": "A quick challenge from today's lesson?" }, "sound": "default" },
  "notificationId": "notif_1",
  "runId": "run_1",
  "activityId": "run_1_invitation",
  "activityRevision": 2
}
"""

let validTap = NotificationTap(notificationId: "notif_1", runId: "run_1", activityId: "run_1_invitation", activityRevision: 2)

/// The OS hands the app `userInfo` as the JSON-decoded payload, so tests decode JSON the same way
/// instead of building Swift literals that would bridge differently.
func userInfo(_ json: String, file: StaticString = #filePath, line: UInt = #line) -> [AnyHashable: Any] {
    do {
        let object = try JSONSerialization.jsonObject(with: Data(json.utf8))
        guard let dictionary = object as? [AnyHashable: Any] else {
            XCTFail("payload is not a JSON object", file: file, line: line)
            return [:]
        }
        return dictionary
    } catch {
        XCTFail("payload is not JSON: \(error)", file: file, line: line)
        return [:]
    }
}

/// The valid payload with one JSON path replaced or added; `nil` removes the key.
func userInfo(replacing path: [String], with value: Any?, file: StaticString = #filePath, line: UInt = #line) -> [AnyHashable: Any] {
    var root = userInfo(validPayloadJSON, file: file, line: line)
    root = replace(in: root, path: path[...], with: value)
    return root
}

private func replace(in dictionary: [AnyHashable: Any], path: ArraySlice<String>, with value: Any?) -> [AnyHashable: Any] {
    guard let key = path.first else { return dictionary }
    var copy = dictionary
    if path.count == 1 {
        copy[key] = value
    } else {
        let child = dictionary[key] as? [AnyHashable: Any] ?? [:]
        copy[key] = replace(in: child, path: path.dropFirst(), with: value)
    }
    return copy
}

func origin(_ text: String, file: StaticString = #filePath, line: UInt = #line) -> URL {
    guard let url = URL(string: text) else {
        XCTFail("bad test origin \(text)", file: file, line: line)
        return URL(fileURLWithPath: "/")
    }
    return url
}
