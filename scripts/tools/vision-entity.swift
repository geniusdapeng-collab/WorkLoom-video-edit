// vision-entity.swift —— 实体级调色掩膜（macOS Vision；不联网、本地、可复现）
//
// 用法：vision-entity <image> <out-dir>
// 输出：out-dir/person.png（人物掩膜）、out-dir/food.png（食物掩膜，可能缺省）、faces.json，
//       并把一行 JSON 摘要写到 stdout：
//       {"personRatio":0.18,"faceCount":1,"foodRatio":0.22,"foodLabels":["soup"],...}
//
// 为什么需要它：镜头级调色只认"这一镜是什么"（美食镜 → 整帧暖黄），同镜的人像会被一起染黄。
// 实体级调色要先知道"人"和"食物"各自在画面里的位置，才能分别做美白 / 暖黄。
//   · 人物：VNGeneratePersonSegmentationRequest（人物分割掩膜）+ VNDetectFaceRectanglesRequest（人脸框）；
//   · 食物：VNGenerateForegroundInstanceMaskRequest（实例分割）逐实例裁剪 → VNClassifyImageRequest 分类，
//     命中食物词表才收进食物掩膜（避免把暖色桌面/木头当食物）；
//   · 兜底：实例分割不可用或全部实例都不像食物、但整帧分类明确是食物时，给一块居中的椭圆软掩膜
//     （俯拍碗盘占满画面的镜头很常见），并在 notes 里如实标注 fallback。
//
// 编译（首次自动，由 scripts/tools/edit-entity.mts / edit-post 负责）：
//   swiftc -O scripts/tools/vision-entity.swift -o ~/.workloom-edit/bin/vision-entity
import Foundation
import Vision
import CoreImage
import CoreVideo
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

struct Summary: Codable {
  let personRatio: Double
  let personSkinRatio: Double?
  let personInstances: Int
  let personRequest: String
  let faceCount: Int
  let foodRatio: Double
  let foodLabels: [String]
  let instanceCount: Int
  let width: Int
  let height: Int
  let personMask: Bool
  let foodMask: Bool
  let notes: [String]
}

func fail(_ message: String) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(1)
}

let args = CommandLine.arguments
guard args.count >= 3 else {
  FileHandle.standardError.write("usage: vision-entity <image> <out-dir>\n".data(using: .utf8)!)
  exit(2)
}
let imageURL = URL(fileURLWithPath: args[1])
let outDir = URL(fileURLWithPath: args[2])
try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
guard let source = CGImageSourceCreateWithURL(imageURL as CFURL, nil),
      let cgImage = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
  fail("无法读取图片：\(imageURL.path)")
}

let ciContext = CIContext(options: [.useSoftwareRenderer: false])
var notes: [String] = []

/**
 * 掩膜占比与包围盒。**按像素格式读取**：前景实例掩膜实测可能是
 * `kCVPixelFormatType_OneComponent32Float`（4 字节/像素），旧实现一律按 8-bit 单字节采样，
 * 会把 32-bit 缓冲读成乱码（实测同一张掩膜：缓冲算出 49%、真实 PNG 只有 4.9%）。
 * 采样步长按短边 /256，兼顾 4K 速度。
 */
