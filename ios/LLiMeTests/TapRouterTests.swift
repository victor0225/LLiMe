import XCTest

final class TapRouterTests: XCTestCase {
    private let other = NotificationTap(notificationId: "notif_2", runId: "run_1", activityId: "run_1_invitation", activityRevision: 4)

    func test_a_cold_launch_tap_waits_for_the_ready_signal() {
        var router = TapRouter()
        XCTAssertEqual(router.receive(validTap), .accepted)
        XCTAssertNil(router.tapToOpen, "opened before the web view or the backend was ready")

        router.backendProbed(isReachable: true)
        XCTAssertNil(router.tapToOpen, "opened before the web view was mounted")

        router.webViewMounted()
        XCTAssertEqual(router.tapToOpen, validTap)
    }

    func test_a_tap_waits_for_the_backend_even_when_the_web_view_is_ready() {
        var router = TapRouter()
        router.webViewMounted()
        router.backendProbed(isReachable: true)
        XCTAssertEqual(router.receive(validTap), .accepted)
        XCTAssertNil(router.tapToOpen, "a reachability result from before the tap was reused")

        router.backendProbed(isReachable: true)
        XCTAssertEqual(router.tapToOpen, validTap)
    }

    func test_the_same_notificationId_navigates_once() {
        var router = readyRouter()
        XCTAssertEqual(router.receive(validTap), .accepted)
        router.backendProbed(isReachable: true)
        XCTAssertEqual(router.tapToOpen, validTap)
        router.opened(validTap)

        XCTAssertEqual(router.receive(validTap), .duplicate)
        router.backendProbed(isReachable: true)
        XCTAssertNil(router.tapToOpen)
    }

    func test_a_repeated_notificationId_with_other_ids_is_refused() {
        var router = readyRouter()
        XCTAssertEqual(router.receive(validTap), .accepted)
        router.backendProbed(isReachable: true)
        router.opened(validTap)

        let tampered = NotificationTap(notificationId: validTap.notificationId, runId: "run_9", activityId: "run_9_invitation", activityRevision: 1)
        XCTAssertEqual(router.receive(tampered), .conflict)
        router.backendProbed(isReachable: true)
        XCTAssertNil(router.tapToOpen)
    }

    func test_an_unreachable_backend_keeps_the_destination_for_retry() {
        var router = readyRouter()
        XCTAssertEqual(router.receive(validTap), .accepted)
        router.backendProbed(isReachable: false)
        XCTAssertNil(router.tapToOpen)
        XCTAssertEqual(router.pending, validTap)

        router.backendProbed(isReachable: true)
        XCTAssertEqual(router.tapToOpen, validTap)
    }

    func test_a_failed_load_keeps_the_destination_for_retry() {
        var router = readyRouter()
        XCTAssertEqual(router.receive(validTap), .accepted)
        router.backendProbed(isReachable: true)
        XCTAssertEqual(router.tapToOpen, validTap)

        router.backendProbed(isReachable: false)
        XCTAssertNil(router.tapToOpen)
        XCTAssertEqual(router.pending, validTap)
        XCTAssertEqual(router.receive(validTap), .duplicate, "a repeated callback during retry counted as a new tap")
    }

    func test_a_newer_tap_replaces_an_unopened_one() {
        var router = readyRouter()
        XCTAssertEqual(router.receive(validTap), .accepted)
        XCTAssertEqual(router.receive(other), .accepted)
        router.backendProbed(isReachable: true)
        XCTAssertEqual(router.tapToOpen, other)

        router.opened(other)
        XCTAssertNil(router.pending)
        XCTAssertEqual(router.receive(validTap), .duplicate, "a superseded tap came back as new")
    }

    func test_opening_a_superseded_tap_keeps_the_newer_one() {
        var router = readyRouter()
        XCTAssertEqual(router.receive(validTap), .accepted)
        XCTAssertEqual(router.receive(other), .accepted)
        router.opened(validTap)
        XCTAssertEqual(router.pending, other)
    }

    private func readyRouter() -> TapRouter {
        var router = TapRouter()
        router.webViewMounted()
        return router
    }
}
