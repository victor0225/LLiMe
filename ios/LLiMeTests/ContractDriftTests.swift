import Foundation
import XCTest

/// The TypeScript core is the single source for these facts; Swift cannot import it, so these tests
/// read the source files and fail as soon as the native copy drifts from them.
final class ContractDriftTests: XCTestCase {
    private static let repositoryRoot = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent() // LLiMeTests
        .deletingLastPathComponent() // ios
        .deletingLastPathComponent()

    func test_the_shell_copy_matches_the_shared_copy_module() throws {
        let block = try section(of: "src/copy.ts", from: "export const SHELL_COPY = {", to: "} as const;")
        var shared: [String: String] = [:]
        for line in block.split(separator: "\n").map({ String($0.split(separator: "//", maxSplits: 1, omittingEmptySubsequences: false)[0]) }) {
            guard let key = matches(of: #"^\s*(\w+)\s*:"#, in: line).first?.first else { continue }
            // Only a plain single-quoted literal can be mirrored; anything else must fail, not be skipped.
            let value = try XCTUnwrap(matches(of: #"^\s*\w+\s*:\s*'((?:[^'\\]|\\.)*)',?\s*$"#, in: line).first?.first, "SHELL_COPY.\(key) is not a plain string literal")
            XCTAssertNil(shared[key], "SHELL_COPY.\(key) appears twice")
            shared[key] = value.replacingOccurrences(of: "\\'", with: "'")
        }
        var native: [String: String] = [:]
        for child in Mirror(reflecting: ShellCopy.text).children {
            let label = try XCTUnwrap(child.label)
            native[label] = try XCTUnwrap(child.value as? String, "ShellCopy.\(label) is not text")
        }
        XCTAssertFalse(shared.isEmpty)
        XCTAssertEqual(native, shared)
    }

    func test_the_accepted_payload_fields_match_the_shared_schema() throws {
        let block = try section(of: "src/domain.ts", from: "export const NotificationPayloadSchema = z.strictObject({", to: "}).refine(")
        let sharedKeys = Set(matches(of: #"(\w+):"#, in: block).map { $0[0] })
        XCTAssertEqual(NotificationPayload.allKeys, sharedKeys)
        XCTAssertTrue(block.contains("sound: z.literal('\(NotificationPayload.sound)')"))
        XCTAssertTrue(block.contains("activityRevision: z.number().int().min(0)"))
    }

    func test_the_payload_and_id_limits_match_the_shared_schema() throws {
        let domain = try source("src/domain.ts")
        XCTAssertTrue(domain.contains("export const NOTIFICATION_PAYLOAD_MAX_BYTES = \(NotificationPayload.maxEncodedBytes);"))
        XCTAssertTrue(domain.contains("export const IdSchema = z.string().min(1).max(\(NotificationPayload.maxIdentifierLength));"))
    }

    func test_the_readiness_probe_uses_the_shared_bootstrap_route() throws {
        let routes = try source("src/routes.ts")
        XCTAssertTrue(routes.contains("bootstrap: { method: 'GET', path: '\(BackendRoute.bootstrapPath)'"))
    }

    func test_the_shell_tokens_match_the_web_token_sheet() throws {
        let sheet = try source("web/styles/tokens.css")
        let colors: [(String, UInt32)] = [
            ("--p-background", ShellTokens.background),
            ("--p-text", ShellTokens.text),
            ("--p-muted", ShellTokens.muted),
            ("--p-primary", ShellTokens.primary),
            ("--p-on-primary", ShellTokens.onPrimary),
        ]
        for (name, value) in colors {
            XCTAssertTrue(sheet.contains("\(name): #\(String(format: "%06x", value));"), name)
        }
        let sizes: [(String, Double)] = [
            ("--p-font-body", ShellTokens.bodySize),
            ("--p-font-heading", ShellTokens.headingSize),
            ("--p-space-2", ShellTokens.spacing),
            ("--p-radius-control", ShellTokens.radius),
            ("--p-target-student", ShellTokens.studentTarget),
        ]
        for (name, value) in sizes {
            XCTAssertTrue(sheet.contains("\(name): \(Int(value))px;"), name)
        }
    }

    // MARK: Helpers

    private func source(_ path: String) throws -> String {
        try String(contentsOf: Self.repositoryRoot.appending(path: path), encoding: .utf8)
    }

    private func section(of path: String, from start: String, to end: String) throws -> String {
        let text = try source(path)
        let begin = try XCTUnwrap(text.range(of: start), "\(start) not found in \(path)")
        let finish = try XCTUnwrap(text.range(of: end, range: begin.upperBound..<text.endIndex), "\(end) not found after \(start)")
        return String(text[begin.upperBound..<finish.lowerBound])
    }

    private func matches(of pattern: String, in text: String) -> [[String]] {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { XCTFail("bad pattern \(pattern)"); return [] }
        let range = NSRange(text.startIndex..., in: text)
        return regex.matches(in: text, range: range).map { match in
            (1..<match.numberOfRanges).compactMap { Range(match.range(at: $0), in: text).map { String(text[$0]) } }
        }
    }
}