func maskStats(_ buffer: CVPixelBuffer) -> (ratio: Double, bbox: CGRect) {
  CVPixelBufferLockBaseAddress(buffer, .readOnly)
  defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
  guard let base = CVPixelBufferGetBaseAddress(buffer) else { return (0, .zero) }
  let width = CVPixelBufferGetWidth(buffer)
  let height = CVPixelBufferGetHeight(buffer)
  let stride = CVPixelBufferGetBytesPerRow(buffer)
  let format = CVPixelBufferGetPixelFormatType(buffer)
  let step = max(1, min(width, height) / 256)
  var hits = 0
  var total = 0
  var minX = width, minY = height, maxX = -1, maxY = -1
  let bytes = base.assumingMemoryBound(to: UInt8.self)
  let isFloat = format == kCVPixelFormatType_OneComponent32Float
  let floats = base.assumingMemoryBound(to: Float32.self)
  var y = 0
  while y < height {
    var x = 0
    while x < width {
      let isOn: Bool
      if isFloat {
        let row = UnsafeRawPointer(base) + y * stride
        isOn = row.assumingMemoryBound(to: Float32.self)[x] >= 0.5
      } else {
        isOn = (bytes + y * stride)[x] >= 128
      }
      total += 1
      if isOn {
        hits += 1
        if x < minX { minX = x }
        if y < minY { minY = y }
        if x > maxX { maxX = x }
        if y > maxY { maxY = y }
      }
      x += step
    }
    y += step
  }
  guard hits > 0, maxX >= minX, maxY >= minY else { return (0, .zero) }
  let ratio = total > 0 ? Double(hits) / Double(total) : 0
  let bbox = CGRect(
    x: CGFloat(minX) / CGFloat(width),
    y: CGFloat(minY) / CGFloat(height),
    width: CGFloat(maxX - minX + 1) / CGFloat(width),
    height: CGFloat(maxY - minY + 1) / CGFloat(height)
  )
  return (ratio, bbox)
}

/** 从 CGImage 直接量掩膜覆盖率（与写出的 PNG 逐像素一致，口径统一）。 */
func coverage(of image: CGImage, threshold: UInt8 = 128) -> Double {
  let targetWidth = 256
  let targetHeight = max(1, Int((Double(targetWidth) * Double(image.height) / Double(max(1, image.width))).rounded()))
  guard let context = CGContext(
    data: nil, width: targetWidth, height: targetHeight, bitsPerComponent: 8,
    bytesPerRow: targetWidth, space: CGColorSpaceCreateDeviceGray(),
    bitmapInfo: CGImageAlphaInfo.none.rawValue
  ) else { return 0 }
  context.draw(image, in: CGRect(x: 0, y: 0, width: targetWidth, height: targetHeight))
  guard let pixels = context.data?.assumingMemoryBound(to: UInt8.self) else { return 0 }
  var hits = 0
  for index in 0..<(targetWidth * targetHeight) where pixels[index] >= threshold { hits += 1 }
  return Double(hits) / Double(targetWidth * targetHeight)
}

func cgImageFromMask(_ buffer: CVPixelBuffer, width: Int, height: Int) -> CGImage? {
  let ci = CIImage(cvPixelBuffer: buffer)
  let scaleX = CGFloat(width) / max(1, ci.extent.width)
  let scaleY = CGFloat(height) / max(1, ci.extent.height)
  let scaled = ci.transformed(by: CGAffineTransform(scaleX: scaleX, y: scaleY))
  return ciContext.createCGImage(scaled, from: CGRect(x: 0, y: 0, width: width, height: height))
}

func writePNG(_ image: CGImage, to url: URL) -> Bool {
  guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else { return false }
  CGImageDestinationAddImage(destination, image, nil)
  return CGImageDestinationFinalize(destination)
}

/**
 * 人物掩膜内的"肤色证据"占比（0–1）。
 * 为什么需要：人物分割请求偶尔会把前景里的盘子/桌面也当成"人"（俯拍食物镜实测），
 * 若直接拿它做美白，会把食物一起洗白。肤色占比 + 人脸框两个证据至少有一个才算真人物。
 * 用 YCbCr 经典肤色带（Cb 77–127 / Cr 133–173）在 256px 缩略图上采样，只作门控，不做精确测量。
 */
