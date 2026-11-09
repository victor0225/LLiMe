import SwiftUI
import WebKit

/// Name the page uses to report to the shell: `webkit.messageHandlers.llimeLog.postMessage(...)`.
private let pageLogHandlerName = "llimeLog"

struct ShellWebView: UIViewRepresentable {
    let origin: URL
    let reloadToken: Int

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.userContentController.add(context.coordinator, name: pageLogHandlerName)
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.isInspectable = true
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        context.coordinator.load(origin, in: webView)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.reloadIfNeeded(token: reloadToken, origin: origin, in: webView)
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: pageLogHandlerName)
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        private var lastReloadToken = 0

        func load(_ origin: URL, in webView: WKWebView) {
            ShellLog.write("webview.load", origin.absoluteString)
            webView.load(URLRequest(url: origin))
        }

        func reloadIfNeeded(token: Int, origin: URL, in webView: WKWebView) {
            guard token != lastReloadToken else { return }
            lastReloadToken = token
            load(origin, in: webView)
        }

        // MARK: Navigation

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void
        ) {
            guard let url = navigationAction.request.url else { return decisionHandler(.cancel) }
            let isAllowed = url.scheme == "about" || ShellOrigin.isLoopback(url)
            if !isAllowed { ShellLog.write("webview.navigation.blocked", url.absoluteString) }
            decisionHandler(isAllowed ? .allow : .cancel)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            ShellLog.write("webview.loaded", webView.url?.absoluteString ?? "")
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            ShellLog.write("webview.load.failed", error.localizedDescription)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            ShellLog.write("webview.navigation.failed", error.localizedDescription)
        }

        // MARK: Media capture

        /// Returning `.prompt` lets WebKit and the OS ask the person; the shell never grants
        /// microphone access on their behalf.
        func webView(
            _ webView: WKWebView,
            requestMediaCapturePermissionFor origin: WKSecurityOrigin,
            initiatedByFrame frame: WKFrameInfo,
            type: WKMediaCaptureType,
            decisionHandler: @escaping @MainActor (WKPermissionDecision) -> Void
        ) {
            let kind = Self.describe(type)
            ShellLog.write("webview.media-capture.request", "origin=\(origin.protocol)://\(origin.host):\(origin.port) type=\(kind)")
            guard ShellOrigin.isLoopback(webView.url ?? URL(fileURLWithPath: "/")) else {
                ShellLog.write("webview.media-capture.decision", "deny")
                return decisionHandler(.deny)
            }
            ShellLog.write("webview.media-capture.decision", "prompt")
            decisionHandler(.prompt)
        }

        private static func describe(_ type: WKMediaCaptureType) -> String {
            switch type {
            case .camera: "camera"
            case .microphone: "microphone"
            case .cameraAndMicrophone: "cameraAndMicrophone"
            @unknown default: "unknown"
            }
        }

        // MARK: Page reports

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            ShellLog.write("page.report", String(describing: message.body))
        }
    }
}
