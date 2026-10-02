import Capacitor
import UIKit

/// WHICH WAY THE PHONE MAY BE HELD, RIGHT NOW.
///
/// Erik, 2026-10-01, from /schedule: "I'd like to be able to turn the phone sideways to see the
/// calendar in full, but it would be nice to also keep the buttons for the top bar and the dock
/// exactly where they are while spinning everything in between only."
///
/// Portrait is the floor AND the default. The app opens portrait and every screen except the
/// schedule's calendar stays portrait on purpose: a phone held sideways has about 375pt of HEIGHT,
/// and the rest of the app is built for a tall screen (the note in timecards/timecard-stack.tsx
/// says so). Unlocking the whole app would hand every one of those screens a shape it was never
/// drawn for. The calendar is the one screen that gets WIDER-IS-BETTER out of it — its week is
/// seven columns that scroll sideways on a portrait phone — so it is the one screen that asks.
///
/// THE iPAD IS NEVER GATED. Info.plist's `UISupportedInterfaceOrientations~ipad` already allows
/// all four and should keep doing so; the view controller below only consults this value on an
/// iPhone.
enum ScreenTurn {
    /// What the shell's root view controller answers when iOS asks whether it may rotate.
    /// Written only on the main actor, by the plugin below.
    static var allowed: UIInterfaceOrientationMask = .portrait
    /// Portrait plus both ways round sideways — never upside down, which no iPhone screen wants.
    static let sideways: UIInterfaceOrientationMask = [.portrait, .landscapeLeft, .landscapeRight]
}

/// The page's one door to it: `window.Capacitor.Plugins.ScreenTurn.allow({ turn: "sideways" })`
/// while a screen can use the width, and `{ turn: "portrait" }` the moment it can't.
/// src/lib/native-orientation.ts is the web side.
///
/// A LOCAL plugin, like TapToPayEducation, NOT an npm one. All it needs is three lines of UIKit;
/// a package would add an SPM dependency, another patches/ surface (plugins here have needed
/// patching before), and nothing this file doesn't already do. The shell still has to be REBUILT
/// and REINSTALLED for any of it — the orientation list lives in Info.plist, which is compiled
/// into the app — so there was never a "no rebuild" option to protect.
@objc(ScreenTurnPlugin)
public class ScreenTurnPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ScreenTurnPlugin"
    public let jsName = "ScreenTurn"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "allow", returnType: CAPPluginReturnPromise)
    ]

    /// Resolves `{ turn: "sideways" | "portrait" }` — the state the shell is in AFTER the call, so
    /// the page is never told something different from what the phone will do. Anything that isn't
    /// the word "sideways" means portrait: an unknown word LOCKS, it never unlocks.
    @objc func allow(_ call: CAPPluginCall) {
        let sideways = call.getString("turn") == "sideways"
        // UIKit, so main actor; Capacitor calls plugin methods off the main thread.
        Task { @MainActor in
            ScreenTurn.allowed = sideways ? ScreenTurn.sideways : .portrait
            if #available(iOS 16.0, *), let vc = self.bridge?.viewController {
                // Ask iOS to re-read supportedInterfaceOrientations NOW, rather than whenever it
                // next happens to consider rotating.
                vc.setNeedsUpdateOfSupportedInterfaceOrientations()
                // And when the room for sideways is gone, turn the phone back by itself. Leaving
                // the calendar while holding the phone sideways must not strand anyone on a
                // portrait-only screen rendered into 375pt of height — NO DEAD ENDS.
                if !sideways, let scene = vc.view.window?.windowScene {
                    scene.requestGeometryUpdate(.iOS(interfaceOrientations: .portrait))
                }
            }
            // Below iOS 16 there is no public way to ask for a rotation, so the new mask simply
            // takes effect the next time the person turns the phone. Nothing is broken there; the
            // snap-back is just not instant. (Erik's phone is years past that floor.)
            call.resolve(["turn": sideways ? "sideways" : "portrait"])
        }
    }
}