func skinRatioInMask(image: CGImage, mask: CVPixelBuffer?) -> Double? {
  guard let mask else { return nil }
  let targetWidth = 256
  let targetHeight = max(1, Int((Double(targetWidth) * Double(image.height) / Double(max(1, image.width))).rounded()))
  guard let context = CGContext(
    data: nil, width: targetWidth, height: targetHeight, bitsPerComponent: 8,
    bytesPerRow: targetWidth * 4, space: CGColorSpaceCreateDeviceRGB(),
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
  ) else { return nil }
  context.draw(image, in: CGRect(x: 0, y: 0, width: targetWidth, height: targetHeight))
  guard let pixels = context.data?.assumingMemoryBound(to: UInt8.self) else { return nil }

  CVPixelBufferLockBaseAddress(mask, .readOnly)
  defer { CVPixelBufferUnlockBaseAddress(mask, .readOnly) }
  guard let base = CVPixelBufferGetBaseAddress(mask) else { return nil }
  let maskWidth = CVPixelBufferGetWidth(mask)
  let maskHeight = CVPixelBufferGetHeight(mask)
  let stride = CVPixelBufferGetBytesPerRow(mask)
  let maskBytes = base.assumingMemoryBound(to: UInt8.self)
  var masked = 0
  var skin = 0
  for y in 0..<targetHeight {
    let maskY = min(maskHeight - 1, y * maskHeight / targetHeight)
    for x in 0..<targetWidth {
      let maskX = min(maskWidth - 1, x * maskWidth / targetWidth)
      guard maskBytes[maskY * stride + maskX] >= 128 else { continue }
      masked += 1
      let offset = (y * targetWidth + x) * 4
      let r = Double(pixels[offset])
      let g = Double(pixels[offset + 1])
      let b = Double(pixels[offset + 2])
      let luma = 0.299 * r + 0.587 * g + 0.114 * b
      let cb = -0.169 * r - 0.331 * g + 0.5 * b + 128
      let cr = 0.5 * r - 0.419 * g - 0.081 * b + 128
      if luma > 45 && cb >= 77 && cb <= 127 && cr >= 133 && cr <= 173 { skin += 1 }
    }
  }
  guard masked > 0 else { return 0 }
  return Double(skin) / Double(masked)
}

/** 椭圆软掩膜（兜底）：中心 74% × 74% 的椭圆，边缘高斯柔化。 */
func ellipseMask(width: Int, height: Int) -> CGImage? {
  guard let context = CGContext(
    data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width,
    space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue
  ) else { return nil }
  context.setFillColor(gray: 0, alpha: 1)
  context.fill(CGRect(x: 0, y: 0, width: width, height: height))
  context.setFillColor(gray: 0.92, alpha: 1)
  let insetX = CGFloat(width) * 0.13
  let insetY = CGFloat(height) * 0.13
  context.fillEllipse(in: CGRect(x: insetX, y: insetY, width: CGFloat(width) - insetX * 2, height: CGFloat(height) - insetY * 2))
  guard let raw = context.makeImage() else { return nil }
  let ci = CIImage(cgImage: raw).applyingGaussianBlur(sigma: Double(max(4, min(width, height) / 90)))
  return ciContext.createCGImage(ci, from: CGRect(x: 0, y: 0, width: width, height: height))
}

// ① 人物分割
var personRatio = 0.0
var personMaskWritten = false
var personSkinRatio: Double? = nil
var personInstances = 0
var personRequest = "none"
/**
 * 先用"人物**实例**分割"（macOS 14+）：它只在画面里真有人物实例时给掩膜。
 * 实测（2026-10-11 俯拍食物镜）：旧的通用人物分割会把盘子/桌面误判成"人"（掩膜占比 63%），
 * 而人物实例分割在同一帧直接无结果——这是"人像美白不能洗到食物上"的关键门控。
 */
