import Capacitor
import ProximityReader
import UIKit

// Why this plugin exists: Apple's Tap to Pay on iPhone review checklist (v1.7) wants merchant
// education delivered through ProximityReaderDiscovery on iOS 18+ (4.1) and an "update iOS"
// sentence on phones that cannot run the feature (1.4). Both are native-only calls the Stripe
// Terminal plugin does not expose, so the hosted web app reaches them here through
// window.Capacitor.Plugins.TapToPayEducation — never through an npm import in the browser bundle
// (on device that import hung; see src/lib/native-tap.ts for the pattern).
//
// What is deliberately NOT here: whether the merchant has accepted the Terms (Apple 1.6 — read
// from Apple on every ask, never kept in a variable). Apple's own door for that,
// PaymentCardReader.isAccountLinked(using:), takes the PSP token that only Stripe's SDK holds, so
// the bridge asks StripeTerminal.isTapToPayAccountLinked (readLinked in src/lib/native-tap.ts) —
// Stripe's wrapper over that same Apple call, iOS 16.4+, after initialize(). A stub here once
// rejected with that pointer; nothing ever called it, so the dead surface is gone.
//
// Every method resolves a plain object or rejects with ONE plain sentence that names the fix.
// The web side shows the sentence as-is, so the words here are the words the tech reads
// (NOTHING SILENT / NO DEAD ENDS). Apple's naming rule applies: prose says the long form,
// "Tap to Pay on iPhone", in full.
@objc(TapToPayEducationPlugin)
public class TapToPayEducationPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "TapToPayEducationPlugin"
    public let jsName = "TapToPayEducation"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "showHowToTap", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isSupported", returnType: CAPPluginReturnPromise)
    ]

    /// The iOS floor for the built-in reader. Apple only tells us the MODEL
    /// (PaymentCardReader.isSupported "doesn't check the OS version"); the OS check proper —
    /// PaymentCardReaderError.osVersionNotSupported — is raised by prepare(using:), which needs a
    /// PSP token this plugin never holds. Stripe's Terminal SDK names 16.7 as the "minimum supported
    /// version" for SCPDeviceTypeAppleBuiltIn (its CHANGELOG, 3.8.0), so that is the number
    /// `osTooOld` and the "update iOS" sentence hang on. Newer floors still surface later, at connect
    /// time, as Stripe's "Unsupported mobile device configuration" sentence, which the web side
    /// already handles.
    private static let minimumOS = OperatingSystemVersion(majorVersion: 16, minorVersion: 7, patchVersion: 0)

    // MARK: - isSupported

    /// Resolves { supported: Bool, modelSupported: Bool, osTooOld: Bool, reason: String?, osVersion: String }.
    /// `modelSupported` is Apple's answer (PaymentCardReader.isSupported); `osTooOld` is the Apple 1.4
    /// signal — this iOS is below what the built-in reader needs; `supported` is both. The web side
    /// reads the Bools, not the words, to pick its sentence, and remembers `modelSupported` so the
    /// SDK's one-string "no" at connect time can be split into "phone" vs "iOS" later. `reason` is
    /// present only when `supported` is false and is the full sentence to show. (`modelSupported` is
    /// the one key that can be absent — below iOS 15.4, where Apple can't be asked; see inside.)
    @objc func isSupported(_ call: CAPPluginCall) {
        let osVersion = UIDevice.current.systemVersion
        let osTooOld = !ProcessInfo.processInfo.isOperatingSystemAtLeast(Self.minimumOS)
        var result: [String: Any] = ["osVersion": osVersion, "osTooOld": osTooOld]

        // The framework itself arrived in iOS 15.4 (the shell's deployment target is 15.0), so below
        // it there is no one to ask about the model. `modelSupported` is left OUT rather than guessed:
        // the bridge reads a missing Bool as "unknown", and a made-up `false` would have it blame the
        // phone after the tech updates iOS. The OS answer is the whole answer here.
        guard #available(iOS 15.4, *) else {
            result["supported"] = false
            result["reason"] = Self.updateIOSSentence(osVersion)
            call.resolve(result)
            return
        }

        // Apple's model check: iPhone XS or newer. A static Bool — no token, no entitlement, cannot
        // throw — so it is safe to read on any build, including Release without the Tap to Pay key.
        // (That key's absence shows up later, at connect time, as Stripe's "Operation not permitted…
        // entitlements" sentence; it is not something this property can see.)
        let modelSupported = PaymentCardReader.isSupported
        result["modelSupported"] = modelSupported
        result["supported"] = modelSupported && !osTooOld

        if !modelSupported {
            // The model verdict outranks the OS one: an iPhone X can update iOS forever and never get
            // there, so "update iOS" on it would be a dead end. Point at the other ways to get paid.
            result["reason"] = "This iPhone can't take Tap to Pay on iPhone — it needs an iPhone XS or newer. Take the payment with the QR code or the pay link instead."
        } else if osTooOld {
            // Model is fine; the OS is what's short. This is where Apple's osVersionNotSupported case
            // lands (1.4): the fix is an iOS update, so the sentence says exactly that.
            result["reason"] = Self.updateIOSSentence(osVersion)
        }
        call.resolve(result)
    }

    private static func updateIOSSentence(_ osVersion: String) -> String {
        return "Tap to Pay on iPhone needs a newer version of iOS than this phone's \(osVersion). Update to the latest version of iOS in Settings → General → Software Update, then try again."
    }

    // MARK: - showHowToTap

    /// Presents Apple's own "how to tap" merchant-education sheet (ProximityReaderDiscovery,
    /// iOS 18+). Resolves { ok: true } once the sheet has been shown; rejects with a sentence
    /// naming the fix. The await inside can span the time the sheet is on screen, so the web
    /// side should not treat a slow promise as a failure — the sheet is Apple's, in front of us.
    @objc func showHowToTap(_ call: CAPPluginCall) {
        guard #available(iOS 18.0, *) else {
            // Older phones get the same words the web side uses for its text-only fallback, so
            // the tech is never told "unavailable" without being told what would make it available.
            call.reject("Apple's Tap to Pay on iPhone guide needs iOS 18 or later, and this iPhone is on iOS \(UIDevice.current.systemVersion). Update in Settings → General → Software Update, or read the written steps here instead.")
            return
        }

        // presentContent(_:from:) takes a UIViewController, so the whole thing is main-actor work;
        // Capacitor calls plugin methods off the main thread.
        Task { @MainActor in
            guard var top = self.bridge?.viewController else {
                call.reject("The app's screen isn't ready yet. Close and reopen the app, then try again.")
                return
            }
            // Apple presents from the view controller you hand it and fails if something else is
            // already presented on top of that one — so walk to whatever is topmost right now.
            while let presented = top.presentedViewController {
                top = presented
            }

            do {
                let discovery = ProximityReaderDiscovery()
                let content = try await discovery.content(for: .payment(.howToTap))
                try await discovery.presentContent(content, from: top)
                call.resolve(["ok": true])
            } catch {
                call.reject(Self.sentence(for: error), nil, error)
            }
        }
    }

    /// One sentence per ContentError, each naming what to do. The enum is not frozen, so the
    /// @unknown default keeps a future case from turning into a silent generic failure.
    @available(iOS 18.0, *)
    private static func sentence(for error: Error) -> String {
        guard let contentError = error as? ProximityReaderDiscovery.ContentError else {
            return "Apple's Tap to Pay on iPhone guide couldn't be shown (\(error.localizedDescription)). Try again in a moment."
        }
        switch contentError {
        case .networkUnavailable:
            return "Apple's Tap to Pay on iPhone guide needs an internet connection. Get on Wi-Fi or cellular and try again."
        case .notSupported:
            return "This iPhone can't show Apple's Tap to Pay on iPhone guide — Tap to Pay on iPhone needs an iPhone XS or newer."
        case .systemBusy:
            return "iOS is busy right now and couldn't open Apple's Tap to Pay on iPhone guide. Wait a moment and try again."
        case .contentNotFound:
            return "Apple hasn't published the Tap to Pay on iPhone guide for this phone's region yet. Try again later."
        case .contentDisplayFailed:
            return "Apple's Tap to Pay on iPhone guide couldn't open on top of this screen. Close anything that's open over the app and try again."
        case .unknown:
            return "Apple's Tap to Pay on iPhone guide couldn't be shown. Try again in a moment."
        @unknown default:
            return "Apple's Tap to Pay on iPhone guide couldn't be shown (\(contentError.localizedDescription)). Try again in a moment."
        }
    }
}
