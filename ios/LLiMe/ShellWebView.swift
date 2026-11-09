import SwiftUI
import WebKit

/// Shows the shell's single web view. SwiftUI may rebuild this wrapper on rotation or layout changes;
/// the web view itself belongs to the model and is never recreated.
struct ShellWebView: UIViewRepresentable {
    let shell: ShellModel

    func makeUIView(context: Context) -> WKWebView {
        // Reported after this view update, so the model's state change does not happen mid-update.
        Task { @MainActor [shell] in shell.webViewMounted() }
        return shell.webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}
}
