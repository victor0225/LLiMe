import Foundation
import os

/// Every shell event goes to the unified log and to a plain file in the app container,
/// so a run can be audited without attaching a debugger or scraping `log stream`.
enum ShellLog {
    private static let logger = Logger(subsystem: "com.llime.demo", category: "shell")
    private static let queue = DispatchQueue(label: "com.llime.demo.shell-log")

    static var fileURL: URL {
        URL.documentsDirectory.appending(path: "shell.log")
    }

    static func write(_ event: String, _ detail: String = "") {
        let line = detail.isEmpty ? event : "\(event) \(detail)"
        logger.notice("\(line, privacy: .public)")
        let stamped = "\(Date.now.formatted(.iso8601)) \(line)\n"
        queue.async {
            guard let data = stamped.data(using: .utf8) else { return }
            if let handle = try? FileHandle(forWritingTo: fileURL) {
                defer { try? handle.close() }
                _ = try? handle.seekToEnd()
                try? handle.write(contentsOf: data)
            } else {
                try? data.write(to: fileURL)
            }
        }
    }
}
