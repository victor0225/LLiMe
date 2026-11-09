/// The student design tokens the native shell needs for its own screen, so it looks like the page it
/// stands in for. Colors are 0xRRGGBB; sizes are points, matching the web token sheet's pixels.
enum ShellTokens {
    static let background: UInt32 = 0xDDF4FF
    static let text: UInt32 = 0x3C3C3C
    static let muted: UInt32 = 0x595959
    static let primary: UInt32 = 0xA5ED6E
    static let onPrimary: UInt32 = 0x111111
    static let bodySize: Double = 20
    static let headingSize: Double = 28
    static let spacing: Double = 20
    static let radius: Double = 12
    // Children's controls are larger than the 48-point minimum.
    static let studentTarget: Double = 56
}
