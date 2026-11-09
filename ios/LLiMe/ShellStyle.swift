import SwiftUI

/// SwiftUI values for the shared student tokens.
enum ShellStyle {
    static let background = Color(hex: ShellTokens.background)
    static let text = Color(hex: ShellTokens.text)
    static let muted = Color(hex: ShellTokens.muted)
    static let primary = Color(hex: ShellTokens.primary)
    static let onPrimary = Color(hex: ShellTokens.onPrimary)
    static let bodySize = CGFloat(ShellTokens.bodySize)
    static let headingSize = CGFloat(ShellTokens.headingSize)
    static let spacing = CGFloat(ShellTokens.spacing)
    static let radius = CGFloat(ShellTokens.radius)
    static let studentTarget = CGFloat(ShellTokens.studentTarget)
}

private extension Color {
    init(hex: UInt32) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }
}
