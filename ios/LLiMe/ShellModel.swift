import Observation
import WebKit

/// Name the page uses to report to the shell: `webkit.messageHandlers.llimeLog.postMessage(...)`.
private let pageLogHandlerName = "llimeLog"

/// Owns the one web view for the app's lifetime, so rotation and overlays never recreate it and the
/// page keeps its activity and attempt state. Opens a tapped activity once the web view is mounted and
/// the backend answers; it never interprets learning state.
@MainActor
@Observable
final class ShellModel: NSObject {
    enum Connection: Equatable {
        case connecting
        case connected
        /// The backend did not answer. `isHoldingActivity` is true when a tapped activity waits for Retry.
        case offline(isHoldingActivity: Bool)
    }

    let origin: Result<URL, ShellOriginError>
    private(set) var connection = Connection.connecting

    @ObservationIgnored let webView: WKWebView
    @ObservationIgnored private var router = TapRouter()
    @ObservationIgnored private var destinationLoad: (navigation: WKNavigation, tap: NotificationTap)?
    @ObservationIgnored private var isProbing = false
    @ObservationIgnored private var reconnectTask: Task<Void, Never>?
    @ObservationIgnored private var microphoneObservation: NSKeyValueObservation?

    init(origin: Result<URL, ShellOriginError>) {
        self.origin = origin
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        // The tutor's WebRTC audio starts when the remote track arrives, not on a tap, so playback
        // cannot wait for a fresh user gesture.
        configuration.mediaTypesRequiringUserActionForPlayback = []
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        // The model lives as long as the app, so the controller's strong reference to it is harmless.
        configuration.userContentController.add(self, name: pageLogHandlerName)
        webView.isInspectable = true
        webView.navigationDelegate = self
        webView.uiDelegate = self
        // The change record does not carry this enum's new value, so read it from the web view.
        microphoneObservation = webView.observe(\.microphoneCaptureState) { webView, _ in
            Task { @MainActor in ShellLog.write("webview.microphone", Self.describe(webView.microphoneCaptureState)) }
        }
    }

    // MARK: Lifecycle

    func webViewMounted() {
        guard !router.isWebViewMounted else { return }
        router.webViewMounted()
        ShellLog.write("webview.mounted")
        if router.pending != nil {
            Task { await openPendingTap() }
        } else {
            loadStart()
        }
    }

    func receive(_ parsed: Result<NotificationTap, NotificationPayloadError>) {
        switch parsed {
        case .failure(let error):
            ShellLog.write("notification.tap.rejected", "reason=\(error)")
        case .success(let tap):
            let receipt = router.receive(tap)
            ShellLog.write("notification.tap.\(receipt)", Self.describe(tap))
            guard receipt == .accepted else { return }
            if !router.isWebViewMounted { ShellLog.write("notification.tap.queued", "waiting=webview") }
            Task { await openPendingTap() }
        }
    }

    /// Retry from the offline screen: the held activity if there is one, otherwise the start page.
    func retry() {
        ShellLog.write("shell.retry")
        if router.pending != nil {
            Task { await openPendingTap() }
        } else {
            loadStart()
        }
    }

    /// Reloads the page the child is on, not the start page, so a tapped activity stays open.
    func reload() {
        ShellLog.write("shell.reload")
        if webView.url == nil { loadStart() } else { webView.reload() }
    }

    // MARK: Opening

    private func loadStart() {
        guard case .success(let start) = origin else { return }
        connection = .connecting
        ShellLog.write("webview.load", start.absoluteString)
        webView.load(URLRequest(url: start))
    }

    private func openPendingTap() async {
        guard case .success(let origin) = origin, router.isWebViewMounted, router.pending != nil, !isProbing else { return }
        isProbing = true
        let isReachable = await BackendProbe.isReachable(origin)
        isProbing = false
        router.backendProbed(isReachable: isReachable)
        guard let tap = router.tapToOpen else {
            if router.pending != nil { goOffline() }
            return
        }
        guard let destination = tap.destination(on: origin) else {
            ShellLog.write("notification.open.invalid", Self.describe(tap))
            return
        }
        ShellLog.write("notification.open", destination.absoluteString)
        connection = .connecting
        if let navigation = webView.load(URLRequest(url: destination)) {
            destinationLoad = (navigation, tap)
        }
    }

    private func goOffline() {
        let isHoldingActivity = router.pending != nil
        let offline = Connection.offline(isHoldingActivity: isHoldingActivity)
        if connection != offline { ShellLog.write("shell.offline", "holdingActivity=\(isHoldingActivity)") }
        connection = offline
        if isHoldingActivity { keepReconnecting() }
    }

