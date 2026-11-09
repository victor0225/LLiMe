# llime iPad shell

A SwiftUI app (`com.llime.demo`, iPad only, deployment target iOS 26.0) that hosts the student UI in a
`WKWebView` and owns notification authorization. It contains no learning logic.

## Origin

The WebView loads one loopback origin. Resolution order:

1. launch argument `-LLIME_ORIGIN <url>` (each Task passes its own port)
2. `LLIME_ORIGIN` in `Config/Info.plist` (default `http://127.0.0.1:4210`)

Only `http`/`https` on `127.0.0.1` or `localhost` is accepted; anything else shows an error screen and the
WebView also refuses to navigate away from loopback. `NSAllowsLocalNetworking` is the only transport exception.

## Media capture

The shell implements the WebKit media-capture delegate and answers `prompt`, so the person decides.
Typed and spoken input stay the page's concern.

## Build, install, launch

```sh
DEV=$(xcrun simctl create <task-id> "iPad Pro 11-inch (M5)" com.apple.CoreSimulator.SimRuntime.iOS-26-5)
xcrun simctl boot "$DEV"
xcodebuild -project ios/LLiMe.xcodeproj -scheme LLiMe -configuration Debug \
  -destination "platform=iOS Simulator,id=$DEV" -derivedDataPath .runtime/build build
xcrun simctl install "$DEV" .runtime/build/Build/Products/Debug-iphonesimulator/llime.app
xcrun simctl launch "$DEV" com.llime.demo -LLIME_ORIGIN http://127.0.0.1:<PORT>
```

Drive it with `orca emulator attach <task-id>`, `tap`, `ax`.

## Logs

Every shell event is written to the unified log (subsystem `com.llime.demo`, category `shell`) and to
`Documents/shell.log` in the app container:

```sh
C=$(xcrun simctl get_app_container "$DEV" com.llime.demo data); cat "$C/Documents/shell.log"
xcrun simctl spawn "$DEV" log show --last 10m --predicate 'subsystem == "com.llime.demo"' --style compact
```

A page can report to the log with `webkit.messageHandlers.llimeLog.postMessage(string)`.

## Cleanup

```sh
orca emulator kill; xcrun simctl shutdown "$DEV"; xcrun simctl delete "$DEV"
```
