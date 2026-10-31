#!/usr/bin/env node
/** Local postprocessing utility: preserve source bytes, normalize actual streams, emit a real MP4. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export class PostProductionPipeline {
  constructor(projectConfig = {}) {
    this.config = { outputRatio: '16:9', outputWidth: 1280, outputHeight: 720, fps: 30, ...projectConfig };
    this.sourcePaths = new Map();
  }
  fingerprint(file) {
    const before = fs.statSync(file), realpath = fs.realpathSync(file);
    if (!before.isFile() || before.size <= 0) throw new Error(`POST_SOURCE_FILE_REQUIRED: ${file}`);
    const bytes = fs.readFileSync(file), after = fs.statSync(file);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size
      || fs.realpathSync(file) !== realpath) throw new Error(`POST_SOURCE_CHANGED_DURING_READ: ${file}`);
    return { path: path.resolve(file), realpath, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  probe(file) {
    const data = JSON.parse(execFileSync(process.env.WL_FFPROBE || 'ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file],
      { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 }));
    const video = data.streams?.find(stream => stream.codec_type === 'video');
    const duration = Number(data.format?.duration);
    if (!video || !(duration > 0)) throw new Error(`POST_SOURCE_MEDIA_UNREADABLE: ${file}`);
    return { duration, width: Number(video.width), height: Number(video.height), hasAudio: data.streams.some(stream => stream.codec_type === 'audio') };
  }
  async produce(shots, options = {}) {
    const { shotsDir, finalDir, title = '成片', titleConfig } = options;
    if (!Array.isArray(shots) || !shots.length || typeof shotsDir !== 'string' || typeof finalDir !== 'string') throw new Error('POST_SOURCE_REGISTRY_REQUIRED');
    if (typeof title !== 'string' || !title.trim() || /[\/\\\x00-\x1f]/.test(title) || title.includes('..')) throw new Error('POST_OUTPUT_TITLE_INVALID');
    const seen = new Set();
    this.sourcePaths.clear();
    const sources = shots.map(shot => {
      if (typeof shot?.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(shot.id)
        || shot.id.includes('..') || seen.has(shot.id)) throw new Error('POST_SHOT_ID_INVALID');
      seen.add(shot.id);
      // Supplied provider facts must remain truthful; local file-only processing does not invent them.
      if (shot.error || shot.providerFailed === true || (shot.providerStatus !== undefined && shot.providerStatus !== 'succeeded')) throw new Error(`POST_PROVIDER_FAILED: ${shot.id}`);
      const file = path.resolve(shotsDir, `${shot.id}.mp4`);
      this.sourcePaths.set(shot.id, file);
      return { shotId: shot.id, ...this.fingerprint(file) };
    });
    const durations = this.measureActualDurations(shots, shotsDir);
    fs.mkdirSync(finalDir, { recursive: true });
    const temporaryDir = fs.mkdtempSync(path.join(path.resolve(finalDir), '.post-source-'));
    try {
      if (titleConfig?.mainTitle) this.burnTitleOverlay(shots, shotsDir, titleConfig, temporaryDir);
      const output = path.join(path.resolve(finalDir), `${title}.mp4`);
      if (sources.some(source => source.path === output)) throw new Error('POST_OUTPUT_OVERWRITES_SOURCE');
      const candidate = path.join(path.resolve(finalDir), `.${title}.${randomUUID()}.pending.mp4`);
      this.mergeAndConvert(shots, shotsDir, candidate);
      for (const source of sources) if (this.fingerprint(source.path).sha256 !== source.sha256) throw new Error(`POST_SOURCE_CHANGED_DURING_PROCESS: ${source.shotId}`);
      this.probe(candidate);
      if (fs.existsSync(output)) fs.renameSync(output, `${output}.previous-${randomUUID()}`);
      fs.renameSync(candidate, output);
      return { ...this.generateReport(output, shots, durations), sourceAuthority: 'local-file-bytes', sourceReceipts: sources,
        qualityReviewed: false, qualityScore: null, originalAudioPreserved: true };
    } finally { fs.rmSync(temporaryDir, { recursive: true, force: true }); }
  }
  measureActualDurations(shots, shotsDir) {
    return shots.map(shot => {
      const file = this.sourcePaths.get(shot.id) || path.resolve(shotsDir, `${shot.id}.mp4`);
      const actual = this.probe(file);
      return { shotId: shot.id, expectedDuration: shot.duration ?? null, actualDuration: actual.duration, hasVideo: true, hasAudio: actual.hasAudio };
    });
  }
  burnTitleOverlay(shots, shotsDir, titleConfig, outputDir) {
    const opening = shots.find(shot => shot.id === 'S00' || shot.type === 'opening' || shot.isOpening === true);
    if (!opening || !titleConfig.mainTitle) return;
    const source = this.sourcePaths.get(opening.id) || path.resolve(shotsDir, `${opening.id}.mp4`);
    const targetDir = outputDir || path.join(path.resolve(shotsDir), '.post-titles');
    fs.mkdirSync(targetDir, { recursive: true });
    const font = this.config.titleFont || process.env.WL_FONT_FILE;
    if (!font || !fs.existsSync(font)) throw new Error('POST_TITLE_FONT_REQUIRED');
    const escape = value => String(value).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "'\\''");
    const layers = [[titleConfig.mainTitle, 48, 'white', 'h*0.22'], [titleConfig.subTitle, 28, 'white', 'h*0.32'],
      [titleConfig.producer, 36, '0xFFD700', 'h*0.82']].filter(([text]) => Boolean(text));
    const filters = layers.map(([text, size, color, y], index) => {
      const textFile = path.join(targetDir, `${opening.id}-title-${index}.txt`);
      fs.writeFileSync(textFile, String(text));
      return `drawtext=textfile='${escape(textFile)}':expansion=none:fontsize=${size}:fontcolor=${color}:fontfile='${escape(font)}':x=(w-text_w)/2:y=${y}:box=1:boxcolor=black@0.6:boxborderw=12`;
    });
    const target = path.join(targetDir, `${opening.id}.titled.mp4`);
    execFileSync(process.env.WL_FFMPEG || 'ffmpeg', ['-y', '-i', source, '-vf', filters.join(','), '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-c:a', 'copy', target],
      { encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
    this.probe(target);
    this.sourcePaths.set(opening.id, target);
  }
  mergeAndConvert(shots, shotsDir, outputPath) {
    const clips = shots.map(shot => this.sourcePaths.get(shot.id) || path.resolve(shotsDir, `${shot.id}.mp4`));
    if (!clips.length) throw new Error('POST_SOURCE_REGISTRY_REQUIRED');
    clips.forEach(file => this.probe(file));
    const composer = path.resolve(MODULE_DIR, '../../../scripts/tools/compose-film.mts');
    execFileSync(process.execPath, ['--import', 'tsx', composer, '--clips', clips.join(','), '--out', outputPath,
      '--width', String(this.config.outputWidth), '--height', String(this.config.outputHeight), '--fps', String(this.config.fps), '--fade', '0', '--color', 'none'],
      { encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024 });
  }
  generateReport(cleanPath, shots, durations) {
    const output = this.fingerprint(cleanPath), media = this.probe(cleanPath);
    if (media.width !== Number(this.config.outputWidth) || media.height !== Number(this.config.outputHeight)) throw new Error('POST_EXPORT_CANVAS_MISMATCH');
    return { success: true, artifactKind: 'rendered-media', cleanFile: cleanPath, cleanSize: output.bytes, sha256: output.sha256,
      duration: media.duration, resolution: `${media.width}x${media.height}`, shots: durations, subtitleGenerated: false };
  }
}
