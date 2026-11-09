import AVFAudio

/// Voice runs over WebRTC inside the page: the child's microphone and the tutor's reply are live at the
/// same time, so the app's session must allow recording and playback together. The page owns starting
/// and stopping both; WebKit activates the session only while it captures or plays.
enum AudioSession {
    static func configureForVoice() {
        let session = AVAudioSession.sharedInstance()
        do {
            // Default mode: WebKit applies its own echo cancellation, and the voice-chat mode without
            // Apple's voice-processing unit would lower playback instead. No speaker override, so the
            // recording operator's headphones keep working.
            try session.setCategory(.playAndRecord, mode: .default)
            ShellLog.write("audio.session.configured", "category=\(session.category.rawValue) mode=\(session.mode.rawValue)")
        } catch {
            ShellLog.write("audio.session.error", error.localizedDescription)
        }
        observe(session)
    }

    /// Interruptions and route changes are logged so a voice run can show what the hardware did.
    private static func observe(_ session: AVAudioSession) {
        let center = NotificationCenter.default
        _ = center.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: .main) { note in
            let type = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt).flatMap(AVAudioSession.InterruptionType.init)
            ShellLog.write("audio.session.interruption", type == .began ? "began" : "ended")
        }
        _ = center.addObserver(forName: AVAudioSession.routeChangeNotification, object: session, queue: .main) { note in
            let reason = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt ?? 0
            let route = AVAudioSession.sharedInstance().currentRoute
            let inputs = route.inputs.map(\.portType.rawValue).joined(separator: ",")
            let outputs = route.outputs.map(\.portType.rawValue).joined(separator: ",")
            ShellLog.write("audio.session.route", "reason=\(reason) inputs=\(inputs) outputs=\(outputs) category=\(AVAudioSession.sharedInstance().category.rawValue)")
        }
    }
}