if #available(macOS 14.0, *) {
  let request = VNGeneratePersonInstanceMaskRequest()
  do {
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    try handler.perform([request])
    if let observation = request.results?.first, !observation.allInstances.isEmpty {
      personInstances = observation.allInstances.count
      personRequest = "instance"
      if let union = try? observation.generateScaledMaskForImage(forInstances: observation.allInstances, from: handler) {
        if let mask = cgImageFromMask(union, width: cgImage.width, height: cgImage.height) {
          personRatio = coverage(of: mask)
          personSkinRatio = skinRatioInMask(image: cgImage, mask: union)
          personMaskWritten = writePNG(mask, to: outDir.appendingPathComponent("person.png"))
        }
      }
    }
  } catch {
    notes.append("人物实例分割失败：\(error.localizedDescription)")
  }
}
if personRequest == "none", #available(macOS 12.0, *) {
  /** 兜底：通用人物分割（实例分割不可用时）；调用侧需结合人脸/肤色证据再决定是否美白。 */
  let request = VNGeneratePersonSegmentationRequest()
  request.qualityLevel = .balanced
  request.outputPixelFormat = kCVPixelFormatType_OneComponent8
  do {
    try VNImageRequestHandler(cgImage: cgImage, options: [:]).perform([request])
    if let observation = request.results?.first {
      personRequest = "segmentation"
      if let mask = cgImageFromMask(observation.pixelBuffer, width: cgImage.width, height: cgImage.height) {
        personRatio = coverage(of: mask)
        personSkinRatio = skinRatioInMask(image: cgImage, mask: observation.pixelBuffer)
        personMaskWritten = writePNG(mask, to: outDir.appendingPathComponent("person.png"))
      }
    } else {
      notes.append("人物分割：无结果")
    }
  } catch {
    notes.append("人物分割失败：\(error.localizedDescription)")
  }
} else if personRequest == "none" {
  notes.append("人物实例分割不可用且系统低于 macOS 12：无人物掩膜")
}

// ② 人脸框（Vision 坐标原点在左下 → 转成左上原点的归一化框）
var faces: [CGRect] = []
do {
  let request = VNDetectFaceRectanglesRequest()
  try VNImageRequestHandler(cgImage: cgImage, options: [:]).perform([request])
  faces = (request.results ?? []).map { observation in
    let box = observation.boundingBox
    return CGRect(
      x: min(max(0, box.origin.x), 1),
      y: min(max(0, 1 - box.origin.y - box.height), 1),
      width: min(max(0, box.width), 1),
      height: min(max(0, box.height), 1)
    )
  }
} catch {
  notes.append("人脸检测失败：\(error.localizedDescription)")
}
let faceJSON = (try? JSONSerialization.data(
  withJSONObject: faces.map { ["x": Double($0.origin.x), "y": Double($0.origin.y), "w": Double($0.width), "h": Double($0.height)] },
  options: [.sortedKeys]
)) ?? Data()
try? faceJSON.write(to: outDir.appendingPathComponent("faces.json"))

// ③ 食物实例：逐实例裁剪分类，命中词表才收
let FOOD_HINTS: [String] = [
  "food", "dish", "meal", "cuisine", "dessert", "snack", "breakfast", "lunch", "dinner", "banquet",
  "noodle", "soup", "broth", "stew", "hotpot", "dumpling", "rice", "bun", "bread", "pasta", "porridge",
  "meat", "beef", "pork", "chicken", "lamb", "fish", "seafood", "shrimp", "egg",
  "vegetable", "fruit", "apple", "salad", "cake", "pastry", "pizza", "burger", "sushi", "barbecue",
  "食物", "美食", "汤", "面", "饭", "肉", "鱼", "水果", "甜点", "小吃", "火锅", "饺子", "包子", "烧烤", "菜",
]

func isFoodLabel(_ label: String) -> Bool {
  let normalized = label.lowercased()
  if normalized.isEmpty { return false }
  let words = normalized.split(whereSeparator: { !$0.isLetter && !$0.isNumber }).map(String.init)
  for hint in FOOD_HINTS {
    if hint.unicodeScalars.contains(where: { $0.value > 0x2E80 }) {
      if normalized.contains(hint) { return true }
      continue
    }
    for word in words where word.count >= 3 || hint.count <= word.count {
      if word == hint { return true }
      if hint.count >= 4 && word.hasPrefix(hint) { return true }
      if word.count >= 4 && hint.hasPrefix(word) { return true }
    }
  }
  return false
}

func classify(_ image: CGImage) -> [String] {
  let request = VNClassifyImageRequest()
  do {
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
    return (request.results ?? [])
      .filter { $0.confidence >= 0.12 }
      .map { $0.identifier }
  } catch {
    notes.append("整帧/实例分类失败：\(error.localizedDescription)")
    return []
  }
}

