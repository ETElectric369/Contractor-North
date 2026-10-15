import AVFoundation
import Capacitor

/// NORT WITH THE SCREEN OFF (field feedback 10-13, item 4; Erik's open reports ee83df75 + 36e7a88b
/// since 09-24: "Nort dies at screen lock").
///
/// iOS suspends the WebView's JavaScript the moment the screen locks, and with it Nort's whole
/// voice loop (getUserMedia → /api/transcribe → /api/tts). The one thing that keeps a third-party
/// app running in the background is a REAL audio session that is actually playing or recording,
/// declared in Info.plist (UIBackgroundModes: audio). The WebView's own capture does not count as
/// the app's — so this plugin opens one natively: a play-and-record session and an engine with a
/// live input tap that records to nowhere. While it is on, the process stays alive and the page's
/// loop keeps its mic, its fetches and its speaker.
///
/// THE SPIKE QUESTION this file exists to answer on Erik's phone (the plan in memory): with the
/// process alive, does the WebView's OWN capture keep running past the lock? The page logs a
/// heartbeat from `tick` so the bridge log over the cable says whether JavaScript ran while the
/// screen was dark. If capture dies but the page lives, the next rung records here and hands the
/// bytes to the page; if the page dies too, the design changes. Nothing is guessed in advance.
///
/// ONLY WHILE A CONVERSATION IS LIVE. voice-stream.ts turns it on at startListening and off at
/// stopListening; a hard stop (the red Stop Nort) ends it. No network from here, ever: the page
/// owns the session cookie and every request (the agent security framework).
@objc(NortAudioPlugin)
public class NortAudioPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NortAudioPlugin"
    public let jsName = "NortAudio"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "keepAlive", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "state", returnType: CAPPluginReturnPromise),
    ]

    private var engine: AVAudioEngine?
    private var heartbeat: Timer?
    private var on = false
    private var startedAt: Date?

    deinit { stop() }

    @objc func keepAlive(_ call: CAPPluginCall) {
        let want = call.getBool("on") ?? false
        DispatchQueue.main.async { [weak self] in
            guard let self else { return call.reject("gone") }
            if want {
                do {
                    try self.start()
                    call.resolve(self.snapshot())
                } catch {
                    call.reject("audio session: \(error.localizedDescription)")
                }
            } else {
                self.stop()
                call.resolve(self.snapshot())
            }
        }
    }

    @objc func state(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in call.resolve(self?.snapshot() ?? [:]) }
    }

    private func snapshot() -> [String: Any] {
        let session = AVAudioSession.sharedInstance()
        return [
            "on": on,
            "category": session.category.rawValue,
            "mode": session.mode.rawValue,
            "seconds": startedAt.map { Int(Date().timeIntervalSince($0)) } ?? 0,
            "background": UIApplication.shared.applicationState != .active,
        ]
    }

    private func start() throws {
        if on { return }
        let session = AVAudioSession.sharedInstance()
        // Voice chat mode: echo cancellation on the speaker, so Nort's own reply does not come
        // back in as the next answer. Bluetooth for a truck's hands-free; the speaker by default.
        try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth, .defaultToSpeaker])
        try session.setActive(true, options: [])
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        // A live tap IS the recording iOS keeps the app alive for. Its buffers go nowhere (the page
        // records through the WebView today; the spike says whether that must change).
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { _, _ in }
        engine.prepare()
        try engine.start()
        self.engine = engine
        on = true
        startedAt = Date()
        heartbeat = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            guard let self, self.on else { return }
            self.notifyListeners("tick", data: self.snapshot())
        }
        print("[NortAudio] keepAlive on: \(snapshot())")
    }

    private func stop() {
        heartbeat?.invalidate()
        heartbeat = nil
        if let engine {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
        engine = nil
        on = false
        startedAt = nil
        // Back to the shell's shareable playback session (NorthBridgeViewController.shareTheSpeaker).
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, options: [.mixWithOthers])
        } catch {
            print("[NortAudio] could not hand the session back: \(error)")
        }
        print("[NortAudio] keepAlive off")
    }
}
