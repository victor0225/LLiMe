import SwiftUI

struct ShellView: View {
    @State private var authorizer = NotificationAuthorizer()
    @State private var reloadToken = 0
    private let origin = ShellOrigin.resolve()

    var body: some View {
        VStack(spacing: 0) {
            toolbar
            Divider()
            switch origin {
            case .success(let url):
                ShellWebView(origin: url, reloadToken: reloadToken)
            case .failure(let error):
                ContentUnavailableView(
                    "Cannot open the student UI",
                    systemImage: "exclamationmark.triangle",
                    description: Text(error.localizedDescription)
                )
            }
        }
        .task {
            if case .failure(let error) = origin { ShellLog.write("origin.invalid", error.localizedDescription) }
            await authorizer.refresh()
        }
    }

    private var toolbar: some View {
        HStack(spacing: 16) {
            Text("Notifications: \(authorizer.status)")
                .accessibilityIdentifier("notification-status")
            Spacer()
            Button("Reload") { reloadToken += 1 }
                .accessibilityIdentifier("reload")
            Button("Allow notifications") {
                Task { await authorizer.request() }
            }
            .buttonStyle(.borderedProminent)
            .accessibilityIdentifier("allow-notifications")
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 10)
    }
}
