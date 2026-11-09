# llime iPad shell

A SwiftUI app (`com.llime.demo`, iPad only, deployment target iOS 26.0) that hosts the student UI in a
`WKWebView`, owns notification authorization and opens tapped notifications. It contains no learning logic.

| Folder | Contents |
| --- | --- |
| `LLiMeCore/` | Pure logic compiled into both the app and the tests: payload reader, student destination, tap router, origin choice, shell copy and tokens |
| `LLiMe/` | The app: lifecycle, notification delegate, web view model, audio session, views |
| `LLiMeTests/` | Unit tests (no host app), including drift checks that read `src/` and `web/styles/tokens.css` |

## Origin

The WebView loads one loopback origin. Resolution order:

1. launch argument `-LLIME_ORIGIN <url>` (each Task passes its own port)
2. the origin from the last such launch argument, remembered so a launch the OS starts from a notification
   tap (which passes no arguments) reaches the same backend
3. `LLIME_ORIGIN` in `Config/Info.plist` (default `http://127.0.0.1:4210`)

Only `http`/`https` on `127.0.0.1` or `localhost` is accepted; anything else shows an error screen. The
WebView only navigates within that exact origin (scheme, host and port), so it never reaches another
backend on the same interface. `NSAllowsLocalNetworking` is the only transport exception.

## Notification taps

The backend sends one simulated push per committed outbox row:

```json
{"aps":{"alert":{"title":"llime","body":"A quick challenge from today's lesson?"},"sound":"default"},
 "notificationId":"notif_1","runId":"run_1","activityId":"run_1_invitation","activityRevision":2}
```

- The shell accepts exactly these keys at every level, the default sound, IDs of 1–180 characters, a whole
  revision ≥ 0 and at most 4096 encoded bytes. Anything else, such as a URL, a category or a command, rejects
  the tap.
- A tap, from a warm resume or a cold launch, is held until the web view is mounted and
  `GET /api/bootstrap` answers 200. The shell then loads
  `<origin>/student?runId=…&activityId=…&activityRevision=…&notificationId=…`, with every value
  percent-encoded.
- The page resolves the IDs, records the open and shows the activity, or its unavailable or completed
  state. Opening is not consent: the page still asks.
- The same `notificationId` navigates once per launch. The same ID with other IDs is refused.
- If the backend is unreachable, the shell covers the page with a connection error and **Retry**. It keeps
  the tapped activity and opens it when the backend answers again, or when the child presses Retry.

Simulated push, with the payload on stdin:

```sh
printf '%s' "$PAYLOAD" | xcrun simctl push "$DEV" com.llime.demo -
```

On the Simulator the banner appears 1–2 s after the push and stays for about 5 s.

## Media capture

- Only the configured page's main frame may ask for the microphone. The shell answers `prompt`, so the
  person decides, and it denies camera requests.
- Inline playback is on, and remote WebRTC audio may start without a fresh tap.
- The audio session is `playAndRecord`, so the page can listen and speak at once. The page starts and stops
  both itself.
- The web view's microphone capture state is logged as `webview.microphone active|muted|none`. This is the
  native evidence that the page tore the microphone down.

The iOS Simulator shows WebKit's per-site microphone prompt but not the OS prompt that carries
`NSMicrophoneUsageDescription`; that text is only visible on a device.

## Build, test, install, launch

```sh
DEV=$(xcrun simctl create <task-id> "iPad Pro 11-inch (M5)" com.apple.CoreSimulator.SimRuntime.iOS-26-5)
xcrun simctl boot "$DEV"
xcodebuild -project ios/LLiMe.xcodeproj -scheme LLiMe -configuration Debug \
  -destination "platform=iOS Simulator,id=$DEV" -derivedDataPath .runtime/build build
xcodebuild -project ios/LLiMe.xcodeproj -scheme LLiMe -configuration Debug \
  -destination "platform=iOS Simulator,id=$DEV" -derivedDataPath .runtime/build test
xcrun simctl install "$DEV" .runtime/build/Build/Products/Debug-iphonesimulator/llime.app
xcrun simctl launch "$DEV" com.llime.demo -LLIME_ORIGIN http://127.0.0.1:<PORT>
```

Drive it with `orca emulator attach <task-id>`, `tap`, `ax`, `rotate`.

## Logs

Every shell event is written to the unified log (subsystem `com.llime.demo`, category `shell`) and to
`Documents/shell.log` in the app container:

```sh
C=$(xcrun simctl get_app_container "$DEV" com.llime.demo data); cat "$C/Documents/shell.log"
xcrun simctl spawn "$DEV" log show --last 10m --predicate 'subsystem == "com.llime.demo"' --style compact
```

Tap events are `notification.tap.accepted|duplicate|conflict|rejected|queued`, `backend.probe`,
`notification.open` and `notification.opened`. Connection events are `shell.offline` and `shell.retry`.
A page can report to the log with `webkit.messageHandlers.llimeLog.postMessage(string)`.

## Cleanup

```sh
orca emulator kill; xcrun simctl shutdown "$DEV"; xcrun simctl delete "$DEV"
```
