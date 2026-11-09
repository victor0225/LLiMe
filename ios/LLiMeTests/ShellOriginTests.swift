import XCTest

final class ShellOriginTests: XCTestCase {
    private let bundled = "http://127.0.0.1:4210"

    func test_the_launch_argument_wins() {
        let chosen = ShellOrigin.choose(argument: "http://127.0.0.1:4245", remembered: "http://127.0.0.1:4299", bundled: bundled)
        XCTAssertEqual(try chosen.get().absoluteString, "http://127.0.0.1:4245")
    }

    func test_a_launch_without_the_argument_uses_the_origin_remembered_from_the_last_argument() {
        let chosen = ShellOrigin.choose(argument: nil, remembered: "http://127.0.0.1:4245", bundled: bundled)
        XCTAssertEqual(try chosen.get().absoluteString, "http://127.0.0.1:4245")
    }

    func test_with_nothing_configured_the_bundled_default_is_used() {
        XCTAssertEqual(try ShellOrigin.choose(argument: nil, remembered: nil, bundled: bundled).get().absoluteString, bundled)
        XCTAssertEqual(ShellOrigin.choose(argument: nil, remembered: nil, bundled: nil), .failure(.missing))
    }

    func test_a_bad_argument_is_an_error_not_a_silent_fallback() {
        let chosen = ShellOrigin.choose(argument: "http://192.168.1.20:4245", remembered: "http://127.0.0.1:4245", bundled: bundled)
        XCTAssertEqual(chosen, .failure(.notLoopback("http://192.168.1.20:4245")))
    }

    func test_only_loopback_http_origins_are_accepted() {
        for bad in ["https://evil.example", "http://127.0.0.1.evil.example:4245", "http://127.0.0.1:4245@evil.example", "file:///etc", "ftp://127.0.0.1"] {
            XCTAssertFalse(ShellOrigin.isLoopback(origin(bad)), bad)
        }
        for good in ["http://127.0.0.1:4245", "http://localhost:4245", "https://127.0.0.1"] {
            XCTAssertTrue(ShellOrigin.isLoopback(origin(good)), good)
        }
    }

    func test_same_origin_means_same_scheme_host_and_port() {
        let configured = origin("http://127.0.0.1:4245")
        XCTAssertTrue(ShellOrigin.isSameOrigin(origin("http://127.0.0.1:4245/student?runId=r"), as: configured))
        XCTAssertFalse(ShellOrigin.isSameOrigin(origin("http://127.0.0.1:4317/student"), as: configured), "another worker's port")
        XCTAssertFalse(ShellOrigin.isSameOrigin(origin("https://127.0.0.1:4245/student"), as: configured))
        XCTAssertFalse(ShellOrigin.isSameOrigin(origin("http://localhost:4245/student"), as: configured))
        XCTAssertTrue(ShellOrigin.isSameOrigin(origin("http://127.0.0.1:80/"), as: origin("http://127.0.0.1")), "default port")
    }
}