func crop(_ image: CGImage, normalized: CGRect) -> CGImage? {
  let width = CGFloat(image.width)
  let height = CGFloat(image.height)
  let rect = CGRect(
    x: max(0, normalized.origin.x * width),
    y: max(0, normalized.origin.y * height),
    width: max(2, normalized.width * width),
    height: max(2, normalized.height * height)
  ).intersection(CGRect(x: 0, y: 0, width: width, height: height))
  guard rect.width >= 8, rect.height >= 8 else { return nil }
  return image.cropping(to: rect)
}

/** 把若干归一化矩形画成一张全尺寸软掩膜（白=作用区，边缘高斯柔化）。 */
func cellMask(width: Int, height: Int, cells: [CGRect]) -> CGImage? {
  guard !cells.isEmpty else { return nil }
  guard let context = CGContext(
    data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width,
    space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue
  ) else { return nil }
  context.setFillColor(gray: 0, alpha: 1)
  context.fill(CGRect(x: 0, y: 0, width: width, height: height))
  context.setFillColor(gray: 0.95, alpha: 1)
  for cell in cells {
    context.fill(CGRect(
      x: cell.origin.x * CGFloat(width),
      y: cell.origin.y * CGFloat(height),
      width: cell.width * CGFloat(width),
      height: cell.height * CGFloat(height)
    ))
  }
  guard let raw = context.makeImage() else { return nil }
  let ci = CIImage(cgImage: raw).applyingGaussianBlur(sigma: Double(max(3, min(width, height) / 140)))
  return ciContext.createCGImage(ci, from: CGRect(x: 0, y: 0, width: width, height: height))
}

var foodRatio = 0.0
var foodLabels: [String] = []
var instanceCount = 0
var foodMaskWritten = false
if #available(macOS 14.0, *) {
  let request = VNGenerateForegroundInstanceMaskRequest()
  do {
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    try handler.perform([request])
    if let observation = request.results?.first {
      instanceCount = observation.allInstances.count
      /** 不是"整实例收/不收"，而是把实例框切成 3×3 单元逐个分类：
       *  桌面+盘子常被切成同一个实例，整实例分类会命中 food，直接把整张桌子暖掉（实测 94.8%）。
       *  逐单元分类只保留真正像菜的格子，暖色才会落在盘子里。 */
      var foodCells: [CGRect] = []
      var acceptedInstances = IndexSet()
      var oversizedInstanceRatio = 0.0
      for index in observation.allInstances {
        guard let buffer = try? observation.generateScaledMaskForImage(forInstances: IndexSet(integer: index), from: handler) else { continue }
        let stats = maskStats(buffer)
        guard stats.ratio >= 0.002, let whole = crop(cgImage, normalized: stats.bbox) else { continue }
        let instanceHits = classify(whole).filter(isFoodLabel)
        guard !instanceHits.isEmpty else { continue }
        let box = stats.bbox
        var cellsForInstance: [CGRect] = []
        for row in 0..<3 {
          for column in 0..<3 {
            let cell = CGRect(
              x: box.origin.x + box.width * CGFloat(column) / 3,
              y: box.origin.y + box.height * CGFloat(row) / 3,
              width: box.width / 3,
              height: box.height / 3
            )
            guard let cropped = crop(cgImage, normalized: cell) else { continue }
            if classify(cropped).contains(where: isFoodLabel) { cellsForInstance.append(cell) }
          }
        }
        if !cellsForInstance.isEmpty {
          foodCells.append(contentsOf: cellsForInstance)
          foodLabels.append(contentsOf: instanceHits.prefix(2))
        } else if stats.ratio <= 0.5 {
          /** 整实例分类是食物、但细分格子都没命中（俯拍大碗常见）→ 收整实例掩膜。 */
          acceptedInstances.insert(index)
          foodLabels.append(contentsOf: instanceHits.prefix(3))
        } else {
          /** 实例过大（多半把桌面/台面一起框进来了）→ 不直接收，交给椭圆兜底。 */
          oversizedInstanceRatio = max(oversizedInstanceRatio, stats.ratio)
        }
      }
      if !foodCells.isEmpty, let mask = cellMask(width: cgImage.width, height: cgImage.height, cells: foodCells),
         writePNG(mask, to: outDir.appendingPathComponent("food.png")) {
        foodMaskWritten = true
        foodRatio = min(1, foodCells.reduce(0.0) { total, cell in total + Double(cell.width * cell.height) })
      } else if !acceptedInstances.isEmpty,
                let union = try? observation.generateScaledMaskForImage(forInstances: acceptedInstances, from: handler),
                let mask = cgImageFromMask(union, width: cgImage.width, height: cgImage.height),
                writePNG(mask, to: outDir.appendingPathComponent("food.png")) {
        foodMaskWritten = true
        foodRatio = coverage(of: mask)
      } else if oversizedInstanceRatio > 0 {
        notes.append("食物实例占比 \(Int(oversizedInstanceRatio * 100))% 过大（疑似把桌面一起框入），不直接使用实例掩膜")
      }
    } else {
      notes.append("实例分割：无结果")
    }
  } catch {
    notes.append("实例分割失败：\(error.localizedDescription)")
  }
} else {
  notes.append("系统版本低于 macOS 14，实例分割不可用")
}

