// chew-airplay — plays a video through macOS's own AirPlay stack (AVFoundation), so the Apple TV
// is driven exactly like QuickTime or Safari would drive it. Chew Player starts this helper and
// talks to it with one JSON object per line:
//
//   stdin  ← {"cmd":"load","url":"…","start":12.5,"title":"…","subtitle":"…","artwork":"/path.jpg","device":"Heimkino"}
//            {"cmd":"play"} {"cmd":"pause"} {"cmd":"seek","t":42} {"cmd":"pick"} {"cmd":"stop"}
//   stdout → {"ev":"ready"}
//            {"ev":"status","state":"choosing|buffering|playing|paused","position":…,"duration":…,"external":true}
//            {"ev":"ended"} {"ev":"closed"} {"ev":"error","message":"…"}

import AppKit
import AVFoundation
import AVKit
import MediaPlayer

func emit(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj), var line = String(data: data, encoding: .utf8) else { return }
    line += "\n"
    FileHandle.standardOutput.write(line.data(using: .utf8)!)
}

final class Helper: NSObject, NSApplicationDelegate, NSWindowDelegate {
    let player = AVPlayer()
    var window: NSWindow!
    var picker = AVRoutePickerView()
    var titleLabel = NSTextField(labelWithString: "")
    var hintLabel = NSTextField(labelWithString: "")
    var startAt: Double = 0
    var started = false
    var nowPlaying: [String: Any] = [:]
    var fallbackURL: URL?
    var beganAt: Date?
    var everPlayed = false
    var observers: [NSKeyValueObservation] = []
    var timer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        player.allowsExternalPlayback = true

