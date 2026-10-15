import AVFoundation
import Capacitor

/// NORT WITH THE SCREEN OFF (field feedback 10-13, item 4; Erik's open reports ee83df75 + 36e7a88b
/// since 09-24: "Nort dies at screen lock").
///
/// iOS suspends the WebView's JavaScript the moment the screen locks, and with it Nort's whole
/// voice loop (getUserMedia → /api/transcribe → /api/tts). The one thing that keeps a third-party
/// app running in the background is a REAL audio session that is actually playing or recording,
/// declared in Info.plist (UIBackgroundModes: audio). The WebView's own capture does not count as
/// the app's — so this plugin keeps one flowing natively: the shared session made active, and a
/// silent player looping for as long as the conversation lasts. While it is on, the process stays
/// alive and the page's loop keeps its mic, its fetches and its speaker.
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
    private var player: AVAudioPlayerNode?
    private var heartbeat: Timer?
    private var on = false
    private var startedAt: Date?
    private var observers: [NSObjectProtocol] = []
    /// How many times the silent player was brought back after an interruption (the tick says).
    private var revived = 0

    deinit { stop() }

    public override func load() {
        // WEBKIT'S CAPTURE INTERRUPTS US. The moment the page opens the mic, iOS hands the session to
        // the WebView's capture (an interruption BEGINS for everything else, including this engine,
        // which stops); when that settles the interruption ENDS and nothing restarts an AVAudioEngine
        // by itself. Build 2 held nothing after the first turn (bridge-1014b.log: interruption 1 → 0
        // right after keepAlive on). So: on every end, and on a media-services reset, bring the
        // silent player back while a conversation is live.
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            guard let self, self.on else { return }
            let kind = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt) ?? 99
            if kind == AVAudioSession.InterruptionType.ended.rawValue { self.revive("interruption ended") }
        })
        observers.append(center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self, self.on else { return }
            self.revive("media services reset")
        })
    }

    /// Bring the silent player back if it fell silent. Harmless when it is already playing.
    private func revive(_ why: String) {
        guard on else { return }
        if let engine, engine.isRunning, let player, player.isPlaying { return }
        do {
            try AVAudioSession.sharedInstance().setActive(true, options: [])
            if let engine, !engine.isRunning { try engine.start() }
            player?.play()
            revived += 1
            print("[NortAudio] revived (\(why)) #\(revived): \(snapshot())")
        } catch {
            print("[NortAudio] revive failed (\(why)): \(error)")
        }
    }

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
            "playing": (engine?.isRunning ?? false) && (player?.isPlaying ?? false),
            "revived": revived,
            "category": session.category.rawValue,
            "mode": session.mode.rawValue,
            "seconds": startedAt.map { Int(Date().timeIntervalSince($0)) } ?? 0,
            "background": UIApplication.shared.applicationState != .active,
        ]
    }

    private func start() throws {
        if on { return }
        // NEVER THE CATEGORY. The first build set .playAndRecord/.voiceChat here, and WebKit then
        // refused the page's own getUserMedia with "AudioSession category is not compatible with
        // audio capture" (error_events e55a8290, 2026-10-14 22:23): WebKit manages the category
        // itself (navigator.audioSession.type) and must not find it taken. What this holds is
        // only an ACTIVE session with audio flowing — a silent player — which is what the audio
        // background mode keeps a process alive for. The mic stays the WebView's.
        let session = AVAudioSession.sharedInstance()
        try session.setActive(true, options: [])
        let engine = AVAudioEngine()
        let player = AVAudioPlayerNode()
        engine.attach(player)
        let format = engine.mainMixerNode.outputFormat(forBus: 0)
        engine.connect(player, to: engine.mainMixerNode, format: format)
        engine.mainMixerNode.outputVolume = 0
        engine.prepare()
        try engine.start()
        // One second of silence, looped: audio is "playing" for as long as the conversation lasts.
        if let silence = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(format.sampleRate)) {
            silence.frameLength = silence.frameCapacity
            player.scheduleBuffer(silence, at: nil, options: [.loops], completionHandler: nil)
            player.play()
        }
        self.engine = engine
        self.player = player
        on = true
        startedAt = Date()
        heartbeat = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            guard let self, self.on else { return }
            self.revive("tick") // an engine that fell over between notifications comes back here
            self.notifyListeners("tick", data: self.snapshot())
        }
        print("[NortAudio] keepAlive on: \(snapshot())")
    }

    private func stop() {
        heartbeat?.invalidate()
        heartbeat = nil
        on = false
        player?.stop()
        engine?.stop()
        player = nil
        engine = nil
        startedAt = nil
        revived = 0
        // The category is WebKit's to leave as it likes; nothing is handed back here.
        print("[NortAudio] keepAlive off")
    }
}
