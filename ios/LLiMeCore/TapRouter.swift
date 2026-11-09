/// What happened to a tap the OS delivered.
enum TapReceipt: Equatable {
    case accepted
    /// This notificationId was already handled; it never navigates a second time.
    case duplicate
    /// This notificationId was already seen with other identifiers; neither is trusted again.
    case conflict
}

/// Holds a tapped destination until both the web view and the backend are ready, so a tap during a
/// cold launch or while the backend is down is kept rather than lost or opened onto an error.
/// It decides when to open; it never decides what an activity means.
struct TapRouter {
    /// The destination still waiting to open. It survives failed probes and failed loads for Retry.
    private(set) var pending: NotificationTap?
    /// Every tap seen this launch, by notificationId. A session sees a handful, so it is not trimmed.
    private var seen: [String: NotificationTap] = [:]
    private var isWebViewMounted = false
    private var isBackendReachable = false

    /// The tap to open now, or nil while waiting for a tap, the web view or a fresh backend probe.
    var tapToOpen: NotificationTap? {
        isWebViewMounted && isBackendReachable ? pending : nil
    }

    mutating func receive(_ tap: NotificationTap) -> TapReceipt {
        if let earlier = seen[tap.notificationId] {
            return earlier == tap ? .duplicate : .conflict
        }
        seen[tap.notificationId] = tap
        pending = tap
        // Reachability observed before this tap says nothing about now: probe again before opening.
        isBackendReachable = false
        return .accepted
    }

    mutating func webViewMounted() {
        isWebViewMounted = true
    }

    /// Called with each probe result, and with `false` when loading the destination fails.
    mutating func backendProbed(isReachable: Bool) {
        isBackendReachable = isReachable
    }

    /// The page for `tap` finished loading. A newer tap that arrived meanwhile stays pending.
    mutating func opened(_ tap: NotificationTap) {
        if pending == tap { pending = nil }
    }
}