        let content = NSView(frame: NSRect(x: 0, y: 0, width: 360, height: 190))
        titleLabel.font = .boldSystemFont(ofSize: 15)
        titleLabel.lineBreakMode = .byTruncatingTail
        hintLabel.textColor = .secondaryLabelColor
        hintLabel.maximumNumberOfLines = 3
        hintLabel.preferredMaxLayoutWidth = 320
        picker.player = player
        picker.isRoutePickerButtonBordered = false
        picker.setRoutePickerButtonColor(NSColor(red: 1, green: 0.31, blue: 0.48, alpha: 1), for: .normal)
        picker.setRoutePickerButtonColor(NSColor(red: 1, green: 0.31, blue: 0.48, alpha: 1), for: .active)
        let button = NSButton(title: "Cancel", target: self, action: #selector(cancel))
        let stack = NSStackView(views: [picker, titleLabel, hintLabel, button])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: content.centerYAnchor),
            stack.widthAnchor.constraint(lessThanOrEqualTo: content.widthAnchor, constant: -32),
            picker.widthAnchor.constraint(equalToConstant: 56),
            picker.heightAnchor.constraint(equalToConstant: 56),
        ])

        window = NSWindow(contentRect: content.frame, styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Chew Player — AirPlay"
        window.contentView = content
        window.delegate = self
        window.isReleasedWhenClosed = false
        window.level = .floating

        observers.append(player.observe(\.isExternalPlaybackActive, options: [.new]) { [weak self] _, _ in
            DispatchQueue.main.async { self?.externalChanged() }
        })
        NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: nil, queue: .main) { _ in emit(["ev": "ended"]) }
        NotificationCenter.default.addObserver(forName: .AVPlayerItemFailedToPlayToEndTime, object: nil, queue: .main) { [weak self] n in
            let err = (n.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? Error)?.localizedDescription ?? "Playback failed"
            if self?.useFallback(reason: err) == true { return }
            emit(["ev": "error", "message": err])
        }
        timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in self?.report() }
        setupRemoteCommands()

        DispatchQueue.global().async {
            while let line = readLine() {
                guard let data = line.data(using: .utf8),
                      let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
                DispatchQueue.main.async { self.handle(obj) }
            }
            DispatchQueue.main.async { NSApp.terminate(nil) } // Chew Player went away
        }
        emit(["ev": "ready"])
    }

    func handle(_ msg: [String: Any]) {
        switch msg["cmd"] as? String {
        case "load":
            guard let s = msg["url"] as? String, let url = s.hasPrefix("/") ? URL(fileURLWithPath: s) : URL(string: s) else {
                emit(["ev": "error", "message": "Invalid URL"]); return
            }
            startAt = (msg["start"] as? Double) ?? 0
            started = false
            // Local files are handed over like QuickTime does; the fallback is the other form.
            fallbackURL = (msg["fallback"] as? String).flatMap { $0.hasPrefix("/") ? URL(fileURLWithPath: $0) : URL(string: $0) }
            player.pause()
            player.replaceCurrentItem(with: AVPlayerItem(url: url))
            titleLabel.stringValue = (msg["title"] as? String) ?? "Chew Player"
            lastPublished = nil
            setNowPlaying(title: msg["title"] as? String, subtitle: msg["subtitle"] as? String, artwork: msg["artwork"] as? String)
            let device = (msg["device"] as? String).map { "“\($0)”" } ?? "your Apple TV"
            hintLabel.stringValue = "Choose \(device) in the AirPlay menu."
            if player.isExternalPlaybackActive { begin() } else { showPicker() }
        case "play": player.play()
        case "pause": player.pause()
        case "seek":
            let t = (msg["t"] as? Double) ?? 0
            player.seek(to: CMTime(seconds: t, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
        case "pick": showPicker()
        case "stop":
            player.pause()
            player.replaceCurrentItem(with: nil)
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            MPNowPlayingInfoCenter.default().playbackState = .stopped
            NSApp.terminate(nil)
        default: break
        }
    }

    func showPicker() {
        NSApp.activate(ignoringOtherApps: true)
        window.center()
        window.makeKeyAndOrderFront(nil)
        // Open the system AirPlay menu right away instead of making the user find the button.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
            if let button = Self.findButton(in: self.picker) { button.performClick(nil) }
        }
    }

    static func findButton(in view: NSView) -> NSButton? {
        for sub in view.subviews {
            if let b = sub as? NSButton { return b }
            if let b = findButton(in: sub) { return b }
        }
        return nil
    }

    // Only start once the video goes to the TV, so it never plays on the Mac by accident.
    func externalChanged() {
        if player.isExternalPlaybackActive {
            begin()
        } else if started {
            player.pause()
            emit(["ev": "closed"]) // the TV was disconnected
        }
        report()
    }

    func begin() {
        guard !started, player.currentItem != nil else { return }
        started = true
        beganAt = Date()
        everPlayed = false
        window.orderOut(nil)
        player.seek(to: CMTime(seconds: startAt, preferredTimescale: 600)) { _ in self.player.play() }
    }

    // The Apple TV (and the Mac's Now Playing menu) show what's in the Now Playing center.
    func setNowPlaying(title: String?, subtitle: String?, artwork: String?) {
        var info: [String: Any] = [MPMediaItemPropertyTitle: title ?? "Chew Player", MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.video.rawValue]
        if let subtitle, !subtitle.isEmpty { info[MPMediaItemPropertyArtist] = subtitle }
        if let artwork, let image = NSImage(contentsOfFile: artwork) {
            info[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
        }
        nowPlaying = info
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    // Only call this when something changes (start, pause, seek): with AirPlay, every Now Playing
    // update is synced to the Apple TV, and updating the position continuously makes the picture
    // stutter. Between updates the system extrapolates the position from the playback rate.
    var lastPublished: (playing: Bool, position: Double, duration: Double)?

    func updateNowPlaying(position: Double, duration: Double, playing: Bool) {
        guard !nowPlaying.isEmpty else { return }
        if let last = lastPublished {
            let expected = last.position + (playing && last.playing ? 0.5 : 0)
            if last.playing == playing && abs(position - expected) < 2.0 && last.duration == duration {
                lastPublished = (playing, position, duration)
                return
            }
        }
        lastPublished = (playing, position, duration)
        nowPlaying[MPNowPlayingInfoPropertyElapsedPlaybackTime] = position
        nowPlaying[MPNowPlayingInfoPropertyPlaybackRate] = playing ? 1.0 : 0.0
        if duration > 0 { nowPlaying[MPMediaItemPropertyPlaybackDuration] = duration }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nowPlaying
        MPNowPlayingInfoCenter.default().playbackState = playing ? .playing : .paused
    }

    // Play/pause/seek from the Apple TV remote or the Mac's media keys.
    func setupRemoteCommands() {
        let c = MPRemoteCommandCenter.shared()
        c.playCommand.addTarget { [weak self] _ in self?.player.play(); return .success }
        c.pauseCommand.addTarget { [weak self] _ in self?.player.pause(); return .success }
        c.togglePlayPauseCommand.addTarget { [weak self] _ in
            guard let p = self?.player else { return .commandFailed }
            if p.timeControlStatus == .paused { p.play() } else { p.pause() }
            return .success
        }
        c.changePlaybackPositionCommand.addTarget { [weak self] e in
            guard let e = e as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            self?.player.seek(to: CMTime(seconds: e.positionTime, preferredTimescale: 600))
            return .success
        }
        c.nextTrackCommand.addTarget { _ in emit(["ev": "next"]); return .success }
    }

    func report() {
        let item = player.currentItem
        var state = "choosing"
        if player.isExternalPlaybackActive && started {
            switch player.timeControlStatus {
            case .playing: state = "playing"
            case .waitingToPlayAtSpecifiedRate: state = "buffering"
            default: state = "paused"
            }
        }
        if let err = item?.error, !useFallback(reason: err.localizedDescription) { emit(["ev": "error", "message": err.localizedDescription]) }
        let pos = player.currentTime().seconds
        let dur = item?.duration.seconds ?? 0
        if started { updateNowPlaying(position: pos.isFinite ? pos : 0, duration: dur.isFinite ? dur : 0, playing: state == "playing") }
        if state == "playing" { everPlayed = true }
        // The TV may hang without an error when it can't reach the network URL.
        if started, !everPlayed, let t = beganAt, Date().timeIntervalSince(t) > 20, useFallback(reason: "no picture after 20 s") { beganAt = Date() }
        emit(["ev": "status", "state": state, "position": pos.isFinite ? pos : 0, "duration": dur.isFinite ? dur : 0, "external": player.isExternalPlaybackActive])
    }

    // Switch to the local file once if the network URL can't be played.
    func useFallback(reason: String) -> Bool {
        guard let url = fallbackURL else { return false }
        fallbackURL = nil
        emit(["ev": "log", "message": "\(reason) — switching to \(url.isFileURL ? "the local file" : "the network stream")"])
        let at = player.currentTime().seconds
        player.replaceCurrentItem(with: AVPlayerItem(url: url))
        player.seek(to: CMTime(seconds: at.isFinite && at > 0 ? at : startAt, preferredTimescale: 600)) { _ in
            if self.started { self.player.play() }
        }
        return true
    }

    @objc func cancel() {
        emit(["ev": "closed"])
        NSApp.terminate(nil)
    }

    func windowWillClose(_ notification: Notification) {
        if !started { emit(["ev": "closed"]); NSApp.terminate(nil) }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let helper = Helper()
app.delegate = helper
app.run()