/**
 * 兜底词表：只有"做好的菜/主食"类标签才允许用椭圆兜底。
 * 反例（实测）：果园镜头整帧分类会给出 food/fruit——那是树上的苹果，不是"该暖黄的菜"，
 * 给它整片暖色只会污染画面，所以水果/生鲜不触发兜底。
 */
let FALLBACK_DISH_HINTS: [String] = [
  "dish", "meal", "cuisine", "soup", "broth", "stew", "hotpot", "noodle", "rice", "porridge",
  "dumpling", "barbecue", "dessert", "breakfast", "lunch", "dinner", "banquet", "pizza", "burger", "sushi",
  "菜", "汤", "面", "饭", "火锅", "饺子", "包子", "烧烤", "小吃", "甜点",
]

func isFallbackDishLabel(_ label: String) -> Bool {
  let normalized = label.lowercased()
  for hint in FALLBACK_DISH_HINTS where normalized.contains(hint) { return true }
  return false
}

// ④ 兜底：实例层没找到食物，但整帧分类命中"做好的菜" → 居中椭圆软掩膜（俯拍碗盘常见）
if !foodMaskWritten {
  let labels = classify(cgImage)
  let hits = labels.filter(isFoodLabel)
  let dishHits = labels.filter(isFallbackDishLabel)
  if !hits.isEmpty && !dishHits.isEmpty {
    foodLabels.append(contentsOf: hits.prefix(3))
    if let mask = ellipseMask(width: cgImage.width, height: cgImage.height),
       writePNG(mask, to: outDir.appendingPathComponent("food.png")) {
      foodMaskWritten = true
      foodRatio = 0.42
      notes.append("实例分割未命中食物实例；整帧分类命中菜品 \(dishHits.prefix(3).joined(separator: "/"))，改用居中椭圆软掩膜（fallback）")
    }
  } else if !hits.isEmpty {
    notes.append("整帧分类命中非菜品食物标签（\(hits.prefix(3).joined(separator: "/"))）：不触发食物暖色（水果/生鲜不算暖黄目标）")
  }
}

let summary = Summary(
  personRatio: (personRatio * 1000).rounded() / 1000,
  personSkinRatio: personSkinRatio.map { ($0 * 1000).rounded() / 1000 },
  personInstances: personInstances,
  personRequest: personRequest,
  faceCount: faces.count,
  foodRatio: (foodRatio * 1000).rounded() / 1000,
  foodLabels: Array(Set(foodLabels)).sorted().prefix(6).map { $0 },
  instanceCount: instanceCount,
  width: cgImage.width,
  height: cgImage.height,
  personMask: personMaskWritten,
  foodMask: foodMaskWritten,
  notes: notes
)
let encoder = JSONEncoder()
encoder.outputFormatting = [.sortedKeys]
if let data = try? encoder.encode(summary), let text = String(data: data, encoding: .utf8) {
  print(text)
} else {
  print("{}")
}
