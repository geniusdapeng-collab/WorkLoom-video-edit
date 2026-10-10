// vision-ocr.swift —— 离线画面文字提取（macOS Vision 框架；不联网、不花钱、可复现）
//
// 用法：vision-ocr <video> <fps> [--min-confidence 0.4]
// 输出：JSONL 到 stdout，每行 {"t": 秒, "texts": ["..."]}（只输出识别到文字的采样点）
//
// 为什么进仓：招牌、包装、横幅、店名、字幕是剪辑与文案的事实来源，也是"这条素材是什么地方/什么店"的硬证据。
// 纯靠多模态模型读字不可复算、会漏；OCR 把"看得见的字"变成可检索字段（契约 probe.onScreenText → shots[].content.onScreenText）。
// 编译（首次自动，由 scripts/tools/edit-probe.mts 负责）：swiftc -O scripts/tools/vision-ocr.swift -o ~/.workloom-edit/bin/vision-ocr
import Foundation
import AVFoundation
import Vision

let args = CommandLine.arguments
guard args.count >= 3, let fps = Double(args[2]), fps > 0 else {
    FileHandle.standardError.write("usage: vision-ocr <video> <fps> [--min-confidence 0.4]\n".data(using: .utf8)!)
    exit(2)
}
let input = URL(fileURLWithPath: args[1])
let minConfidence: Float = {
    if let index = args.firstIndex(of: "--min-confidence"), index + 1 < args.count, let value = Float(args[index + 1]) {
        return value
    }
    return 0.4
}()

let asset = AVURLAsset(url: input)
let generator = AVAssetImageGenerator(asset: asset)
generator.appliesPreferredTrackTransform = true
generator.requestedTimeToleranceBefore = CMTime(seconds: 0.1, preferredTimescale: 600)
generator.requestedTimeToleranceAfter = CMTime(seconds: 0.1, preferredTimescale: 600)
generator.maximumSize = CGSize(width: 1600, height: 1600)

var durationSeconds = 0.0
let durationSemaphore = DispatchSemaphore(value: 0)
asset.loadValuesAsynchronously(forKeys: ["duration"]) {
    durationSeconds = asset.duration.seconds
    durationSemaphore.signal()
}
durationSemaphore.wait()
guard durationSeconds.isFinite, durationSeconds > 0 else {
    FileHandle.standardError.write("无法读取视频时长\n".data(using: .utf8)!)
    exit(1)
}

var emitted = 0
var t = 0.0
while t < durationSeconds {
    let time = CMTime(seconds: t, preferredTimescale: 600)
    guard let cgImage = try? generator.copyCGImage(at: time, actualTime: nil) else {
        t += 1.0 / fps
        continue
    }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["zh-Hans", "en-US"]
    request.usesLanguageCorrection = true
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    try? handler.perform([request])
    let texts = (request.results ?? []).compactMap { observation -> String? in
        guard let candidate = observation.topCandidates(1).first, candidate.confidence >= minConfidence else { return nil }
        let value = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }
    if !texts.isEmpty {
        let row: [String: Any] = ["t": (t * 1000).rounded() / 1000, "texts": texts]
        if let data = try? JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]),
           let line = String(data: data, encoding: .utf8) {
            print(line)
            emitted += 1
        }
    }
    t += 1.0 / fps
}
FileHandle.standardError.write("OCR 完成：\(Int(durationSeconds))s / 命中 \(emitted) 个采样点\n".data(using: .utf8)!)
