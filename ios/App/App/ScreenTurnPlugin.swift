import Capacitor
import UIKit

/// WHICH WAY THE PHONE IS BEING HELD, RIGHT NOW — REPORTED, not permitted.
///
/// Erik, 2026-10-01, twice:
///   "I'd like to be able to turn the phone sideways to see the calendar in full, but it would be
///    nice to also keep the buttons for the top bar and the dock exactly where they are while
///    spinning everything in between only."
///   "On the app rotation is it possible to lock the top bar and the dock positions and just rotate
///    the buttons while the internal screen rotates?"
///
/// THIS FILE CHANGED JOBS. It used to UNLOCK the interface so iOS would rotate the whole view, and
/// iOS rotating the whole view is exactly what carried the top bar and the dock around with it —
/// which is what he reported on cn-v1041: "nice it rotates now on schedule but the dock and top bar
/// rotate with it still." The interface is locked to portrait again (Info.plist), so the chrome
/// cannot move: it is pinned to the phone's real top and bottom edges because nothing moves at all.
///
/// AND THIS IS WHAT MAKES THAT POSSIBLE. iOS reports the DEVICE's orientation — UIDevice.orientation
/// and UIDevice.orientationDidChangeNotification — even while the INTERFACE is locked to portrait.
/// They are two different things, and only the second one is locked. So the page never has to work
/// out from inside a locked window whether the phone moved: the shell tells it, and the page draws
/// the region between the chrome a quarter turn.
///
/// ONE CHANNEL, THE ONE THE SHELL ALREADY USES: a `cn:phone-held` window event, evaluated into the
/// page the same way NavigationFailureRelay tells it a navigation failed. A plain event, so a page
/// served to a build without this plugin simply never hears one and stays upright. The web side is
/// src/lib/native-orientation.ts; which screens may use it is src/lib/screens-that-turn.ts.
///
/// A LOCAL plugin, like TapToPayEducation, NOT an npm one. All it needs is UIKit; a package would add
/// an SPM dependency and another patches/ surface (plugins here have needed patching before) for
/// nothing this file doesn't already do. The shell still has to be REBUILT and REINSTALLED — the
/// orientation list is in Info.plist, compiled into the app.
///
/// THE iPAD IS NEVER REPORTED AS TURNED. Its interface DOES rotate (the ~ipad list in Info.plist,
/// and NorthBridgeViewController hands it `.all`), so iOS is already doing the turning there. Saying
/// "held sideways" as well would have the page draw a second quarter turn on top of iOS's one.
enum PhoneHeld: String {
    /// Portrait, or flat on a table, or upside down — anything that is not a quarter turn.
    case upright
    /// The person turned the phone clockwise: its TOP edge now points to their right.
    /// iOS calls that device orientation landscapeRight (the home button is on the left).
    case clockwise
    /// The mirror of it: the top edge points to their left. iOS: landscapeLeft.
    case counterclockwise

    /// The one mapping. Upside down and the two flat-on-a-table cases are deliberately NOT turns:
    /// a phone lying on a bench has not changed which way the person is reading it, and the page
    /// must not flip the screen because somebody set it down.
    static func from(_ device: UIDeviceOrientation) -> PhoneHeld? {
        switch device {
        case .portrait, .portraitUpsideDown: return .upright
        case .landscapeLeft: return .counterclockwise
        case .landscapeRight: return .clockwise
        // .faceUp, .faceDown, .unknown — no opinion. The caller keeps the last one it reported.
        default: return nil
        }
    }
}

/// The page's two doors to it: the `cn:phone-held` event, and
/// `window.Capacitor.Plugins.ScreenTurn.read()` for the state that already happened before a screen
/// mounted — a hard reload while the phone is already turned.
@objc(ScreenTurnPlugin)
public class ScreenTurnPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ScreenTurnPlugin"
    public let jsName = "ScreenTurn"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "read", returnType: CAPPluginReturnPromise)
    ]

    /// The last word sent to the page. Main actor only.
    private var held: PhoneHeld = .upright
    private var watching = false
    /// The orientation observer, kept so it can be let go of rather than outliving the plugin.
    private var observer: NSObjectProtocol?

    deinit {
        if let observer { NotificationCenter.default.removeObserver(observer) }
    }

    /// An iPad turns its own interface, so it is never reported as held sideways (see above).
    private var reports: Bool {
        UIDevice.current.userInterfaceIdiom != .pad
    }

    override public func load() {
        Task { @MainActor in
            self.startWatching()
        }
    }

    @MainActor
    private func startWatching() {
        guard !watching, reports else { return }
        watching = true
        // UIDevice.orientation is .unknown until an app asks for these notifications, so this call is
        // what makes read() able to answer at all — not only what makes the changes arrive.
        UIDevice.current.beginGeneratingDeviceOrientationNotifications()
        held = PhoneHeld.from(UIDevice.current.orientation) ?? .upright
        observer = NotificationCenter.default.addObserver(
            forName: UIDevice.orientationDidChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.deviceTurned()
            }
        }
    }

    @MainActor
    private func deviceTurned() {
        // A word we have no opinion on (flat on a bench) keeps the last one: the person has not
        // changed which way they are reading the screen.
        guard let now = PhoneHeld.from(UIDevice.current.orientation), now != held else { return }
        held = now
        tellThePage(now)
    }

    /// The same channel NavigationFailureRelay uses. The word comes from a fixed enum, so there is
    /// nothing here a page could be made to evaluate.
    @MainActor
    private func tellThePage(_ now: PhoneHeld) {
        guard let webView = self.webView else { return }
        webView.evaluateJavaScript(
            "window.dispatchEvent(new CustomEvent('cn:phone-held', { detail: { held: '\(now.rawValue)' } }))",
            completionHandler: nil
        )
    }

    /// Resolves `{ held: "upright" | "clockwise" | "counterclockwise" }` — what the phone is doing at
    /// this instant, for a screen that has just mounted. Never rejects: a screen that cannot find out
    /// has to keep working exactly as it does today, which means upright.
    @objc func read(_ call: CAPPluginCall) {
        Task { @MainActor in
            // A screen can mount before load() ran on the main actor; asking again is free.
            self.startWatching()
            let now = self.reports ? (PhoneHeld.from(UIDevice.current.orientation) ?? self.held) : .upright
            self.held = now
            call.resolve(["held": now.rawValue])
        }
    }
}
