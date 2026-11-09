import XCTest

final class NotificationPayloadTests: XCTestCase {
    func test_a_valid_payload_yields_exactly_its_four_opaque_ids() {
        XCTAssertEqual(NotificationPayload.parse(userInfo(validPayloadJSON)), .success(validTap))
    }

    func test_a_payload_carrying_a_URL_or_an_extra_command_is_rejected() {
        let smuggled: [(path: [String], value: Any)] = [
            (["url"], "https://example.com/elsewhere"),
            (["command"], "start_activity"),
            (["destination"], "/student?runId=other"),
            (["aps", "url-args"], ["elsewhere"]),
            (["aps", "category"], "OPEN_URL"),
            (["aps", "content-available"], 1),
            (["aps", "alert", "launch-image"], "evil.png"),
            (["aps", "alert", "action-loc-key"], "OPEN"),
        ]
        for (path, value) in smuggled {
            let result = NotificationPayload.parse(userInfo(replacing: path, with: value))
            XCTAssertEqual(result, .failure(.unexpectedKey(path.joined(separator: "."))), "accepted extra \(path)")
        }
    }

    func test_a_payload_missing_an_id_is_rejected() {
        for key in ["notificationId", "runId", "activityId", "activityRevision"] {
            XCTAssertEqual(NotificationPayload.parse(userInfo(replacing: [key], with: nil)), .failure(.missingKey(key)))
        }
        XCTAssertEqual(NotificationPayload.parse(userInfo(replacing: ["aps", "sound"], with: nil)), .failure(.missingKey("aps.sound")))
    }

    func test_an_alert_must_be_a_title_and_body_object() {
        XCTAssertEqual(NotificationPayload.parse(userInfo(replacing: ["aps", "alert"], with: "plain text")), .failure(.wrongType("aps.alert")))
        XCTAssertEqual(NotificationPayload.parse(userInfo(replacing: ["aps", "alert", "body"], with: "")), .failure(.wrongType("aps.alert.body")))
        XCTAssertEqual(NotificationPayload.parse(userInfo(replacing: ["aps", "alert", "title"], with: 7)), .failure(.wrongType("aps.alert.title")))
    }

    func test_only_the_default_sound_is_accepted() {
        XCTAssertEqual(NotificationPayload.parse(userInfo(replacing: ["aps", "sound"], with: "alarm.caf")), .failure(.unexpectedSound))
        XCTAssertEqual(NotificationPayload.parse(userInfo(replacing: ["aps", "sound"], with: ["critical": 1])), .failure(.unexpectedSound))
    }

    func test_ids_must_be_1_to_180_characters_of_text() {
        XCTAssertEqual(NotificationPayload.parse(userInfo(replacing: ["runId"], with: "")), .failure(.invalidIdentifier("runId")))
        XCTAssertEqual(NotificationPayload.parse(userInfo(replacing: ["activityId"], with: String(repeating: "a", count: 181))), .failure(.invalidIdentifier("activityId")))
        XCTAssertEqual(NotificationPayload.parse(userInfo(replacing: ["notificationId"], with: 42)), .failure(.invalidIdentifier("notificationId")))
        let longest = String(repeating: "a", count: 180)
        XCTAssertEqual(
            NotificationPayload.parse(userInfo(replacing: ["activityId"], with: longest)),
            .success(NotificationTap(notificationId: "notif_1", runId: "run_1", activityId: longest, activityRevision: 2))
        )
    }

    func test_the_revision_must_be_a_non_negative_whole_number() {
        for bad in ["-1", "2.5", "true", "\"2\"", "null", "9007199254740992"] {
            let json = validPayloadJSON.replacingOccurrences(of: "\"activityRevision\": 2", with: "\"activityRevision\": \(bad)")
            XCTAssertEqual(NotificationPayload.parse(userInfo(json)), .failure(.invalidRevision), "accepted revision \(bad)")
        }
        let zero = validPayloadJSON.replacingOccurrences(of: "\"activityRevision\": 2", with: "\"activityRevision\": 0")
        XCTAssertEqual(NotificationPayload.parse(userInfo(zero)).map(\.activityRevision), .success(0))
    }

    func test_a_payload_over_4096_encoded_bytes_is_rejected() {
        let padded = userInfo(replacing: ["aps", "alert", "body"], with: String(repeating: "x", count: 4096))
        XCTAssertEqual(NotificationPayload.parse(padded), .failure(.tooLarge))
    }
}