    /// While a tapped activity waits offline, the shell keeps looking for the backend so the activity
    /// opens once the connection is back, as the offline screen says. Retry checks at once.
    private func keepReconnecting() {
        guard reconnectTask == nil else { return }
        reconnectTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: Self.reconnectInterval)
                guard let self, case .offline(isHoldingActivity: true) = self.connection else { break }
                await self.openPendingTap()
            }
            self?.reconnectTask = nil
        }
    }

    private func navigationFailed(_ navigation: WKNavigation?, _ error: Error) {
        ShellLog.write("webview.load.failed", error.localizedDescription)
        // Only a failure to reach the backend is a connection problem; a navigation replaced by a newer
        // one or refused by the origin policy is not.
        guard let code = (error as? URLError)?.code, Self.connectionFailures.contains(code) else { return }
        if let load = destinationLoad, load.navigation === navigation {
            destinationLoad = nil
            router.backendProbed(isReachable: false)
        }
        goOffline()
    }

    // Often enough that the activity appears soon after the backend restarts; each check is one
    // loopback request.
    private static let reconnectInterval = Duration.seconds(3)
    private static let connectionFailures: Set<URLError.Code> = [.cannotConnectToHost, .cannotFindHost, .networkConnectionLost, .notConnectedToInternet, .timedOut]

    // MARK: Descriptions for the log

    private static func describe(_ tap: NotificationTap) -> String {
        "notificationId=\(tap.notificationId) runId=\(tap.runId) activityId=\(tap.activityId) activityRevision=\(tap.activityRevision)"
    }

    private static func describe(_ type: WKMediaCaptureType) -> String {
        switch type {
        case .camera: "camera"
        case .microphone: "microphone"
        case .cameraAndMicrophone: "cameraAndMicrophone"
        @unknown default: "unknown"
        }
    }

    private static func describe(_ state: WKMediaCaptureState) -> String {
        switch state {
        case .none: "none"
        case .active: "active"
        case .muted: "muted"
        @unknown default: "unknown"
        }
    }
}

// MARK: - Navigation

extension ShellModel: WKNavigationDelegate {
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url, case .success(let origin) = origin else { return decisionHandler(.cancel) }
        let isAllowed = url.scheme == "about" || ShellOrigin.isSameOrigin(url, as: origin)
        if !isAllowed { ShellLog.write("webview.navigation.blocked", url.absoluteString) }
        decisionHandler(isAllowed ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        ShellLog.write("webview.loaded", webView.url?.absoluteString ?? "")
        if let load = destinationLoad, load.navigation === navigation {
            destinationLoad = nil
            router.opened(load.tap)
            ShellLog.write("notification.opened", Self.describe(load.tap))
        }
        connection = router.pending == nil ? .connected : connection
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        navigationFailed(navigation, error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        navigationFailed(navigation, error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // A blank page has no way back for a child; reload what was showing.
        ShellLog.write("webview.content-process.terminated")
        reload()
    }
}

// MARK: - Media capture

extension ShellModel: WKUIDelegate {
    /// Only the configured page's main frame may ask for the microphone, and only the microphone.
    /// Returning `.prompt` lets WebKit and the OS ask the person; the shell never grants on their behalf.
    func webView(
        _ webView: WKWebView,
        requestMediaCapturePermissionFor securityOrigin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        type: WKMediaCaptureType,
        decisionHandler: @escaping @MainActor (WKPermissionDecision) -> Void
    ) {
        let requester = "\(securityOrigin.protocol)://\(securityOrigin.host):\(securityOrigin.port)"
        let isConfiguredPage = switch origin {
        case .success(let origin):
            ShellOrigin.isSameOrigin(scheme: securityOrigin.protocol, host: securityOrigin.host, port: securityOrigin.port == 0 ? nil : securityOrigin.port, as: origin)
        case .failure:
            false
        }
        let decision: WKPermissionDecision = isConfiguredPage && frame.isMainFrame && type == .microphone ? .prompt : .deny
        ShellLog.write("webview.media-capture", "origin=\(requester) mainFrame=\(frame.isMainFrame) type=\(Self.describe(type)) decision=\(decision == .prompt ? "prompt" : "deny")")
        decisionHandler(decision)
    }
}

// MARK: - Page reports

extension ShellModel: WKScriptMessageHandler {
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        ShellLog.write("page.report", String(describing: message.body))
    }
}

/// Asks the backend's bootstrap route whether it can serve a session right now. The body (which holds
/// the page's session nonce) is discarded; only the status matters.
enum BackendProbe {
    // A loopback backend answers in milliseconds; past this the child sees Retry rather than a spinner.
    private static let timeout: TimeInterval = 5
    private static let session = URLSession(configuration: .ephemeral)

    static func isReachable(_ origin: URL) async -> Bool {
        guard let url = BackendRoute.bootstrapURL(on: origin) else { return false }
        let request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        do {
            let (_, response) = try await session.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            ShellLog.write("backend.probe", "status=\(status)")
            return status == 200
        } catch {
            ShellLog.write("backend.probe", "error=\(error.localizedDescription)")
            return false
        }
    }
}
