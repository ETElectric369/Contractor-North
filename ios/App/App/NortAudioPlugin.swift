import AVFoundation
import Capacitor
import UIKit

/// NORT WITH THE SCREEN OFF — NATIVE CAPTURE (field feedback 10-13, item 4; plan C, 2026-10-14).
///
/// The spike on Erik's phone settled the design (bridge-1014b/c.log): with a real audio session held,
/// the page's JavaScript and its spoken replies run with the screen dark, but WebKit's own microphone
/// does not — a getUserMedia made while locked hangs, and a capture that was open delivers silence
/// while hidden. So the mic lives here. Each turn is recorded natively (an AVAudioEngine input tap →
/// one AAC file per turn), the end of the turn is found by the SAME silence rule the page uses
/// (voice-stream.ts; a test pins the numbers to each other), and the bytes go to the page as a `turn`
/// event. The page keeps everything else: it POSTs the audio to /api/transcribe with its own session
/// cookie, talks to the model, and plays the reply through its <audio> element (proven to play dark).
/// NO NETWORK FROM HERE, EVER (the agent security framework).
///
/// THE SESSION IS OURS FOR THE CONVERSATION. The first build set .playAndRecord beside WebKit's own
/// capture and WebKit refused its mic ("AudioSession category is not compatible with audio capture").
/// Now WebKit never captures in the shell — voice-stream declares its session plain playback for the
/// whole conversation — so the category is this plugin's: play-and-record, routed to the speaker,
/// MIXABLE so the page's playback is never cut off (shareTheSpeaker's lesson). At stop it goes back to
/// what shareTheSpeaker declared at launch.
///
/// A RECORDING KEEPS THE APP ALIVE. UIBackgroundModes audio keeps a process running only while its
/// session is actually recording or playing. The input tap runs for the whole conversation — through
/// Nort's replies too (muted: the end-of-turn rule pauses) — so the lock never suspends the loop.
/// WebKit's playback interrupts this engine when a reply starts (the spike saw it): every interruption
/// end, route change and media-services reset brings the engine back, a turn that was listening is
/// re-armed, and the page is told (`interrupted`). An engine is never started on a changed input
/// format (that is an NSException, not an error): it is rebuilt.
@objc(NortAudioPlugin)
public class NortAudioPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NortAudioPlugin"
    public let jsName = "NortAudio"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listen", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "endTurn", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "mute", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "wake", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "state", returnType: CAPPluginReturnPromise),
    ]

    // ── THE SAME RULE AS THE PAGE (voice-stream.ts) ──────────────────────────────────────────
    // tests/field-1014-native-capture.test.ts reads both files and fails when a pair drifts.
    private let speakMinGate: Float = 0.012 // never call anything quieter than this "speech"
    private let quietMinGate: Float = 0.008 // …and never count anything louder as a pause on a silent floor
    private let floorCap: Float = 0.04 // the floor may not learn a shout as "the room"
    private let floorLearnMs = 250.0 // the opening window that seeds the floor
    private let pauseMs = 2400.0 // this much quiet after speech = the end of the utterance
    private let turnCapMs = 45000.0 // never a single turn forever
    private let noSpeechCapMs = 9000.0 // give up a turn with no speech at all
    private let smoothSeconds = 0.055 // the level's time constant (the page: 0.3 per frame at ~60 Hz)
    private let floorClimbPerSecond: Float = 0.18 // how fast the floor follows a louder room (0.003 × 60)
    private let levelEveryMs = 120.0 // the meter's cadence, foreground only
    /// THE PAGE SLEEPS BETWEEN TICKS (the 01:25 trace, 2026-10-15). iOS suspends WebKit's page
    /// process while the screen is dark unless its own audio is playing; a native call into the page
    /// — this heartbeat, delivered to the page's `tick` listener — runs it. Every stage of a dark turn
    /// (transcribe done, chat answered, playback started) landed right after a tick, five seconds
    /// apart, which is the "substantially longer delay while locked" Erik heard. Build 5 ticked
    /// every 0.5 s whenever the screen was dark, and twice the reply's voice FADED a few seconds
    /// after it started (01:49, 01:50) — which never happened at 5 s (01:25, three dark replies).
    /// So the fast tick is only for the stretch that needs waking: from the turn's end until the
    /// reply starts to play (transcribe, chat). The page says when (`wake`); playback and listening
    /// run at the slow tick that is proven clean. The page's listener is load-bearing: without it
    /// nothing is delivered.
    private let tickSlow = 5.0
    private let tickFast = 0.5
    private var fastWake = false
    /// THE LEVELS QUESTION (skeptic #7, unverified off the phone). The page's gates were tuned against
    /// WebKit's gain-controlled capture; this tap is raw. If build 4's `turn` facts (peak/floor/gate in
    /// the bridge log and the no-speech reports) show speech under the gate, flip this and rebuild:
    /// Apple's voice processing gives the input AGC, noise suppression and echo cancellation. Other
    /// audio (the page's reply) is ducked as little as iOS allows.
    private let voiceProcessing = false

    /// One turn's recording and its end-of-turn state. Written by the tap thread under `lock`.
    private final class Turn {
        let url: URL
        var file: AVAudioFile? // nil = closed (an AVAudioFile flushes when released)
        let startedAt = Date()
        var spoke = false
        var silenceStart: Date?
        var smooth: Float = 0
        var floor: Float = 0
        var peak: Float = 0
        var gate: Float = 0
        var frames: AVAudioFramePosition = 0
        var ending = false
        init(url: URL, file: AVAudioFile) {
            self.url = url
            self.file = file
        }
    }

    private enum Fault: LocalizedError {
        case noInput
        case notStarted
        var errorDescription: String? {
            switch self {
            case .noInput: return "no microphone input on this route"
            case .notStarted: return "the conversation has not started"
            }
        }
    }

    private var engine: AVAudioEngine?
    private var format: AVAudioFormat?
    private var on = false // a conversation is live: the session held, the tap installed
    private var startedAt: Date?
    private var heartbeat: Timer?
    private var observers: [NSObjectProtocol] = []
    private var revived = 0
    private var turns = 0
    /// A turn was listening when an interruption began: the page is told at the resume so it re-arms.
    private var hadTurn = false
    /// listen() was asked while the engine was down (a reply still held the session): started at the revive.
    private var pendingListen = false
    private let lock = NSLock()
    private var turn: Turn?
    private var muted = false
    private var foreground = true
    private var levelAt = Date.distantPast

    deinit { teardown() }

    public override func load() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            guard let self, self.on else { return }
            let kind = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt) ?? 99
            if kind == AVAudioSession.InterruptionType.began.rawValue {
                self.interruptionBegan()
            } else if kind == AVAudioSession.InterruptionType.ended.rawValue {
                self.revive("interruption ended")
            }
        })
        observers.append(center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self, self.on else { return }
            self.interruptionBegan()
            self.rebuild("media services reset")
        })
        observers.append(center.addObserver(forName: .AVAudioEngineConfigurationChange, object: nil, queue: .main) { [weak self] note in
            guard let self, self.on, let engine = self.engine, (note.object as? AVAudioEngine) === engine else { return }
            self.interruptionBegan()
            self.rebuild("configuration change")
        })
        // UIApplication.applicationState is a main-thread value; the tap thread reads this copy.
        observers.append(center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            self?.setForeground(true)
        })
        observers.append(center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            self?.setForeground(false)
        })
    }

    private func setForeground(_ f: Bool) {
        lock.lock()
        foreground = f
        lock.unlock()
        if on { scheduleHeartbeat() } // the cadence follows the screen
    }

    private func scheduleHeartbeat() {
        heartbeat?.invalidate()
        lock.lock()
        let interval = (foreground || !fastWake) ? tickSlow : tickFast
        lock.unlock()
        heartbeat = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            guard let self, self.on else { return }
            // Capacitor drops every listener when the page navigates or its process dies. Nobody
            // would hear a turn, so nothing may keep recording: the mic goes off within seconds.
            if !self.hasListeners("turn") {
                print("[NortAudio] the page let go: stopping")
                self.teardown()
                return
            }
            self.revive("tick") // an engine that fell over between notifications comes back here
            self.notifyListeners("tick", data: self.snapshot())
        }
    }

    // ── The page's doors ─────────────────────────────────────────────────────────────────────

    /// Open the conversation: the mic permission (iOS asks once), the session, the engine.
    @objc func start(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return call.reject("gone") }
            self.requestPermission { granted in
                guard granted else { return call.reject("Microphone access is off for North.", "denied") }
                do {
                    try self.begin()
                    call.resolve(self.snapshot())
                } catch {
                    self.teardown()
                    call.reject("audio: \(error.localizedDescription)", "session")
                }
            }
        }
    }

    /// Begin a turn. Listening is listening: a second call while one is live changes nothing. When the
    /// engine is down (a reply's playback still holds the session), the turn starts at the next revive.
    @objc func listen(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return call.reject("gone") }
            guard self.on else { return call.reject(Fault.notStarted.localizedDescription, "off") }
            if !(self.engine?.isRunning ?? false) {
                self.hadTurn = false // the page is starting a turn itself: no re-arm to ask for
                self.revive("listen", tell: false)
            }
            guard self.engine?.isRunning ?? false else {
                self.pendingListen = true
                call.resolve(["listening": false, "pending": true])
                return
            }
            do {
                try self.openTurn()
                call.resolve(["listening": true])
            } catch {
                call.reject("recording: \(error.localizedDescription)", "file")
            }
        }
    }

    /// End the turn by hand ("I'm done talking"): whatever it has ships as `manual`.
    @objc func endTurn(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.finish(why: "manual")
            call.resolve()
        }
    }

    /// Drop the turn: nothing of it goes anywhere.
    @objc func cancel(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.dropTurn()
            call.resolve()
        }
    }

    /// The page is working on a turn (transcribe, chat) and needs waking between its stages while
    /// the screen is dark: `fast: true` from the turn's end, `false` once the reply plays.
    @objc func wake(_ call: CAPPluginCall) {
        let fast = call.getBool("fast") ?? false
        DispatchQueue.main.async { [weak self] in
            guard let self else { return call.reject("gone") }
            if self.fastWake != fast {
                self.fastWake = fast
                if self.on { self.scheduleHeartbeat() }
            }
            call.resolve()
        }
    }

    /// Nort is speaking: the end-of-turn rule pauses (the recording itself keeps the app alive).
    @objc func mute(_ call: CAPPluginCall) {
        let want = call.getBool("on") ?? false
        DispatchQueue.main.async { [weak self] in
            guard let self else { return call.reject("gone") }
            self.lock.lock()
            self.muted = want
            self.lock.unlock()
            call.resolve()
        }
    }

    /// End the conversation. `ship: true` (the mic tapped off by hand) sends the live turn first;
    /// the red Stop drops it.
    @objc func stop(_ call: CAPPluginCall) {
        let ship = call.getBool("ship") ?? false
        DispatchQueue.main.async { [weak self] in
            guard let self else { return call.reject("gone") }
            if ship { self.finish(why: "manual") } else { self.dropTurn() }
            self.teardown()
            call.resolve(self.snapshot())
        }
    }

    @objc func state(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in call.resolve(self?.snapshot() ?? [:]) }
    }

    // ── The session and the engine ───────────────────────────────────────────────────────────

    private func requestPermission(_ done: @escaping (Bool) -> Void) {
        if #available(iOS 17.0, *) {
            switch AVAudioApplication.shared.recordPermission {
            case .granted: return done(true)
            case .denied: return done(false)
            default:
                AVAudioApplication.requestRecordPermission { ok in DispatchQueue.main.async { done(ok) } }
            }
        } else {
            let session = AVAudioSession.sharedInstance()
            switch session.recordPermission {
            case .granted: return done(true)
            case .denied: return done(false)
            default:
                session.requestRecordPermission { ok in DispatchQueue.main.async { done(ok) } }
            }
        }
    }

    private func claimSession() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP, .mixWithOthers])
        try session.setActive(true, options: [])
    }

    private func begin() throws {
        if on {
            // The page came back (a reload, a WebContent restart) to a plugin still running: it must
            // find it as a fresh start would — nothing muted, no turn half-open, nothing pending.
            dropTurn()
            lock.lock()
            muted = false
            lock.unlock()
            pendingListen = false
            hadTurn = false
            print("[NortAudio] start: adopted a running session")
            return
        }
        sweepTurnFiles()
        try claimSession()
        try buildEngine()
        on = true
        startedAt = Date()
        turns = 0
        scheduleHeartbeat()
        print("[NortAudio] start: \(snapshot())")
    }

    private func buildEngine() throws {
        let engine = AVAudioEngine()
        let input = engine.inputNode
        if voiceProcessing {
            try input.setVoiceProcessingEnabled(true)
            if #available(iOS 17.0, *) {
                input.voiceProcessingOtherAudioDuckingConfiguration = AVAudioVoiceProcessingOtherAudioDuckingConfiguration(enableAdvancedDucking: false, duckingLevel: .min)
            }
        }
        let format = input.outputFormat(forBus: 0) // read AFTER voice processing: it changes the rate
        guard format.sampleRate > 0, format.channelCount > 0 else { throw Fault.noInput }
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            self?.consume(buffer)
        }
        engine.prepare()
        try engine.start()
        self.engine = engine
        self.format = format
        print("[NortAudio] engine: \(Int(format.sampleRate)) Hz × \(format.channelCount) ch, \(format.commonFormat.rawValue)/\(format.isInterleaved ? "interleaved" : "planar")")
    }

    private func sweepTurnFiles() {
        let dir = FileManager.default.temporaryDirectory
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else { return }
        for n in names where n.hasPrefix("nort-turn-") && n.hasSuffix(".m4a") {
            try? FileManager.default.removeItem(at: dir.appendingPathComponent(n))
        }
    }

    private func dropEngine() {
        if let engine {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
        engine = nil
        format = nil
    }

    /// The engine stopped (an interruption, a route change, a reset): a turn that was listening is
    /// dead, so it is dropped here and the page re-arms one at the resume.
    private func interruptionBegan() {
        lock.lock()
        let live = turn != nil
        lock.unlock()
        if live {
            dropTurn()
            hadTurn = true
        }
        print("[NortAudio] interrupted (turn live: \(live))")
    }

    /// Bring the engine back if it stopped. Harmless when it is running. A changed input format means
    /// a rebuild, never a restart.
    private func revive(_ why: String, tell: Bool = true) {
        guard on else { return }
        if let engine, engine.isRunning {
            // Nothing to restart — but a turn an interruption dropped (hadTurn) is still news the
            // page has not heard when the engine came back by itself.
            startPendingTurn()
            if tell, hadTurn { resumed(why) }
            return
        }
        if let engine, let format, engine.inputNode.outputFormat(forBus: 0) != format {
            rebuild("\(why), input format changed")
            return
        }
        do {
            try claimSession()
            if let engine { try engine.start() } else { try buildEngine() }
            revived += 1
            print("[NortAudio] revived (\(why)) #\(revived)")
            if tell { resumed(why) } else { startPendingTurn() }
        } catch {
            print("[NortAudio] revive failed (\(why)): \(error)")
        }
    }

    private func rebuild(_ why: String) {
        guard on else { return }
        dropEngine()
        do {
            try claimSession()
            try buildEngine()
            revived += 1
            print("[NortAudio] rebuilt (\(why)) #\(revived)")
            resumed(why)
        } catch {
            print("[NortAudio] rebuild failed (\(why)): \(error)") // the 5 s tick tries again
        }
    }

    private func resumed(_ why: String) {
        startPendingTurn()
        lock.lock()
        let listening = turn != nil
        lock.unlock()
        notifyListeners("interrupted", data: ["resumed": true, "hadTurn": hadTurn, "listening": listening, "why": why])
        hadTurn = false
    }

    private func startPendingTurn() {
        guard pendingListen else { return }
        pendingListen = false
        do {
            try openTurn()
        } catch {
            print("[NortAudio] pending turn failed: \(error)")
        }
    }

    // ── Turns ────────────────────────────────────────────────────────────────────────────────

    private func openTurn() throws {
        lock.lock()
        defer { lock.unlock() }
        if turn != nil { return } // listening is listening
        guard let format else { throw Fault.noInput }
        turns += 1
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("nort-turn-\(turns)-\(Int(Date().timeIntervalSince1970)).m4a")
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: format.sampleRate,
            AVNumberOfChannelsKey: format.channelCount,
            AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
        ]
        let file = try AVAudioFile(forWriting: url, settings: settings, commonFormat: format.commonFormat, interleaved: format.isInterleaved)
        turn = Turn(url: url, file: file)
    }

    /// Every buffer from the mic, on the tap's own thread: written to the turn's file and measured
    /// against the end-of-turn rule. Nothing here touches UIKit or the bridge directly.
    private func consume(_ buffer: AVAudioPCMBuffer) {
        lock.lock()
        guard let t = turn, !t.ending else {
            lock.unlock()
            return
        }
        let rms = Self.rms(of: buffer)
        let now = Date()
        let dt = Double(buffer.frameLength) / max(1, buffer.format.sampleRate)
        let alpha = Float(1 - exp(-dt / smoothSeconds))
        t.smooth += (rms - t.smooth) * alpha
        if t.smooth > t.peak { t.peak = t.smooth }
        let elapsed = now.timeIntervalSince(t.startedAt) * 1000
        // Learn the room: the opening window seeds the floor (capped), then it falls fast to any
        // quieter reading and climbs only slowly — a truck idling up is learned in seconds; a
        // spoken sentence barely nudges it.
        if elapsed < floorLearnMs { t.floor = min(floorCap, max(t.floor, t.smooth)) }
        else if t.smooth < t.floor { t.floor = t.smooth }
        else { t.floor = min(floorCap, t.floor + (t.smooth - t.floor) * min(1, floorClimbPerSecond * Float(dt))) }
        let speakGate = max(speakMinGate, t.floor * 2.2 + 0.006)
        let quietGate = max(quietMinGate, t.floor * 1.5 + 0.003)
        t.gate = speakGate
        if let file = t.file {
            do {
                try file.write(from: buffer)
                t.frames += AVAudioFramePosition(buffer.frameLength)
            } catch {
                print("[NortAudio] write failed: \(error)")
            }
        }
        var end: String?
        if muted {
            t.silenceStart = nil
        } else if t.smooth > speakGate {
            t.spoke = true
            t.silenceStart = nil
        } else if t.spoke, t.smooth < quietGate {
            if let since = t.silenceStart {
                if now.timeIntervalSince(since) * 1000 > pauseMs { end = "pause" }
            } else {
                t.silenceStart = now
            }
        }
        // (between the gates: neither a word nor a pause — the running silence window stands.)
        if end == nil, elapsed > turnCapMs || (!t.spoke && elapsed > noSpeechCapMs) {
            end = t.spoke ? "cap" : "no-speech"
        }
        if let why = end {
            t.ending = true
            lock.unlock()
            DispatchQueue.main.async { [weak self] in self?.finish(why: why, only: t) }
            return
        }
        // The meter, while the screen is on: the page shows the level, "Hearing you…", "Still listening".
        if foreground, now.timeIntervalSince(levelAt) * 1000 > levelEveryMs {
            levelAt = now
            let data: [String: Any] = ["rms": Double(t.smooth), "spoke": t.spoke, "elapsedMs": Int(elapsed)]
            lock.unlock()
            DispatchQueue.main.async { [weak self] in self?.notifyListeners("level", data: data) }
            return
        }
        lock.unlock()
    }

    private static func rms(of buffer: AVAudioPCMBuffer) -> Float {
        let n = Int(buffer.frameLength)
        guard n > 0 else { return 0 }
        if let ch = buffer.floatChannelData {
            var sum: Float = 0
            let p = ch[0]
            for i in 0..<n { sum += p[i] * p[i] }
            return (sum / Float(n)).squareRoot()
        }
        if let ch = buffer.int16ChannelData {
            var sum: Float = 0
            let p = ch[0]
            for i in 0..<n {
                let v = Float(p[i]) / 32768
                sum += v * v
            }
            return (sum / Float(n)).squareRoot()
        }
        return 0
    }

    /// Close the turn and hand it to the page. A no-speech turn carries no audio (nothing is uploaded
    /// from a locked phone for silence); a manual end carries whatever it has.
    private func finish(why: String, only: Turn? = nil) {
        lock.lock()
        guard let t = turn, only == nil || t === only else {
            lock.unlock()
            return // the turn that ended is already gone (an interruption dropped it); a newer one stands
        }
        turn = nil
        lock.unlock()
        t.file = nil // flushes the file
        var data: [String: Any] = [
            "why": why,
            "seconds": Int(Date().timeIntervalSince(t.startedAt)),
            "peak": Double(t.peak),
            "floor": Double(t.floor),
            "gate": Double(t.gate),
            "spoke": t.spoke,
            "bytes": 0,
            "turn": turns,
        ]
        if why != "no-speech", t.frames > 0, let bytes = try? Data(contentsOf: t.url), !bytes.isEmpty {
            data["bytes"] = bytes.count
            data["audio"] = bytes.base64EncodedString()
            data["mime"] = "audio/mp4"
        }
        try? FileManager.default.removeItem(at: t.url)
        print("[NortAudio] turn #\(turns) \(why): \(data["bytes"] ?? 0) bytes, \(data["seconds"] ?? 0) s, peak \(t.peak) floor \(t.floor) gate \(t.gate)")
        notifyListeners("turn", data: data)
    }

    private func dropTurn() {
        lock.lock()
        let t = turn
        turn = nil
        lock.unlock()
        guard let t else { return }
        t.file = nil
        try? FileManager.default.removeItem(at: t.url)
    }

    private func teardown() {
        heartbeat?.invalidate()
        heartbeat = nil
        on = false
        pendingListen = false
        hadTurn = false
        fastWake = false
        dropTurn()
        dropEngine()
        lock.lock()
        muted = false
        lock.unlock()
        startedAt = nil
        revived = 0
        // Back to what shareTheSpeaker declared at launch: the page's playback, mixable.
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
        try? session.setActive(false, options: [.notifyOthersOnDeactivation])
        print("[NortAudio] stop")
    }

    private func snapshot() -> [String: Any] {
        let session = AVAudioSession.sharedInstance()
        lock.lock()
        let listening = turn != nil
        let isMuted = muted
        lock.unlock()
        return [
            "on": on,
            "running": engine?.isRunning ?? false,
            "listening": listening,
            "muted": isMuted,
            "revived": revived,
            "turns": turns,
            "category": session.category.rawValue,
            "mode": session.mode.rawValue,
            "rate": format.map { Int($0.sampleRate) } ?? 0,
            "seconds": startedAt.map { Int(Date().timeIntervalSince($0)) } ?? 0,
            "background": UIApplication.shared.applicationState != .active,
        ]
    }
}
