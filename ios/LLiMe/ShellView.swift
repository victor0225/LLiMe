import SwiftUI

struct ShellView: View {
    let shell: ShellModel
    @State private var authorizer = NotificationAuthorizer()
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        VStack(spacing: 0) {
            toolbar
            Divider()
            switch shell.origin {
            case .success:
                ShellWebView(shell: shell)
                    .overlay {
                        if case .offline(let isHoldingActivity) = shell.connection {
                            OfflineView(isHoldingActivity: isHoldingActivity, retry: shell.retry)
                        }
                    }
            case .failure(let error):
                ContentUnavailableView(
                    "Cannot open the student UI",
                    systemImage: "exclamationmark.triangle",
                    description: Text(error.localizedDescription)
                )
            }
        }
        .task {
            if case .failure(let error) = shell.origin { ShellLog.write("origin.invalid", error.localizedDescription) }
            await authorizer.refresh()
        }
        // The answer can change in Settings while the app is away.
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await authorizer.refresh() } }
        }
    }

    private var toolbar: some View {
        HStack(spacing: 16) {
            Text("Notifications: \(authorizer.status)")
                .accessibilityIdentifier("notification-status")
            Spacer()
            Button("Reload", action: shell.reload)
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

/// Covers the page while the backend is unreachable. The page stays mounted underneath, so a Retry
/// that succeeds returns to it without losing anything it was showing.
private struct OfflineView: View {
    let isHoldingActivity: Bool
    let retry: () -> Void

    var body: some View {
        VStack(spacing: ShellStyle.spacing) {
            Text(ShellCopy.offlineTitle)
                .font(.system(size: ShellStyle.headingSize, weight: .bold, design: .rounded))
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("offline-title")
            if isHoldingActivity {
                Text(ShellCopy.offlineBody)
                    .font(.system(size: ShellStyle.bodySize, design: .rounded))
                    .foregroundStyle(ShellStyle.muted)
                    .accessibilityIdentifier("offline-body")
            }
            Button(action: retry) {
                Text(ShellCopy.retry)
                    .font(.system(size: ShellStyle.bodySize, weight: .semibold, design: .rounded))
                    .frame(minWidth: ShellStyle.studentTarget * 3, minHeight: ShellStyle.studentTarget)
            }
            .buttonStyle(.borderedProminent)
            .tint(ShellStyle.primary)
            .foregroundStyle(ShellStyle.onPrimary)
            .buttonBorderShape(.roundedRectangle(radius: ShellStyle.radius))
            .accessibilityIdentifier("offline-retry")
        }
        .multilineTextAlignment(.center)
        .foregroundStyle(ShellStyle.text)
        .padding(ShellStyle.spacing * 2)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(ShellStyle.background)
    }
}
