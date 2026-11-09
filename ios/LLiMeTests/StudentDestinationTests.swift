import XCTest

final class StudentDestinationTests: XCTestCase {
    private let configured = origin("http://127.0.0.1:4245")

    func test_the_destination_is_always_on_the_configured_loopback_origin() {
        let hostileIds = [
            "https://evil.example/x",
            "//evil.example",
            "@evil.example",
            "../../admin",
            "a?b#c&d=e",
            "x y+z",
            "%2F%2E%2E",
            "javascript:alert(1)",
            "é☃\n\t",
        ]
        for id in hostileIds {
            let tap = NotificationTap(notificationId: id, runId: id, activityId: id, activityRevision: 3)
            guard let destination = tap.destination(on: configured) else { return XCTFail("no destination for \(id)") }
            XCTAssertEqual(destination.scheme, "http", id)
            XCTAssertEqual(destination.host, "127.0.0.1", id)
            XCTAssertEqual(destination.port, 4245, id)
            XCTAssertEqual(destination.path, "/student", id)
            XCTAssertNil(destination.fragment, id)
            XCTAssertNil(destination.user, id)
            XCTAssertTrue(ShellOrigin.isSameOrigin(destination, as: configured), id)
            XCTAssertEqual(queryValues(destination), [id, id, "3", id], "ids did not survive as plain query values: \(id)")
        }
    }

    func test_the_destination_names_the_tapped_activity_in_a_fixed_order() {
        let destination = validTap.destination(on: configured)
        XCTAssertEqual(destination?.absoluteString, "http://127.0.0.1:4245/student?runId=run_1&activityId=run_1_invitation&activityRevision=2&notificationId=notif_1")
    }

    func test_the_origin_path_and_query_never_reach_the_destination() {
        let destination = validTap.destination(on: origin("http://localhost:4245/elsewhere/?next=https://evil.example#frag"))
        XCTAssertEqual(destination?.absoluteString, "http://localhost:4245/student?runId=run_1&activityId=run_1_invitation&activityRevision=2&notificationId=notif_1")
    }

    private func queryValues(_ url: URL) -> [String] {
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertEqual(items.map(\.name), ["runId", "activityId", "activityRevision", "notificationId"])
        return items.map { $0.value ?? "<missing>" }
    }
}
