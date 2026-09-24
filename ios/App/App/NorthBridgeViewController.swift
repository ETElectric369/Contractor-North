import AVFoundation
import Capacitor
import WebKit

// The shell's root view controller. Capacitor only knows about a local plugin if it is
// registered on the bridge before the web view loads, and the hook for that is
// capacitorDidLoad() on a CAPBridgeViewController subclass — a plain CAPBridgeViewController
// never learns about TapToPayEducation, and the hosted page's
// window.Capacitor.Plugins.TapToPayEducation is simply undefined.
//
// Both places that create the root view controller must name THIS class: SceneDelegate
// (which builds it in code and replaces whatever the storyboard made) and Main.storyboard.
// A mismatch registers the plugin on a view controller that is never on screen — no error,
// no log line, just a missing plugin.
class NorthBridgeViewController: CAPBridgeViewController {
    /// WKWebView holds its navigation delegate weakly, so the relay lives here.
    private var navigationRelay: NavigationFailureRelay?

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        bridge?.registerPluginInstance(TapToPayEducationPlugin())
        installNavigationFailureRelay()
        shareTheSpeaker()
        #if DEBUG
        AudioSessionProbe.shared.start()
        #endif
    }

    /// THE CRACKLE (2026-09-24, iOS 27). Nort's spoken replies crackled in the app and played clean in
    /// Safari on the same phone. The Debug audio probe showed why: the web view's audio runs in
    /// WebKit's own process, which this app sees as OTHER audio (isOtherAudioPlaying flapping on and
    /// off), while the app's own session sat in the default SoloAmbient category, the one that refuses
    /// to mix. The app's session was interrupted mid-conversation and the route was reconfigured a
    /// dozen times in one short exchange: two owners of the speaker cutting each other off. Safari
    /// owns both sides and never fights itself. Declaring the app's session mixable ends the fight;
    /// .playback keeps anything the app process itself says audible with the silent switch on.
    private func shareTheSpeaker() {
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, options: [.mixWithOthers])
        } catch {
            print("[AudioSession] could not declare the app's audio mixable: \(error)")
        }
    }

    /// Capacitor builds its navigation delegate inside a final loadView and offers no hook to
    /// replace it, so the relay wraps it instead: every callback still reaches Capacitor's own
    /// handler, and one of them is also told to the page.
    private func installNavigationFailureRelay() {
        guard let webView = webView,
              let inner = webView.navigationDelegate as? (NSObject & WKNavigationDelegate) else { return }
        let relay = NavigationFailureRelay(inner: inner)
        navigationRelay = relay
        webView.navigationDelegate = relay
    }
}

/// A NAVIGATION THAT FAILS BEFORE IT LANDS (the 09-23 sweep). Capacitor resets the bridge when a
/// navigation STARTS, wiping every plugin listener, and when that navigation then fails (no
/// signal, a timeout) the old page is still on screen and still running, with nothing listening:
/// Tap to Pay could not hear the reader for the rest of the session, a notification tap went
/// nowhere, and the tap that started it ("Didn't open new job") simply did nothing. The old page
/// gets no event of its own, so this tells it: a `cn:navigation-failed` event it can report,
/// explain, and recover from.
final class NavigationFailureRelay: NSObject, WKNavigationDelegate {
    private let inner: NSObject & WKNavigationDelegate

    init(inner: NSObject & WKNavigationDelegate) {
        self.inner = inner
        super.init()
    }

    // Everything this class does not implement goes to Capacitor's handler untouched. WebKit asks
    // respondsToSelector once, when the delegate is set, so both halves must answer for the inner
    // handler's methods or WebKit would never call them.
    override func responds(to aSelector: Selector!) -> Bool {
        return super.responds(to: aSelector) || inner.responds(to: aSelector)
    }

    override func forwardingTarget(for aSelector: Selector!) -> Any? {
        return inner.responds(to: aSelector) ? inner : super.forwardingTarget(for: aSelector)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        inner.webView?(webView, didFailProvisionalNavigation: navigation, withError: error)

        let ns = error as NSError
        // Not failures: a navigation cancelled on purpose (Capacitor sends outside links to
        // Safari by cancelling them), a load a policy change interrupted, or one a plugin handled.
        if ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled { return }
        if ns.domain == "WebKitErrorDomain" && [101, 102, 204].contains(ns.code) { return }

        let detail: [String: Any] = [
            "domain": ns.domain,
            "code": ns.code,
            "url": (ns.userInfo[NSURLErrorFailingURLStringErrorKey] as? String) ?? "",
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: detail),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript(
            "window.dispatchEvent(new CustomEvent('cn:navigation-failed', { detail: \(json) }))",
            completionHandler: nil
        )
    }
}

#if DEBUG
/// DIAGNOSTIC, Debug builds only (2026-09-24). Nort's spoken replies crackle in the app and play clean
/// in Safari on the same phone; the mic, the player and the Tap to Pay reader are ruled out. What is
/// left is the audio session the app's web view plays through, which the page cannot see. This prints
/// it to the console (read over the cable with `devicectl … --console`): once at start, on every route
/// change and interruption, and whenever any of it changes, checked twice a second.
final class AudioSessionProbe {
    static let shared = AudioSessionProbe()
    private var timer: Timer?
    private var last = ""

    func start() {
        guard timer == nil else { return }
        let center = NotificationCenter.default
        center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] note in
            let reason = (note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt) ?? 0
            self?.log("routeChange reason=\(reason)", force: true)
        }
        center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            let kind = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt) ?? 99
            self?.log("interruption type=\(kind)", force: true)
        }
        center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main) { [weak self] _ in
            self?.log("mediaServicesReset", force: true)
        }
        log("start", force: true)
        timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            self?.log("changed", force: false)
        }
    }

    private func snapshot() -> String {
        let session = AVAudioSession.sharedInstance()
        let outputs = session.currentRoute.outputs.map { $0.portType.rawValue }.joined(separator: ",")
        let inputs = session.currentRoute.inputs.map { $0.portType.rawValue }.joined(separator: ",")
        return "category=\(session.category.rawValue) mode=\(session.mode.rawValue) options=\(session.categoryOptions.rawValue) "
            + "rate=\(Int(session.sampleRate)) io=\(String(format: "%.4f", session.ioBufferDuration)) "
            + "out=[\(outputs)] in=[\(inputs)] outCh=\(session.outputNumberOfChannels) "
            + "otherAudio=\(session.isOtherAudioPlaying) outLatency=\(String(format: "%.4f", session.outputLatency))"
    }

    private func log(_ why: String, force: Bool) {
        let now = snapshot()
        guard force || now != last else { return }
        last = now
        print("[AudioProbe] \(why): \(now)")
    }
}
#endif
