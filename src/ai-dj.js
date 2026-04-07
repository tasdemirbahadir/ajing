require("dotenv").config();

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const MusicTempo = require("music-tempo");
const ora = require("ora");

const args = new Set(process.argv.slice(2));

const CONFIG = {
  playlistUrl: process.env.PLAYLIST_URL || "",
  playlistFetchMode: (process.env.PLAYLIST_FETCH_MODE || "auto").trim().toLowerCase(),
  ytdlpBin: process.env.YTDLP_BIN || "yt-dlp",
  ffmpegBin: process.env.FFMPEG_BIN || "ffmpeg",
  ffprobeBin: process.env.FFPROBE_BIN || "ffprobe",
  ffplayBin: process.env.FFPLAY_BIN || "ffplay",
  cookiesFromBrowser: process.env.YTDLP_COOKIES_FROM_BROWSER || "",
  cookiesFile: process.env.YTDLP_COOKIES_FILE || "",
  useCookiesForDownload: parseBoolean(process.env.YTDLP_USE_COOKIES_FOR_DOWNLOAD, false),
  googleClientId: process.env.GOOGLE_CLIENT_ID || "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
  googleRefreshToken: process.env.GOOGLE_REFRESH_TOKEN || "",
  googlePlaylistId: process.env.GOOGLE_PLAYLIST_ID || "",
  cacheDir: resolveFromRoot(process.env.CACHE_DIR || ".cache"),
  stateFile: resolveFromRoot(process.env.STATE_FILE || ".cache/dj-state.json"),
  outputFile: resolveFromRoot(process.env.OUTPUT_FILE || ".cache/output/ai-dj-mix.wav"),
  sessionFile: resolveFromRoot(process.env.DJ_SESSION_FILE || ".cache/output/ai-dj-session.json"),
  bpmSampleSeconds: parseInteger(process.env.BPM_SAMPLE_SECONDS, 300),
  tempoMatchPoolSize: parseInteger(process.env.TEMPO_MATCH_POOL_SIZE, 1),
  maxTempoShiftPercent: parseNumber(process.env.MAX_TEMPO_SHIFT_PERCENT, 12),
  minTransitionSeconds: parseNumber(process.env.MIN_TRANSITION_SECONDS, 40),
  maxTransitionSeconds: parseNumber(process.env.MAX_TRANSITION_SECONDS, 88),
  playAudio: parseBoolean(process.env.PLAY_AUDIO, true),
  markPlayedWhenNotPlaying: parseBoolean(process.env.MARK_PLAYED_WHEN_NOT_PLAYING, true),
  cleanTempAfterRun: parseBoolean(process.env.CLEAN_TEMP_AFTER_RUN, false),
  autoResetOnStart: parseBoolean(process.env.AUTO_RESET_ON_START, false),
  disableSpinners: parseBoolean(process.env.DISABLE_SPINNERS, false),
};

// ─── Transition catalogue ────────────────────────────────────────────────
// Each entry defines a named DJ-style crossfade style.
// All styles use the same bass-first EQ-swap engine (no volume fades ever).
// The only things that vary are: total duration, bass/high split point,
// and how staggered the band swaps are.
// Real DJs swap the **bass** first (first 60%), then the **highs** (last 60%)
// with a 20% overlap. That is the default used here.

const TRANSITIONS = [
  {
    // Standard club-style EQ swap — bass out first, highs follow.
    name: "Club EQ Swap",
    baseSeconds: 48,
  },
  {
    // Quick energy transition — tighter overlap, shorter.
    name: "Quick Drop",
    baseSeconds: 40,
  },
  {
    // Long slow blend for ambient/melodic material.
    name: "Slow Blend",
    baseSeconds: 88,
  },
];
// (Kept as an array so future styles can be added without changing logic.)
// Legacy objects below are no longer used — replaced by the unified EQ-swap engine.
const _LEGACY_UNUSED = [
  {
    name: "Velvet Fade",
    baseSeconds: 12,
    c1: "qsin",
    c2: "qsin",
    outFx: "lowpass=f=10000",
    inFx: "highpass=f=70",
  },
  {
    name: "Club Lift",
    baseSeconds: 14,
    c1: "exp",
    c2: "hsin",
    outFx: "highpass=f=180,bass=g=-3:f=120",
    inFx: "bass=g=5:f=110",
  },
  {
    name: "Air Sweep",
    baseSeconds: 10,
    c1: "hsin",
    c2: "esin",
    outFx: "treble=g=-4:f=6500",
    inFx: "treble=g=6:f=7000",
  },
  {
    name: "Echo Mist",
    baseSeconds: 14,
    c1: "tri",
    c2: "exp",
    outFx: "aecho=0.7:0.75:45:0.2",
    inFx: "aecho=0.6:0.7:35:0.15",
  },
  {
    name: "Radio Tunnel",
    baseSeconds: 12,
    c1: "log",
    c2: "qsin",
    outFx: "lowpass=f=3200,highpass=f=220",
    inFx: "lowpass=f=3800,highpass=f=200",
  },
  {
    name: "Warm Bloom",
    baseSeconds: 14,
    c1: "par",
    c2: "cub",
    outFx: "bass=g=4:f=115,treble=g=-2:f=7000",
    inFx: "bass=g=6:f=120",
  },
  {
    name: "Tight Pump",
    baseSeconds: 10,
    c1: "exp",
    c2: "exp",
    outFx: "acompressor=threshold=-20dB:ratio=3:attack=10:release=140",
    inFx: "acompressor=threshold=-19dB:ratio=2.8:attack=8:release=120",
  },
  {
    name: "Crystal Blend",
    baseSeconds: 12,
    c1: "qua",
    c2: "qua",
    outFx: "treble=g=3:f=7800",
    inFx: "highpass=f=100,treble=g=4:f=8200",
  },
  {
    name: "Bass Relay",
    baseSeconds: 14,
    c1: "cbr",
    c2: "qsin",
    outFx: "highpass=f=200",
    inFx: "bass=g=7:f=105",
  },
  {
    name: "Sunset Drift",
    baseSeconds: 16,
    c1: "tri",
    c2: "hsin",
    outFx: "aecho=0.55:0.7:60:0.2,lowpass=f=7200",
    inFx: "highpass=f=80,lowpass=f=12000",
  },
  {
    name: "Clean Arc",
    baseSeconds: 10,
    c1: "squ",
    c2: "cub",
    outFx: "volume=0.98",
    inFx: "volume=1.02",
  },
  {
    name: "Neon Glide",
    baseSeconds: 14,
    c1: "ipar",
    c2: "exp",
    outFx: "lowpass=f=8500,treble=g=-2:f=7000",
    inFx: "aecho=0.5:0.65:40:0.12,treble=g=3:f=7600",
  },
];

async function main() {
  validateConfig();
  const playlistFetchMode = resolvePlaylistFetchMode();

  const shouldReset = args.has("--reset") || CONFIG.autoResetOnStart;
  const statusOnly = args.has("--status");

  await ensureDir(path.dirname(CONFIG.stateFile));
  await ensureDir(CONFIG.cacheDir);
  await ensureDir(path.dirname(CONFIG.outputFile));
  await ensureDir(path.dirname(CONFIG.sessionFile));

  const audioDir = path.join(CONFIG.cacheDir, "audio");
  const workDir = path.join(CONFIG.cacheDir, "work");
  await ensureDir(audioDir);
  await ensureDir(workDir);
  await ensureDir(path.join(workDir, "adjusted"));
  await ensureDir(path.join(workDir, "mix"));

  await verifyDependencies();

  const fetchSpinner = startSpinner(`Fetching playlist (${playlistFetchMode})...`);
  let playlist;
  try {
    playlist = await fetchPlaylist(playlistFetchMode);
    if (!playlist.entries.length) {
      fetchSpinner.fail("Playlist fetch completed but no tracks were found.");
      throw new Error("Playlist has no tracks.");
    }
    fetchSpinner.succeed(`Playlist fetched: ${playlist.title} (${playlist.entries.length} tracks)`);
  } catch (err) {
    if (fetchSpinner.isSpinning) {
      fetchSpinner.fail(`Failed to fetch playlist (${playlistFetchMode}).`);
    }
    throw err;
  }

  let state = await loadState();
  state = mergeStateWithPlaylist(state, playlist, shouldReset);
  await saveState(state);

  printGlobalStatus(state);

  if (statusOnly) {
    return;
  }

  let unplayed = state.tracks.filter((t) => !t.played && !t.unavailable);
  if (!unplayed.length) {
    const unavailableUnplayed = state.tracks.filter((t) => !t.played && t.unavailable).length;
    if (unavailableUnplayed > 0) {
      console.log("No playable unplayed songs remain.");
      console.log("Some tracks are marked unavailable. Run with --reset to retry all tracks.");
      return;
    }

    console.log("All songs are already marked as played.");
    console.log("Run with --reset to make all tracks unplayed and restart.");
    return;
  }

  console.log("\nPreparing tracks and metadata...");
  const preparedTracks = [];
  const tracksToPrepareCount = unplayed.length;
  for (let trackIndex = 0; trackIndex < unplayed.length; trackIndex += 1) {
    const track = unplayed[trackIndex];
    const prefix = `[${trackIndex + 1}/${tracksToPrepareCount}]`;
    const trackSpinner = startSpinner(`${prefix} ${track.title} -> checking audio source`);

    try {
      await ensureTrackDownloaded(track, audioDir, (statusText) => {
        trackSpinner.text = `${prefix} ${track.title} -> ${statusText}`;
      });

      trackSpinner.text = `${prefix} ${track.title} -> reading duration`;
      if (!isPositiveNumber(track.durationSec)) {
        track.durationSec = await probeDurationSec(track.filePath);
      }

      trackSpinner.text = `${prefix} ${track.title} -> detecting bass beat intervals and BPM`;
      if (!isPositiveNumber(track.bpm) || !isPositiveNumber(track.firstBeatSec) || track.bpmMethod !== 'bass-interval-v2') {
        const beats = await estimateBeats(track.filePath, track.durationSec);
        track.bpm = beats.bpm;
        track.firstBeatSec = beats.firstBeatSec;
        track.beatsSec = beats.beatsSec;
        track.bpmMethod = 'bass-interval-v2';
      }

      track.unavailable = false;
      track.unavailableReason = null;
      track.lastErrorAt = null;
      preparedTracks.push(track);

      const durationLabel = isPositiveNumber(track.durationSec) ? `${Math.round(track.durationSec)}s` : "unknown duration";
      const bpmLabel = isPositiveNumber(track.bpm) ? `${track.bpm.toFixed(1)} BPM` : "unknown BPM";
      trackSpinner.succeed(`${prefix} ${track.title} ready (${durationLabel}, ${bpmLabel})`);
      await saveState(state);
    } catch (err) {
      const message = String((err && err.message) || err || "");
      if (isTrackUnavailableError(message)) {
        markTrackAsUnavailable(state, track.id, message);
        trackSpinner.warn(`${prefix} skipping unavailable track: ${track.title}`);
        await saveState(state);
        continue;
      }

      trackSpinner.fail(`${prefix} failed: ${track.title}`);
      throw err;
    }
  }
  await saveState(state);

  if (!preparedTracks.length) {
    console.log("No playable tracks available after filtering unavailable videos.");
    console.log("Use --reset to retry all tracks later or remove unavailable items from the playlist.");
    printGlobalStatus(state);
    return;
  }

  console.log("Building tempo-aware random playback order...");
  const order = buildTempoAwareOrder(preparedTracks, CONFIG.tempoMatchPoolSize);
  const plan = buildTempoPlan(order);
  console.log("Tempo mode: exact beatmatch | EQ-swap transitions | beat-grid alignment");
  if (plan.length && isPositiveNumber(plan[0].adjustedBpm)) {
    const requiredCapText = isPositiveNumber(plan[0].requiredCapPercent)
      ? `, cap used ${plan[0].requiredCapPercent.toFixed(2)}%`
      : ", cap fallback used";
    console.log(`Session target tempo: ${plan[0].adjustedBpm.toFixed(2)} BPM (shared pulse${requiredCapText})`);
  }

  console.log("\nRendering tempo-adjusted stems and re-detecting beats...");
  let targetMixBpm = plan.length ? plan[0].adjustedBpm : null;
  for (let i = 0; i < plan.length; i += 1) {
    const item = plan[i];
    const prefix = `[${i + 1}/${plan.length}]`;
    const stemSpinner = startSpinner(`${prefix} ${item.track.title} -> applying tempo factor x${item.tempoFactor.toFixed(3)}`);
    item.adjustedPath = path.join(workDir, "adjusted", `${String(i + 1).padStart(3, "0")}-${item.track.id}.wav`);
    try {
      const desiredBpm = isPositiveNumber(targetMixBpm) ? targetMixBpm : item.adjustedBpm;
      let workingTempoFactor = desiredBpm / (item.metricBpm || item.originalBpm);
      let stemBeats = null;
      let startBeats = null;
      let measuredBpm = null;

      for (let attempt = 0; attempt < 3; attempt += 1) {
        stemSpinner.text = `${prefix} ${item.track.title} -> applying tempo factor x${workingTempoFactor.toFixed(6)}${attempt ? ` (calibration ${attempt + 1}/3)` : ""}`;
        await renderTempoAdjustedStem(item.track.filePath, item.adjustedPath, workingTempoFactor);

        stemSpinner.text = `${prefix} ${item.track.title} -> measuring adjusted duration`;
        item.adjustedDurationSec = await probeDurationSec(item.adjustedPath);

        // Re-detect beats on the adjusted stem for sub-sample-accurate alignment.
        // The atempo filter can introduce micro-shifts so analysing the actual
        // time-stretched audio gives us the true beat grid of the rendered file.
        stemSpinner.text = `${prefix} ${item.track.title} -> re-detecting beats on adjusted stem`;
        stemBeats = await estimateBeats(item.adjustedPath, item.adjustedDurationSec);

        // Start-of-track beat analysis: since transitions use atrim=0:td (the
        // first N seconds of the incoming stem), we need the beat PHASE at t=0
        // of the stem, not the phase from the middle.  Real music has subtle BPM
        // drift across the track that the centered analysis can't account for.
        startBeats = await estimateBeats(item.adjustedPath, item.adjustedDurationSec, { overrideStartSec: 0 });
        measuredBpm = selectMeasuredBpmForTarget(desiredBpm, startBeats.bpm, stemBeats.bpm);

        if (!isPositiveNumber(desiredBpm) || !isPositiveNumber(measuredBpm)) {
          break;
        }

        const bpmError = measuredBpm - desiredBpm;
        if (Math.abs(bpmError) <= 0.08 || attempt === 2) {
          break;
        }

        const correction = desiredBpm / measuredBpm;
        if (!Number.isFinite(correction) || Math.abs(correction - 1) < 0.0005) {
          break;
        }
        workingTempoFactor *= correction;
      }

      item.tempoFactor = workingTempoFactor;
      item.adjustedBpm = isPositiveNumber(targetMixBpm) ? targetMixBpm : item.adjustedBpm;
      item.stemBpm = stemBeats && stemBeats.bpm;
      item.stemFirstBeatSec = stemBeats && stemBeats.firstBeatSec;
      item.stemBeatsSec = (stemBeats && stemBeats.beatsSec) || [];
      item.transitionBpm = startBeats && startBeats.bpm;
      item.transitionBeatsSec = (startBeats && startBeats.beatsSec) || [];
      item.transitionFirstBeatSec = startBeats && startBeats.firstBeatSec;

      stemSpinner.succeed(
        `${prefix} stem ready: ${item.track.title} (${Math.round(item.adjustedDurationSec)}s, src ${item.originalBpm.toFixed(2)} BPM, metric ${(item.metricBpm || item.originalBpm).toFixed(2)} -> out ${(item.transitionBpm || item.stemBpm || item.adjustedBpm).toFixed(2)} BPM, target ${(item.adjustedBpm || 0).toFixed(2)}, factor x${item.tempoFactor.toFixed(6)}, shift ${item.stretchPercent.toFixed(2)}%, ${item.stemBeatsSec.length} beats)`
      );
    } catch (err) {
      stemSpinner.fail(`${prefix} stem failed: ${item.track.title}`);
      throw err;
    }
  }

  console.log("\nApplying transitions and building final mix...");
  const transitionPlan = [];
  const startTimesSec = new Array(plan.length).fill(0);

  let mixPath = plan[0].adjustedPath;
  let mixDuration = plan[0].adjustedDurationSec;

  // Beat grid for the entire mix is anchored by the first track.
  // Use the THEORETICAL adjustedBpm (exact value we fed to atempo) for the
  // beat period — NOT the re-detected stemBpm, which can have 2× octave
  // detection errors that would halve beatPeriod and place phrase snaps on
  // snare hits instead of kicks.
  const mixBpm = plan[0].adjustedBpm;
  const beatPeriod = isPositiveNumber(mixBpm) ? 60 / mixBpm : 0;
  const mixGridOffset = plan[0].transitionFirstBeatSec ?? plan[0].stemFirstBeatSec ?? plan[0].firstBeatSec;

  for (let i = 1; i < plan.length; i += 1) {
    const incoming = plan[i];
    const transition = pickTransition(plan[i - 1], incoming, i);
    let applied = applyTransitionSettings(transition, mixDuration, incoming.adjustedDurationSec);

    const transitionSpinner = startSpinner(
      `Transition ${i}/${plan.length - 1} -> ${applied.name} (${applied.durationSec.toFixed(2)}s) into ${incoming.track.title}`
    );

    // Use start-of-track stem beats for alignment: these are from the same
    // region of the stem (atrim=0:td) that the transition filter actually uses.
    // The centered analysis gives accurate BPM; this gives accurate t=0 phase.
    const outgoing = plan[i - 1];
    const outgoingStartSec = startTimesSec[i - 1];
    const incomingFirstBeat = incoming.transitionFirstBeatSec ?? incoming.stemFirstBeatSec ?? 0;
    let incomingBeats = incoming.transitionBeatsSec ?? incoming.stemBeatsSec ?? [];

    // Re-analyse the end of the PREVIOUS TRACK STEM, not the mixed output.
    // Mixed-output beat detection is polluted by prior overlaps and filters.
    // The clean outgoing stem tail is the actual deck signal we need to match.
    let currentMixGridOffset = mixGridOffset;
    let currentMixBeats = [];
    if (beatPeriod > 0.15) {
      const outgoingAnalysisStart = Math.max(0, outgoing.adjustedDurationSec - Math.max(120, applied.durationSec * 3));
      const outgoingTailBeats = await estimateBeats(outgoing.adjustedPath, outgoing.adjustedDurationSec, { overrideStartSec: outgoingAnalysisStart });
      if (isPositiveNumber(outgoingTailBeats.firstBeatSec)) {
        currentMixGridOffset = outgoingStartSec + outgoingTailBeats.firstBeatSec;
      }
      if (Array.isArray(outgoingTailBeats.beatsSec)) {
        currentMixBeats = outgoingTailBeats.beatsSec
          .map((beatSec) => outgoingStartSec + beatSec)
          .filter((beatSec) => beatSec >= Math.max(outgoingStartSec, mixDuration - Math.max(120, applied.durationSec * 3) - beatPeriod));
      }
    }

    const transitionBeatPeriod = beatPeriod;

    applied = applyTransitionSettings(transition, mixDuration, incoming.adjustedDurationSec);
    if (transitionBeatPeriod > 0.15) {
      const beatCount = Math.max(8, Math.round(applied.durationSec / transitionBeatPeriod));
      let quantized = beatCount * transitionBeatPeriod;
      const maxTd = Math.min(mixDuration * 0.45, incoming.adjustedDurationSec * 0.45);
      if (quantized > maxTd) {
        quantized = Math.max(8, Math.floor(maxTd / transitionBeatPeriod)) * transitionBeatPeriod;
      }
      applied.durationSec = Number(quantized.toFixed(3));
    }

    const beatAlignment = transitionBeatPeriod > 0.15
      ? { beatPeriod: transitionBeatPeriod, mixGridOffset: currentMixGridOffset, mixBeats: currentMixBeats, incomingFirstBeatSec: incoming.transitionFirstBeatSec ?? incomingFirstBeat, incomingBeats: incoming.transitionBeatsSec ?? incomingBeats }
      : null;

    const outPath = path.join(workDir, "mix", `mix-${String(i).padStart(3, "0")}.wav`);
    let beatShiftSec = 0;
    try {
      const result = await renderTransitionMix({
        prevMixPath: mixPath,
        nextPath: incoming.adjustedPath,
        outputPath: outPath,
        prevDurationSec: mixDuration,
        nextDurationSec: incoming.adjustedDurationSec,
        transition: applied,
        beatAlignment,
      });
      beatShiftSec = result.beatShiftSec || 0;
      if (isPositiveNumber(result.nextStartSec) || Number(result.nextStartSec) === 0) {
        startTimesSec[i] = Number(result.nextStartSec.toFixed(3));
      } else {
        startTimesSec[i] = Number((startTimesSec[i - 1] + plan[i - 1].adjustedDurationSec - applied.durationSec + beatShiftSec).toFixed(3));
      }
      if (isPositiveNumber(result.outputDurationSec)) {
        mixDuration = result.outputDurationSec;
      } else {
        mixDuration = mixDuration + incoming.adjustedDurationSec - applied.durationSec + beatShiftSec;
      }
    } catch (err) {
      transitionSpinner.fail(`Transition ${i}/${plan.length - 1} failed: ${incoming.track.title}`);
      throw err;
    }

    transitionPlan.push(applied);

    mixPath = outPath;

    const shiftLabel = Math.abs(beatShiftSec) > 0.001 ? ` [beat-shift ${beatShiftSec > 0 ? "+" : ""}${(beatShiftSec * 1000).toFixed(0)}ms]` : "";
    transitionSpinner.succeed(
      `Transition ${i}/${plan.length - 1}: ${applied.name} (${applied.durationSec.toFixed(2)}s)${shiftLabel} -> ${incoming.track.title}`
    );
  }

  const finalizeSpinner = startSpinner("Finalizing output mix file...");
  await copyFile(mixPath, CONFIG.outputFile);
  mixDuration = await probeDurationSec(CONFIG.outputFile);
  finalizeSpinner.succeed(`Final mix ready: ${CONFIG.outputFile}`);

  const sessionSummary = buildSessionSummary(plan, startTimesSec, mixDuration);
  await writeSessionFile(sessionSummary);
  console.log(`Session info ready: ${CONFIG.sessionFile}`);

  if (CONFIG.playAudio) {
    console.log("\nStarting playback...");
    scheduleSongStatusPrints(startTimesSec, plan, state, transitionPlan);
    await runCommandInherit(CONFIG.ffplayBin, ["-nodisp", "-autoexit", "-loglevel", "warning", CONFIG.outputFile]);
  } else {
    console.log("PLAY_AUDIO=false, skipping playback.");
    if (CONFIG.markPlayedWhenNotPlaying) {
      for (let i = 0; i < plan.length; i += 1) {
        markTrackAsPlayed(state, plan[i].track.id);
      }
      await saveState(state);
      printGlobalStatus(state);
    } else {
      console.log("MARK_PLAYED_WHEN_NOT_PLAYING=false, leaving played status unchanged.");
    }
  }

  if (CONFIG.cleanTempAfterRun) {
    await safeRm(path.join(workDir, "adjusted"));
    await safeRm(path.join(workDir, "mix"));
    await ensureDir(path.join(workDir, "adjusted"));
    await ensureDir(path.join(workDir, "mix"));
  }

  console.log("\nPlaylist ended. AI DJ stopped.");
}

function validateConfig() {
  if (!CONFIG.playlistUrl && !CONFIG.googlePlaylistId) {
    throw new Error("Set PLAYLIST_URL or GOOGLE_PLAYLIST_ID in .env");
  }

  const mode = resolvePlaylistFetchMode();
  if (mode === "youtube-api" && !hasGoogleOAuthConfig()) {
    throw new Error(
      "PLAYLIST_FETCH_MODE=youtube-api requires GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN"
    );
  }

  if (mode === "yt-dlp" && !CONFIG.playlistUrl) {
    throw new Error("PLAYLIST_URL is required when PLAYLIST_FETCH_MODE=yt-dlp");
  }
}

function resolvePlaylistFetchMode() {
  const mode = CONFIG.playlistFetchMode;
  if (!["auto", "yt-dlp", "youtube-api"].includes(mode)) {
    throw new Error("PLAYLIST_FETCH_MODE must be one of: auto, yt-dlp, youtube-api");
  }

  if (mode === "auto") {
    return hasGoogleOAuthConfig() ? "youtube-api" : "yt-dlp";
  }

  return mode;
}

function hasGoogleOAuthConfig() {
  return Boolean(CONFIG.googleClientId && CONFIG.googleClientSecret && CONFIG.googleRefreshToken);
}

function resolveFromRoot(inputPath) {
  if (path.isAbsolute(inputPath)) {
    return inputPath;
  }
  return path.resolve(process.cwd(), inputPath);
}

function parseBoolean(value, fallback) {
  if (value == null || value === "") {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isPositiveNumber(value) {
  return Number.isFinite(value) && value > 0;
}

function buildCookiesArgs(enabled = true) {
  if (!enabled) {
    return [];
  }

  if (CONFIG.cookiesFile) {
    return ["--cookies", CONFIG.cookiesFile];
  }
  if (CONFIG.cookiesFromBrowser) {
    return ["--cookies-from-browser", CONFIG.cookiesFromBrowser];
  }
  return [];
}

function hasCookieSourceConfigured() {
  return Boolean(CONFIG.cookiesFile || CONFIG.cookiesFromBrowser);
}

async function verifyDependencies() {
  const checks = [
    [CONFIG.ytdlpBin, ["--version"]],
    [CONFIG.ffmpegBin, ["-version"]],
    [CONFIG.ffprobeBin, ["-version"]],
    [CONFIG.ffplayBin, ["-version"]],
  ];

  for (const [bin, versionArgs] of checks) {
    try {
      await runCommandCapture(bin, versionArgs, { captureBinary: false });
    } catch (err) {
      throw new Error(`Required binary not found or not executable: ${bin}`);
    }
  }
}

async function fetchPlaylist(mode) {
  if (mode === "youtube-api") {
    return fetchPlaylistViaYoutubeApi();
  }
  return fetchPlaylistViaYtdlp();
}

async function fetchPlaylistViaYtdlp() {
  const argsList = [
    "--dump-single-json",
    "--flat-playlist",
    "--no-warnings",
    ...buildCookiesArgs(true),
    CONFIG.playlistUrl,
  ];
  const raw = await runCommandCapture(CONFIG.ytdlpBin, argsList, { captureBinary: false });

  let parsed;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch (err) {
    throw new Error("Failed to parse playlist JSON from yt-dlp.");
  }

  const entries = Array.isArray(parsed.entries)
    ? parsed.entries
        .filter((x) => x && x.id)
        .map((x) => ({
          id: String(x.id),
          title: String(x.title || `Track ${x.id}`),
          url: `https://www.youtube.com/watch?v=${x.id}`,
        }))
    : [];

  return {
    id: String(parsed.id || extractPlaylistId(CONFIG.playlistUrl) || "unknown"),
    title: String(parsed.title || "YouTube Playlist"),
    entries,
  };
}

async function fetchPlaylistViaYoutubeApi() {
  let google;
  try {
    ({ google } = require("googleapis"));
  } catch (err) {
    throw new Error("googleapis package is required for youtube-api mode. Run: npm install googleapis");
  }

  if (!hasGoogleOAuthConfig()) {
    throw new Error(
      "GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN are required for youtube-api mode"
    );
  }

  const playlistId = CONFIG.googlePlaylistId || extractPlaylistId(CONFIG.playlistUrl);
  if (!playlistId) {
    throw new Error("Could not determine playlist ID. Set GOOGLE_PLAYLIST_ID or a valid PLAYLIST_URL.");
  }

  const oauth2Client = new google.auth.OAuth2(CONFIG.googleClientId, CONFIG.googleClientSecret);
  oauth2Client.setCredentials({ refresh_token: CONFIG.googleRefreshToken });

  const youtube = google.youtube({ version: "v3", auth: oauth2Client });

  try {
    let playlistTitle = "YouTube Playlist";
    const details = await youtube.playlists.list({
      part: ["snippet"],
      id: [playlistId],
      maxResults: 1,
    });

    const maybeTitle = details && details.data && details.data.items && details.data.items[0]
      ? details.data.items[0].snippet && details.data.items[0].snippet.title
      : "";
    if (maybeTitle) {
      playlistTitle = String(maybeTitle);
    }

    const entries = [];
    let pageToken = undefined;

    do {
      const page = await youtube.playlistItems.list({
        part: ["snippet", "status"],
        playlistId,
        maxResults: 50,
        pageToken,
      });

      const items = Array.isArray(page && page.data && page.data.items) ? page.data.items : [];
      for (const item of items) {
        const videoId = item && item.snippet && item.snippet.resourceId ? item.snippet.resourceId.videoId : "";
        if (!videoId) {
          continue;
        }

        const title = item && item.snippet && item.snippet.title ? String(item.snippet.title) : `Track ${videoId}`;
        entries.push({
          id: String(videoId),
          title: title === "Private video" ? `Track ${videoId}` : title,
          url: `https://www.youtube.com/watch?v=${videoId}`,
        });
      }

      pageToken = page && page.data ? page.data.nextPageToken : "";
    } while (pageToken);

    return {
      id: String(playlistId),
      title: playlistTitle,
      entries,
    };
  } catch (err) {
    const apiError =
      (err && err.response && err.response.data && err.response.data.error && err.response.data.error.message) ||
      (err && err.message) ||
      String(err);
    throw new Error(`YouTube API playlist fetch failed: ${apiError}`);
  }
}

function extractPlaylistId(url) {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get("list") || "";
  } catch {
    return "";
  }
}

async function loadState() {
  if (!fs.existsSync(CONFIG.stateFile)) {
    return {
      version: 1,
      playlistId: "",
      playlistTitle: "",
      updatedAt: new Date().toISOString(),
      tracks: [],
    };
  }

  const raw = await fsp.readFile(CONFIG.stateFile, "utf8");
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.tracks)) {
      parsed.tracks = [];
    }
    return parsed;
  } catch {
    return {
      version: 1,
      playlistId: "",
      playlistTitle: "",
      updatedAt: new Date().toISOString(),
      tracks: [],
    };
  }
}

function mergeStateWithPlaylist(state, playlist, shouldReset) {
  const existingById = new Map(state.tracks.map((t) => [t.id, t]));
  const mergedTracks = playlist.entries.map((entry) => {
    const existing = existingById.get(entry.id);
    if (!existing) {
      return {
        id: entry.id,
        title: entry.title,
        url: entry.url,
        played: false,
        bpm: null,
        durationSec: null,
        filePath: "",
        unavailable: false,
        unavailableReason: null,
        lastErrorAt: null,
        lastPlayedAt: null,
      };
    }

    return {
      ...existing,
      title: entry.title,
      url: entry.url,
      played: shouldReset ? false : Boolean(existing.played),
      unavailable: shouldReset ? false : Boolean(existing.unavailable),
      unavailableReason: shouldReset ? null : existing.unavailableReason || null,
      lastErrorAt: shouldReset ? null : existing.lastErrorAt || null,
      lastPlayedAt: shouldReset ? null : existing.lastPlayedAt || null,
    };
  });

  return {
    ...state,
    playlistId: playlist.id,
    playlistTitle: playlist.title,
    updatedAt: new Date().toISOString(),
    tracks: mergedTracks,
  };
}

async function saveState(state) {
  state.updatedAt = new Date().toISOString();
  await fsp.writeFile(CONFIG.stateFile, JSON.stringify(state, null, 2), "utf8");
}

async function writeSessionFile(session) {
  await ensureDir(path.dirname(CONFIG.sessionFile));
  await fsp.writeFile(CONFIG.sessionFile, JSON.stringify(session, null, 2), "utf8");
}

function buildSessionSummary(plan, startTimesSec, totalDurationSec) {
  const tracks = plan.map((item, index) => {
    const startSec = Number((startTimesSec[index] || 0).toFixed(3));
    const durationSec = Number((item.adjustedDurationSec || item.track.durationSec || 0).toFixed(3));

    return {
      index,
      id: item.track.id,
      title: item.track.title,
      url: item.track.url,
      startSec,
      durationSec,
      endSec: Number((startSec + durationSec).toFixed(3)),
      originalBpm: Number(item.originalBpm.toFixed(3)),
      adjustedBpm: Number(item.adjustedBpm.toFixed(3)),
      tempoFactor: Number(item.tempoFactor.toFixed(6)),
      firstBeatSec: Number((item.firstBeatSec || 0).toFixed(3)),
    };
  });

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    outputFile: CONFIG.outputFile,
    totalDurationSec: Number((totalDurationSec || 0).toFixed(3)),
    trackCount: tracks.length,
    tracks,
  };
}

function saveStateSync(state) {
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(CONFIG.stateFile, JSON.stringify(state, null, 2), "utf8");
}

function printGlobalStatus(state) {
  const played = state.tracks.filter((t) => t.played).length;
  const unavailable = state.tracks.filter((t) => t.unavailable).length;
  const total = state.tracks.length;
  const unplayed = Math.max(0, total - played - unavailable);

  console.log("\n====== DJ STATE ======");
  console.log(`Playlist: ${state.playlistTitle} (${state.playlistId})`);
  console.log(`Total tracks: ${total}`);
  console.log(`Played: ${played}`);
  console.log(`Unavailable: ${unavailable}`);
  console.log(`Unplayed: ${unplayed}`);
}

async function ensureTrackDownloaded(track, audioDir, onStatus = () => {}) {
  if (track.filePath && fs.existsSync(track.filePath)) {
    onStatus("using cached audio file");
    return;
  }

  const cachedPath = await findCachedTrackFile(audioDir, track.id);
  if (cachedPath && fs.existsSync(cachedPath)) {
    track.filePath = cachedPath;
    onStatus("using cached audio file (matched by track ID)");
    return;
  }

  const outputTemplate = path.join(audioDir, "%(id)s.%(ext)s");
  const download = async (withCookies) => {
    onStatus(withCookies ? "downloading audio (cookies enabled)" : "downloading audio");
    const argsList = [
      "-f",
      "bestaudio/best",
      "--no-playlist",
      "--no-warnings",
      "--no-overwrites",
      "--continue",
      "-o",
      outputTemplate,
      "--print",
      "after_move:filepath",
      ...buildCookiesArgs(withCookies),
      track.url,
    ];
    return runCommandCapture(CONFIG.ytdlpBin, argsList, { captureBinary: false });
  };

  let raw;
  try {
    raw = await download(CONFIG.useCookiesForDownload);
  } catch (err) {
    if (!CONFIG.useCookiesForDownload && hasCookieSourceConfigured()) {
      console.warn(`Download failed without cookies for ${track.title}. Retrying with configured cookies...`);
      onStatus("retrying download with cookies");
      raw = await download(true);
    } else {
      throw err;
    }
  }

  const lines = raw
    .toString("utf8")
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);

  let downloadedPath = lines.length ? lines[lines.length - 1] : "";
  if (!downloadedPath || !fs.existsSync(downloadedPath)) {
    downloadedPath = await findCachedTrackFile(audioDir, track.id);
  }

  if (!downloadedPath) {
    throw new Error(`Could not find downloaded file for track ${track.id}`);
  }

  track.filePath = downloadedPath;
  onStatus("audio file ready");
}

async function findCachedTrackFile(audioDir, id) {
  const entries = await fsp.readdir(audioDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    if (entry.name.startsWith(`${id}.`)) {
      return path.join(audioDir, entry.name);
    }
  }
  return "";
}

async function probeDurationSec(filePath) {
  const argsList = [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    filePath,
  ];

  const raw = await runCommandCapture(CONFIG.ffprobeBin, argsList, { captureBinary: false });
  const value = Number.parseFloat(raw.toString("utf8").trim());
  if (!isPositiveNumber(value)) {
    throw new Error(`Could not read duration from ${filePath}`);
  }
  return value;
}

async function estimateBeats(filePath, durationSec, options = {}) {
  // Analyze a large portion of the song (up to 300s from the center) for
  // maximum beat data.  More beats → more accurate linear-regression BPM.
  // Pass { overrideStartSec: 0 } to force analysis from the start of the file
  // (used for transition alignment where atrim=0:td uses the first N seconds).
  // By default this is BASS-focused analysis, because kick/bass beat intervals
  // are what need to line up in a DJ transition. If bass isolation is too weak,
  // we fall back to full-band analysis.
  const maxSample = Math.max(CONFIG.bpmSampleSeconds, 300);
  const sampleSeconds = Math.max(15, Math.min(maxSample, Math.floor(durationSec || maxSample)));
  const startSec = (options.overrideStartSec !== undefined)
    ? Math.max(0, options.overrideStartSec)
    : Math.max(0, Math.floor(((durationSec || sampleSeconds) - sampleSeconds) / 2));
  const analysisFilter = Object.prototype.hasOwnProperty.call(options, "analysisFilter")
    ? options.analysisFilter
    : "highpass=f=28:p=2,lowpass=f=180:p=2";

  // Extract at 44100 Hz — MusicTempo's default hopSize (441) assumes this rate.
  const argsList = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-fflags",
    "+discardcorrupt",
    "-err_detect",
    "ignore_err",
    "-ss",
    String(startSec),
    "-t",
    String(sampleSeconds),
    "-i",
    filePath,
    "-ac",
    "1",
    "-ar",
    "44100",
  ];

  if (analysisFilter) {
    argsList.push("-af", analysisFilter);
  }

  argsList.push(
    "-f",
    "f32le",
    "-",
  );

  let raw;
  try {
    raw = await runCommandCapture(CONFIG.ffmpegBin, argsList, { captureBinary: true });
  } catch (err) {
    console.warn(`Beat extraction failed, using fallback for: ${path.basename(filePath)}`);
    return { bpm: 120, firstBeatSec: 0, beatsSec: [] };
  }

  const sampleCount = Math.floor(raw.length / 4);
  if (sampleCount < 44100 * 3) {
    return { bpm: 120, firstBeatSec: 0, beatsSec: [] };
  }

  // Pass 44100 Hz audio directly to MusicTempo — no downsampling.
  const samples = new Array(sampleCount);
  for (let i = 0; i < sampleCount; i += 1) {
    samples[i] = raw.readFloatLE(i * 4);
  }

  const envelope = buildTransientEnvelope(samples, 44100);
  const envelopeGrid = estimateBeatGridFromEnvelope(envelope, {
    minBpm: 50,
    maxBpm: 220,
    durationSec: sampleCount / 44100,
  });

  if (envelopeGrid && envelopeGrid.beats.length >= 4) {
    const refinedBeats = refineBeatsWithTransientEnvelope(envelopeGrid.beats, envelopeGrid.period, envelope);
    const cleanBeats = filterBeatOutliers(refinedBeats);
    const refinedRegression = regressBeatGrid(cleanBeats);
    const solvedPeriod = refinedRegression ? refinedRegression.period : envelopeGrid.period;
    const solvedPhase = refinedRegression ? refinedRegression.phase : envelopeGrid.phase;
    const beatsSec = cleanBeats.map((beat) => Math.max(0, startSec + beat));
    const firstBeatSec = Math.max(0, startSec + solvedPhase);
    return {
      bpm: clamp(60 / solvedPeriod, 50, 220),
      firstBeatSec,
      beatsSec,
    };
  }

  try {
    // Tune MusicTempo for electronic/pop music ranges and longer analysis.
    const mt = new MusicTempo(samples, {
      minBeatInterval: 60 / 220,  // max 220 BPM
      maxBeatInterval: 60 / 50,   // min 50 BPM
      expiryTime: 16,             // tolerate longer silent passages
      hopSize: 220,               // 5ms resolution (default 441 = 10ms)
    });
    if (!isPositiveNumber(mt.tempo)) {
      if (analysisFilter) {
        return estimateBeats(filePath, durationSec, { ...options, analysisFilter: null });
      }
      return { bpm: 120, firstBeatSec: 0, beatsSec: [] };
    }

    // mt.beats is an array of beat times in seconds relative to the extracted sample.
    const rawBeats = Array.isArray(mt.beats) ? mt.beats : [];

    // Filter out obviously bad intervals (skipped beats, double-triggers).
    const cleanBeats = filterBeatOutliers(rawBeats);

    // Use linear regression on beat positions for the most statistically
    // accurate BPM and phase.  Each beat at index k should satisfy:
    //   beatTime[k] ≈ phase + k * period
    // Regression gives period (→ BPM) and phase (→ first beat modulo period).
    const regression = regressBeatGrid(cleanBeats);

    // Refine the coarse beat grid against the actual waveform transients.
    // MusicTempo is good at finding the tempo family, but the exact beat phase
    // is improved by snapping each predicted beat toward the strongest local
    // transient in the waveform envelope.
    let analysisBeats = cleanBeats;
    const coarsePeriod = regression
      ? regression.period
      : (isPositiveNumber(mt.tempo) ? 60 / clamp(Number(mt.tempo), 50, 220) : null);
    if (analysisBeats.length >= 4 && isPositiveNumber(coarsePeriod)) {
      const envelope = buildTransientEnvelope(samples, 44100);
      const refinedBeats = refineBeatsWithTransientEnvelope(analysisBeats, coarsePeriod, envelope);
      if (refinedBeats.length >= 4) {
        analysisBeats = filterBeatOutliers(refinedBeats);
      }
    }

    const refinedRegression = regressBeatGrid(analysisBeats);

    if (analysisFilter && analysisBeats.length < 4) {
      return estimateBeats(filePath, durationSec, { ...options, analysisFilter: null });
    }

    let bpm;
    let gridPhaseSec; // phase within the sample window
    if (refinedRegression) {
      bpm = clamp(60 / refinedRegression.period, 50, 220);
      gridPhaseSec = refinedRegression.phase;
    } else if (analysisBeats.length >= 4) {
      // Fallback: median inter-beat interval
      const intervals = [];
      for (let j = 1; j < analysisBeats.length; j++) {
        intervals.push(analysisBeats[j] - analysisBeats[j - 1]);
      }
      intervals.sort((a, b) => a - b);
      const medianInterval = intervals[Math.floor(intervals.length / 2)];
      bpm = clamp(60 / medianInterval, 50, 220);
      gridPhaseSec = analysisBeats[0];
    } else {
      bpm = clamp(Number(mt.tempo), 50, 220);
      gridPhaseSec = rawBeats.length > 0 ? Number(rawBeats[0]) : 0;
    }

    // Convert beat times to absolute track time.
    const beatsSec = analysisBeats.map((b) => Math.max(0, startSec + b));
    const firstBeatSec = Math.max(0, startSec + gridPhaseSec);

    if (analysisFilter && beatsSec.length < 4) {
      return estimateBeats(filePath, durationSec, { ...options, analysisFilter: null });
    }

    return { bpm, firstBeatSec, beatsSec };
  } catch (err) {
    if (analysisFilter) {
      return estimateBeats(filePath, durationSec, { ...options, analysisFilter: null });
    }
    console.warn(`Beat analysis collapsed to constant fallback for: ${path.basename(filePath)}`);
    return { bpm: 120, firstBeatSec: 0, beatsSec: [] };
  }
}

function buildTransientEnvelope(samples, sampleRate) {
  const hopSamples = Math.max(64, Math.round(sampleRate * 0.005));
  const frameSamples = Math.max(hopSamples * 4, Math.round(sampleRate * 0.025));
  const values = [];
  let prevEnergy = 0;
  let peakValue = 0;

  for (let start = 0; start + frameSamples <= samples.length; start += hopSamples) {
    let absSum = 0;
    let positiveFlux = 0;
    let prevAbs = Math.abs(samples[start]);

    for (let i = 0; i < frameSamples; i += 1) {
      const currentAbs = Math.abs(samples[start + i]);
      absSum += currentAbs;
      if (i > 0) {
        const rise = currentAbs - prevAbs;
        if (rise > 0) {
          positiveFlux += rise;
        }
      }
      prevAbs = currentAbs;
    }

    const energy = absSum / frameSamples;
    const onset = Math.max(0, energy - prevEnergy * 0.98) + (positiveFlux / frameSamples) * 1.5;
    values.push(onset);
    if (onset > peakValue) {
      peakValue = onset;
    }
    prevEnergy = energy;
  }

  if (values.length >= 3) {
    const smoothed = new Array(values.length);
    smoothed[0] = (values[0] + values[1]) / 2;
    for (let i = 1; i < values.length - 1; i += 1) {
      smoothed[i] = (values[i - 1] + values[i] * 2 + values[i + 1]) / 4;
    }
    smoothed[values.length - 1] = (values[values.length - 2] + values[values.length - 1]) / 2;
    return { hopSec: hopSamples / sampleRate, values: smoothed, peakValue };
  }

  return { hopSec: hopSamples / sampleRate, values, peakValue };
}

function estimateBeatGridFromEnvelope(envelope, options = {}) {
  if (!envelope || !Array.isArray(envelope.values) || envelope.values.length < 64) {
    return null;
  }

  const hopSec = envelope.hopSec || 0.005;
  const durationSec = Number(options.durationSec || (envelope.values.length * hopSec));
  const minBpm = Number(options.minBpm || 50);
  const maxBpm = Number(options.maxBpm || 220);
  const minLag = Math.max(2, Math.round((60 / maxBpm) / hopSec));
  const maxLag = Math.max(minLag + 1, Math.round((60 / minBpm) / hopSec));
  const mean = envelope.values.reduce((sum, value) => sum + value, 0) / envelope.values.length;
  const norm = envelope.values.map((value) => Math.max(0, value - mean * 0.75));

  let bestLag = 0;
  let bestScore = -Infinity;
  const lagScores = [];

  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let score = 0;
    let count = 0;

    for (let i = 0; i + lag < norm.length; i += 1) {
      score += norm[i] * norm[i + lag];
      count += 1;
    }

    if (lag * 2 < norm.length) {
      for (let i = 0; i + (lag * 2) < norm.length; i += 1) {
        score += 0.35 * norm[i] * norm[i + (lag * 2)];
      }
    }

    if (lag > minLag * 2) {
      const halfLag = Math.round(lag / 2);
      if (halfLag >= minLag) {
        for (let i = 0; i + halfLag < norm.length; i += 1) {
          score -= 0.15 * norm[i] * norm[i + halfLag];
        }
      }
    }

    const normalizedScore = count > 0 ? score / count : 0;
    lagScores.push(normalizedScore);
    if (normalizedScore > bestScore) {
      bestScore = normalizedScore;
      bestLag = lag;
    }
  }

  if (!bestLag || !Number.isFinite(bestScore)) {
    return null;
  }

  const sortedScores = lagScores.slice().sort((a, b) => a - b);
  const medianScore = sortedScores[Math.floor(sortedScores.length / 2)] || 0;
  const confidence = bestScore / Math.max(1e-9, medianScore || 1e-9);
  if (!Number.isFinite(confidence) || confidence < 1.08) {
    return null;
  }

  const bucketScores = new Array(bestLag).fill(0);
  for (let i = 0; i < norm.length; i += 1) {
    bucketScores[i % bestLag] += norm[i];
  }

  let bestOffset = 0;
  let bestOffsetScore = -Infinity;
  for (let i = 0; i < bucketScores.length; i += 1) {
    if (bucketScores[i] > bestOffsetScore) {
      bestOffsetScore = bucketScores[i];
      bestOffset = i;
    }
  }

  const period = bestLag * hopSec;
  const beats = [];
  for (let beat = bestOffset * hopSec; beat <= durationSec + period; beat += period) {
    if (beat >= 0) {
      beats.push(beat);
    }
  }

  return {
    period,
    phase: bestOffset * hopSec,
    beats,
    confidence,
  };
}

function refineBeatsWithTransientEnvelope(beats, period, envelope) {
  if (beats.length < 4 || !isPositiveNumber(period) || !envelope || !Array.isArray(envelope.values) || !envelope.values.length) {
    return beats.slice();
  }

  const hopSec = envelope.hopSec || 0.005;
  const values = envelope.values;
  const peakValue = envelope.peakValue > 0 ? envelope.peakValue : 1;
  const maxSearchFrames = Math.max(1, Math.round((period * 0.18) / hopSec));
  const minSpacingFrames = Math.max(1, Math.round((period * 0.50) / hopSec));
  const refined = [];
  let lastFrame = -Infinity;

  for (const beat of beats) {
    const centerFrame = Math.max(0, Math.min(values.length - 1, Math.round(beat / hopSec)));
    const minFrame = Math.max(0, centerFrame - maxSearchFrames, lastFrame + minSpacingFrames);
    const maxFrame = Math.min(values.length - 1, centerFrame + maxSearchFrames);
    let bestFrame = Math.max(minFrame, Math.min(centerFrame, maxFrame));
    let bestScore = -Infinity;

    for (let frame = minFrame; frame <= maxFrame; frame += 1) {
      const normalizedValue = values[frame] / peakValue;
      const distancePenalty = Math.abs(frame - centerFrame) / Math.max(1, maxSearchFrames);
      const score = normalizedValue - distancePenalty * 0.22;
      if (score > bestScore) {
        bestScore = score;
        bestFrame = frame;
      }
    }

    const centerValue = values[centerFrame] / peakValue;
    const chosenFrame = (bestScore >= Math.max(0.06, centerValue)) ? bestFrame : centerFrame;
    refined.push(chosenFrame * hopSec);
    lastFrame = chosenFrame;
  }

  return refined;
}

/**
 * Remove beat outliers: discard beats whose interval to the previous beat
 * is more than 1.8× or less than 0.55× the median interval.  This removes
 * double-triggers and missed-beat gaps that would skew regression.
 */
function filterBeatOutliers(beats) {
  if (beats.length < 4) return beats.slice();

  const intervals = [];
  for (let i = 1; i < beats.length; i++) {
    intervals.push(beats[i] - beats[i - 1]);
  }
  const sorted = intervals.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (!median || median <= 0) return beats.slice();

  const lo = median * 0.55;
  const hi = median * 1.8;

  const clean = [beats[0]];
  for (let i = 1; i < beats.length; i++) {
    const gap = beats[i] - beats[i - 1];
    if (gap >= lo && gap <= hi) {
      clean.push(beats[i]);
    }
  }
  return clean;
}

/**
 * Filter a beat array to only beats spaced at integer multiples of
 * expectedPeriod (±tolerance).  This removes sub-beats from 2× octave
 * detection (e.g. snare hits being counted alongside kick hits) so the
 * alignment sweep works on actual musical downbeats only.
 * Falls back to original array if fewer than 4 beats survive the filter.
 */
function filterBeatsToExpectedPeriod(beats, expectedPeriod, tolerance) {
  if (beats.length < 4 || !isPositiveNumber(expectedPeriod)) return beats;
  const tol = (tolerance !== undefined) ? tolerance : 0.20;
  const result = [beats[0]];
  for (let i = 1; i < beats.length; i++) {
    const gap = beats[i] - result[result.length - 1];
    const nearestN = Math.round(gap / expectedPeriod);
    if (nearestN < 1) continue;
    if (Math.abs(gap - nearestN * expectedPeriod) / (nearestN * expectedPeriod) <= tol) {
      result.push(beats[i]);
    }
  }
  return result.length >= 4 ? result : beats;
}

function estimateLocalBeatPeriod(beats, startSec, endSec, options = {}) {
  if (!Array.isArray(beats) || beats.length < 3) {
    return null;
  }

  const maxIntervals = Math.max(4, options.maxIntervals || 16);
  const preferTail = Boolean(options.preferTail);
  const scopedBeats = beats.filter((beat) => beat >= startSec && beat <= endSec);
  if (scopedBeats.length < 3) {
    return null;
  }

  const selectedBeats = preferTail
    ? scopedBeats.slice(-1 * (maxIntervals + 1))
    : scopedBeats.slice(0, maxIntervals + 1);
  const intervals = [];
  for (let i = 1; i < selectedBeats.length; i += 1) {
    const gap = selectedBeats[i] - selectedBeats[i - 1];
    if (gap >= 0.2 && gap <= 2.0) {
      intervals.push(gap);
    }
  }
  if (!intervals.length) {
    return null;
  }

  intervals.sort((a, b) => a - b);
  const trim = intervals.length >= 7 ? 1 : 0;
  const trimmed = intervals.slice(trim, intervals.length - trim || intervals.length);
  if (!trimmed.length) {
    return null;
  }

  return trimmed[Math.floor(trimmed.length / 2)];
}

/**
 * Least-squares linear regression on beat positions to derive the best-fit
 * period (inter-beat interval) and phase (time of "beat 0").
 *
 * Model: beatTime[i] = phase + i * period
 *
 * Returns { period, phase } or null if insufficient data.
 */
function regressBeatGrid(beats) {
  const n = beats.length;
  if (n < 6) return null;

  // x = beat index, y = beat time
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumXY = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += beats[i];
    sumXX += i * i;
    sumXY += i * beats[i];
  }

  const denom = n * sumXX - sumX * sumX;
  if (Math.abs(denom) < 1e-12) return null;

  const period = (n * sumXY - sumX * sumY) / denom;
  const phase = (sumY - period * sumX) / n;

  if (!Number.isFinite(period) || period < 0.15 || period > 2.0) return null;
  if (!Number.isFinite(phase)) return null;

  // Compute residual to verify fit quality (reject if beats are too noisy).
  let ssRes = 0;
  for (let i = 0; i < n; i++) {
    const predicted = phase + i * period;
    const diff = beats[i] - predicted;
    ssRes += diff * diff;
  }
  const rmse = Math.sqrt(ssRes / n);

  // If RMSE > 15% of beat period the grid is too unreliable.
  if (rmse > period * 0.15) return null;

  // Normalize phase into [0, period)
  const normPhase = ((phase % period) + period) % period;
  return { period, phase: normPhase };
}

/**
 * Given a target BPM, find the octave of trackBpm (original, doubled, or halved)
 * that is closest to the target. This prevents extreme tempo shifts when songs
 * are at harmonically related tempos (e.g. 70 vs 140 BPM).
 */
function closestOctaveBpm(targetBpm, trackBpm) {
  if (!isPositiveNumber(targetBpm) || !isPositiveNumber(trackBpm)) {
    return trackBpm || 120;
  }

  const candidates = [trackBpm, trackBpm * 2, trackBpm / 2];
  let best = trackBpm;
  let bestDiff = Math.abs(targetBpm - trackBpm);

  for (const c of candidates) {
    const diff = Math.abs(targetBpm - c);
    if (diff < bestDiff) {
      best = c;
      bestDiff = diff;
    }
  }

  return best;
}

function getMetricBpmCandidates(trackBpm) {
  if (!isPositiveNumber(trackBpm)) {
    return [120];
  }

  const unique = new Map();
  for (const multiplier of [0.5, 1, 2]) {
    const candidate = trackBpm * multiplier;
    if (!isPositiveNumber(candidate)) {
      continue;
    }
    const key = candidate.toFixed(6);
    if (!unique.has(key)) {
      unique.set(key, {
        metricBpm: candidate,
        metricMultiplier: multiplier,
      });
    }
  }
  return Array.from(unique.values());
}

function getMedianNumber(values, fallbackValue = 120) {
  const valid = values.filter((value) => isPositiveNumber(value)).sort((a, b) => a - b);
  if (!valid.length) {
    return fallbackValue;
  }
  return valid[Math.floor(valid.length / 2)];
}

function refineTransitionDelaySec(baseDelaySec, prevFadeStart, beatPeriod, outgoingBeats, incomingBeats, firstIncomingBeat, transitionDurationSec) {
  if (!isPositiveNumber(baseDelaySec) || !isPositiveNumber(prevFadeStart) || !isPositiveNumber(beatPeriod)) {
    return baseDelaySec;
  }

  if (!Array.isArray(outgoingBeats) || !Array.isArray(incomingBeats) || !incomingBeats.length) {
    return baseDelaySec;
  }

  const toleranceSec = Math.max(0.012, Math.min(0.05, beatPeriod * 0.12));
  const maxPairs = 12;
  const incomingStartBeat = isPositiveNumber(firstIncomingBeat)
    ? firstIncomingBeat
    : incomingBeats[0];
  if (!isPositiveNumber(incomingStartBeat)) {
    return baseDelaySec;
  }

  const sortedOutgoing = outgoingBeats
    .filter((beatSec) => Number.isFinite(beatSec))
    .slice()
    .sort((a, b) => a - b);
  const sortedIncoming = incomingBeats
    .filter((beatSec) => Number.isFinite(beatSec))
    .slice()
    .sort((a, b) => a - b);
  if (!sortedOutgoing.length || !sortedIncoming.length) {
    return baseDelaySec;
  }

  const outgoingAnchorIndex = sortedOutgoing.reduce((bestIndex, beatSec, index, beats) => {
    if (bestIndex < 0) {
      return index;
    }
    return Math.abs(beatSec - prevFadeStart) < Math.abs(beats[bestIndex] - prevFadeStart) ? index : bestIndex;
  }, -1);
  const incomingAnchorIndex = sortedIncoming.reduce((bestIndex, beatSec, index, beats) => {
    if (bestIndex < 0) {
      return index;
    }
    return Math.abs(beatSec - incomingStartBeat) < Math.abs(beats[bestIndex] - incomingStartBeat) ? index : bestIndex;
  }, -1);
  if (outgoingAnchorIndex < 0 || incomingAnchorIndex < 0) {
    return baseDelaySec;
  }

  const outgoingWindowEnd = prevFadeStart + Math.max(transitionDurationSec || 0, beatPeriod * 6) + beatPeriod * 2;
  const outgoingSequence = sortedOutgoing
    .slice(outgoingAnchorIndex)
    .filter((beatSec) => beatSec <= outgoingWindowEnd)
    .slice(0, maxPairs);
  const incomingSequence = sortedIncoming
    .slice(incomingAnchorIndex)
    .filter((beatSec) => beatSec <= incomingStartBeat + Math.max(transitionDurationSec || 0, beatPeriod * 6) + beatPeriod * 2)
    .slice(0, maxPairs);

  const pairCount = Math.min(outgoingSequence.length, incomingSequence.length);
  if (pairCount < 3) {
    return baseDelaySec;
  }

  const candidateDelays = [];
  for (let i = 0; i < pairCount; i += 1) {
    const candidateDelay = outgoingSequence[i] - incomingSequence[i];
    if (Math.abs(candidateDelay - baseDelaySec) <= toleranceSec) {
      candidateDelays.push(candidateDelay);
    }
  }

  if (candidateDelays.length < 3) {
    return baseDelaySec;
  }

  const refinedDelaySec = getMedianNumber(candidateDelays, baseDelaySec);
  return Math.abs(refinedDelaySec - baseDelaySec) <= toleranceSec ? refinedDelaySec : baseDelaySec;
}

function chooseBestMetricCandidateForTarget(trackBpm, targetBpm) {
  const candidates = getMetricBpmCandidates(trackBpm);
  let best = candidates[0];
  let bestCost = Infinity;

  for (const candidate of candidates) {
    const factor = targetBpm / candidate.metricBpm;
    const cost = Math.abs(Math.log(Math.max(1e-9, factor)));
    if (cost < bestCost) {
      best = candidate;
      bestCost = cost;
    }
  }

  return best;
}

function resolveExactBeatTarget(order, preferredCapPercent) {
  const tracks = order
    .map((track) => ({
      track,
      originalBpm: isPositiveNumber(track && track.bpm) ? track.bpm : 120,
      candidates: getMetricBpmCandidates(isPositiveNumber(track && track.bpm) ? track.bpm : 120),
    }));

  const referenceBpm = getMedianNumber(tracks.map((entry) => entry.originalBpm), 120);
  const preferredCap = Math.max(0, Number(preferredCapPercent) || 0);

  for (let capPercent = preferredCap; capPercent <= 100; capPercent += 0.25) {
    const capRatio = capPercent / 100;
    const boundaries = [];
    for (const entry of tracks) {
      for (const candidate of entry.candidates) {
        boundaries.push(candidate.metricBpm * (1 - capRatio));
        boundaries.push(candidate.metricBpm * (1 + capRatio));
      }
    }

    const sorted = boundaries
      .filter((value) => isPositiveNumber(value))
      .sort((a, b) => a - b);
    const points = new Set([referenceBpm]);
    for (let i = 0; i < sorted.length; i += 1) {
      points.add(sorted[i]);
      if (i + 1 < sorted.length) {
        points.add((sorted[i] + sorted[i + 1]) / 2);
      }
    }

    let bestTarget = null;
    let bestAssignments = null;
    let bestScore = Infinity;

    for (const point of points) {
      if (!isPositiveNumber(point)) {
        continue;
      }

      const assignments = [];
      let feasible = true;
      let score = 0;
      let maxStretch = 0;

      for (const entry of tracks) {
        let bestCandidate = null;
        let bestCandidateCost = Infinity;

        for (const candidate of entry.candidates) {
          const factor = point / candidate.metricBpm;
          const stretchPercent = Math.abs(factor - 1) * 100;
          if (stretchPercent > capPercent + 1e-9) {
            continue;
          }

          const cost = Math.abs(Math.log(Math.max(1e-9, factor)));
          if (cost < bestCandidateCost) {
            bestCandidateCost = cost;
            bestCandidate = {
              metricBpm: candidate.metricBpm,
              metricMultiplier: candidate.metricMultiplier,
              tempoFactor: factor,
              stretchPercent,
            };
          }
        }

        if (!bestCandidate) {
          feasible = false;
          break;
        }

        assignments.push(bestCandidate);
        score += bestCandidateCost * bestCandidateCost;
        maxStretch = Math.max(maxStretch, bestCandidate.stretchPercent);
      }

      if (!feasible) {
        continue;
      }

      score += maxStretch * 0.0001;
      score += Math.abs(Math.log(Math.max(1e-9, point / referenceBpm))) * 0.01;
      if (score < bestScore) {
        bestScore = score;
        bestTarget = point;
        bestAssignments = assignments;
      }
    }

    if (bestTarget && bestAssignments) {
      return {
        targetBpm: bestTarget,
        assignments: bestAssignments,
        requiredCapPercent: capPercent,
      };
    }
  }

  const fallbackTarget = referenceBpm;
  return {
    targetBpm: fallbackTarget,
    assignments: tracks.map((entry) => {
      const candidate = chooseBestMetricCandidateForTarget(entry.originalBpm, fallbackTarget);
      return {
        metricBpm: candidate.metricBpm,
        metricMultiplier: candidate.metricMultiplier,
        tempoFactor: fallbackTarget / candidate.metricBpm,
        stretchPercent: Math.abs((fallbackTarget / candidate.metricBpm) - 1) * 100,
      };
    }),
    requiredCapPercent: null,
  };
}

function getTrackStretchPercent(planItem) {
  const factor = Number(planItem && planItem.tempoFactor);
  if (!Number.isFinite(factor) || factor <= 0) {
    return 0;
  }
  return Math.abs(factor - 1) * 100;
}

function scoreTempoNeighbour(currentTrack, candidateTrack) {
  const currentBpm = isPositiveNumber(currentTrack && currentTrack.bpm) ? currentTrack.bpm : 120;
  const candidateBpm = isPositiveNumber(candidateTrack && candidateTrack.bpm) ? candidateTrack.bpm : 120;
  return {
    track: candidateTrack,
    bpmDiff: Math.abs(candidateBpm - currentBpm),
  };
}

function scoreTransitionDifficulty(previousPlanItem, nextPlanItem) {
  if (!previousPlanItem || !nextPlanItem) {
    return { bpmDiff: 0, stretchPercent: 0 };
  }

  const desiredBpm = isPositiveNumber(previousPlanItem.adjustedBpm)
    ? previousPlanItem.adjustedBpm
    : (isPositiveNumber(previousPlanItem.originalBpm) ? previousPlanItem.originalBpm : 120);
  const nextOriginalBpm = isPositiveNumber(nextPlanItem.originalBpm) ? nextPlanItem.originalBpm : 120;

  return {
    bpmDiff: Math.abs(nextOriginalBpm - desiredBpm),
    stretchPercent: Math.max(
      getTrackStretchPercent(previousPlanItem),
      getTrackStretchPercent(nextPlanItem),
    ),
  };
}

function selectMeasuredBpmForTarget(desiredBpm, ...candidates) {
  const valid = candidates.filter((candidate) => isPositiveNumber(candidate));
  if (!valid.length) {
    return null;
  }
  if (!isPositiveNumber(desiredBpm)) {
    return valid[0];
  }

  let best = closestOctaveBpm(desiredBpm, valid[0]);
  let bestDiff = Math.abs(best - desiredBpm);

  for (let i = 1; i < valid.length; i += 1) {
    const corrected = closestOctaveBpm(desiredBpm, valid[i]);
    const diff = Math.abs(corrected - desiredBpm);
    if (diff < bestDiff) {
      best = corrected;
      bestDiff = diff;
    }
  }

  return best;
}

function buildTempoAwareOrder(unplayedTracks, poolSize) {
  const remaining = [...unplayedTracks];
  const order = [];

  if (!remaining.length) {
    return order;
  }

  const sortedByBpm = remaining
    .slice()
    .sort((a, b) => {
      const aBpm = isPositiveNumber(a && a.bpm) ? a.bpm : 120;
      const bBpm = isPositiveNumber(b && b.bpm) ? b.bpm : 120;
      return aBpm - bBpm;
    });
  const medianTrack = sortedByBpm[Math.floor(sortedByBpm.length / 2)];
  const firstIndex = remaining.findIndex((track) => track.id === medianTrack.id);
  order.push(remaining.splice(firstIndex >= 0 ? firstIndex : 0, 1)[0]);

  while (remaining.length) {
    const current = order[order.length - 1];

    const scored = remaining
      .map((track) => scoreTempoNeighbour(current, track))
      .sort((a, b) => a.bpmDiff - b.bpmDiff);

    const pool = scored.slice(0, Math.max(1, Math.min(poolSize, scored.length)));
    const pick = pool[0].track;

    order.push(pick);
    remaining.splice(
      remaining.findIndex((x) => x.id === pick.id),
      1
    );
  }

  return order;
}

function buildTempoPlan(order) {
  const tempoResolution = resolveExactBeatTarget(order, CONFIG.maxTempoShiftPercent);
  const targetBpm = tempoResolution.targetBpm;

  const plan = [];

  for (let i = 0; i < order.length; i += 1) {
    const track = order[i];
    const originalBpm = isPositiveNumber(track.bpm) ? track.bpm : 120;
    const firstBeatSec = isPositiveNumber(track.firstBeatSec) ? track.firstBeatSec : 0;

    const assignment = tempoResolution.assignments[i] || chooseBestMetricCandidateForTarget(originalBpm, targetBpm);
    // Exact beatmatch: every track is stretched to the SAME shared pulse, but
    // each track may use a metric multiple (half-time / normal / double-time)
    // first so we avoid unnecessary extreme speed changes.
    const tempoFactor = assignment.tempoFactor;
    // adjustedBpm is the BPM the stem actually plays at after time-stretching.
    // Since atempo stretches time by tempoFactor, the new pulse = metricBpm * tempoFactor.
    // This simplifies to `targetBpm` — all tracks in the session run at the same BPM.
    const adjustedBpm = assignment.metricBpm * tempoFactor;

    plan.push({
      track,
      originalBpm,
      metricBpm: assignment.metricBpm,
      metricMultiplier: assignment.metricMultiplier,
      stretchPercent: assignment.stretchPercent,
      requiredCapPercent: tempoResolution.requiredCapPercent,
      adjustedBpm,
      tempoFactor,
      firstBeatSec,
    });
  }

  return plan;
}

async function renderTempoAdjustedStem(inputPath, outputPath, tempoFactor) {
  const tempoFilter = buildAtempoFilter(tempoFactor);
  // loudnorm internally upsamples to 192 kHz for its analysis pass.
  // Without the trailing aresample=48000 the output WAV would be written
  // at 192 kHz, causing playback at 1/4 speed in any 48 kHz pipeline.
  // The resample AFTER loudnorm is therefore mandatory.
  const filter = `${tempoFilter},aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000`;

  const argsList = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-fflags",
    "+discardcorrupt",
    "-err_detect",
    "ignore_err",
    "-i",
    inputPath,
    "-vn",
    "-af",
    filter,
    outputPath,
  ];
  await runCommandCapture(CONFIG.ffmpegBin, argsList, { captureBinary: false });
}

function buildAtempoFilter(factor) {
  if (!Number.isFinite(factor) || factor <= 0) {
    return "anull";
  }
  if (Math.abs(factor - 1) < 0.0005) {
    return "anull";
  }

  const parts = [];
  let remaining = factor;

  while (remaining > 2.0) {
    parts.push("atempo=2.0");
    remaining /= 2.0;
  }

  while (remaining < 0.5) {
    parts.push("atempo=0.5");
    remaining /= 0.5;
  }

  parts.push(`atempo=${remaining.toFixed(6)}`);
  return parts.join(",");
}

// Prefer slower, longer blends for difficult pairs. Short swaps are only used
// when both tracks are already close in source tempo and need little stretching.
function pickTransition(previousPlanItem, nextPlanItem, transitionIndex) {
  const difficulty = scoreTransitionDifficulty(previousPlanItem, nextPlanItem);
  if (difficulty.stretchPercent >= 10 || difficulty.bpmDiff >= 10) {
    return TRANSITIONS.find((transition) => transition.name === "Slow Blend") || TRANSITIONS[TRANSITIONS.length - 1];
  }
  if (difficulty.stretchPercent >= 5 || difficulty.bpmDiff >= 5) {
    return TRANSITIONS.find((transition) => transition.name === "Club EQ Swap") || TRANSITIONS[0];
  }
  return TRANSITIONS.find((transition) => transition.name === "Quick Drop") || TRANSITIONS[transitionIndex % TRANSITIONS.length];
}

function applyTransitionSettings(transition, prevDurationSec, nextDurationSec) {
  const maxAllowed = Math.min(prevDurationSec * 0.45, nextDurationSec * 0.45);
  const wanted = clamp(
    transition.baseSeconds,
    Math.min(CONFIG.minTransitionSeconds, CONFIG.maxTransitionSeconds),
    Math.max(CONFIG.minTransitionSeconds, CONFIG.maxTransitionSeconds)
  );

  const durationSec = clamp(Math.min(wanted, maxAllowed), 1.5, Math.max(1.5, maxAllowed));

  return {
    ...transition,
    durationSec: Number(durationSec.toFixed(3)),
  };
}

async function renderTransitionMix({ prevMixPath, nextPath, outputPath, prevDurationSec, nextDurationSec, transition, beatAlignment }) {
  let td = transition.durationSec;

  if (!isPositiveNumber(td) || td <= 0.5 || prevDurationSec <= td || nextDurationSec <= td) {
    await renderConcatMix(prevMixPath, nextPath, outputPath);
    transition.durationSec = 0;
    transition.name = `${transition.name} (fallback concat)`;
    return { beatShiftSec: 0 };
  }

  let beatShiftSec = 0;
  let prevFadeStart = Math.max(0, prevDurationSec - td);

  if (beatAlignment && isPositiveNumber(beatAlignment.beatPeriod) && beatAlignment.beatPeriod > 0.15) {
    const bp = beatAlignment.beatPeriod;
    const gridOffset = beatAlignment.mixGridOffset;
    const mixBeats = beatAlignment.mixBeats || [];
    const inFirstBeat = beatAlignment.incomingFirstBeatSec;
    const inBeats = beatAlignment.incomingBeats || [];

    // Snap the fade-out start to an ACTUAL outgoing beat, preferably also on a
    // larger phrase boundary. This uses the clean previous stem's beat times,
    // not a theoretical grid or mixed output analysis.
    const minFadeStart = prevDurationSec * 0.45;
    const eligibleOutgoingBeats = mixBeats.filter((beatSec) => beatSec >= minFadeStart && beatSec <= prevDurationSec - bp * 2);
    let anchorBeat = null;
    if (eligibleOutgoingBeats.length) {
      for (const numBeats of [16, 8, 4, 2, 1]) {
        const phraseCandidates = eligibleOutgoingBeats.filter((beatSec) => {
          const beatIndex = Math.round((beatSec - gridOffset) / bp);
          return Math.abs((gridOffset + beatIndex * bp) - beatSec) <= Math.max(0.03, bp * 0.08)
            && beatIndex >= 0
            && beatIndex % numBeats === 0;
        });
        if (phraseCandidates.length) {
          anchorBeat = phraseCandidates.reduce((best, beatSec) => {
            if (best === null) return beatSec;
            return Math.abs(beatSec - prevFadeStart) < Math.abs(best - prevFadeStart) ? beatSec : best;
          }, null);
          break;
        }
      }
      if (!isPositiveNumber(anchorBeat)) {
        anchorBeat = eligibleOutgoingBeats.reduce((best, beatSec) => {
          if (best === null) return beatSec;
          return Math.abs(beatSec - prevFadeStart) < Math.abs(best - prevFadeStart) ? beatSec : best;
        }, null);
      }
    }
    if (isPositiveNumber(anchorBeat)) {
      prevFadeStart = anchorBeat;
    } else {
      // Last resort if outgoing beat extraction was unreliable.
      const phase = ((prevFadeStart - gridOffset) % bp + bp) % bp;
      prevFadeStart = phase <= bp / 2
        ? Math.max(0, prevFadeStart - phase)
        : Math.max(0, prevFadeStart + (bp - phase));
    }
    td = Math.max(bp * 2, prevDurationSec - prevFadeStart);
    transition.durationSec = Number(td.toFixed(3));

    // Exact beat-start alignment: the incoming FIRST beat must land exactly on
    // the anchored outgoing beat at the crossfade start.
    const firstIncomingBeat = isPositiveNumber(inFirstBeat)
      ? inFirstBeat
      : (Array.isArray(inBeats) && inBeats.length ? inBeats[0] : 0);
    const baseDelaySec = Math.max(0, prevFadeStart - firstIncomingBeat);
    const refinedDelaySec = refineTransitionDelaySec(
      baseDelaySec,
      prevFadeStart,
      bp,
      mixBeats,
      inBeats,
      firstIncomingBeat,
      td
    );
    beatShiftSec = refinedDelaySec - prevFadeStart;
  }

  const adjustedDelaySec = prevFadeStart + beatShiftSec;
  const delayMs = Math.max(0, Math.round(adjustedDelaySec * 1000));
  const nextStartSec = delayMs / 1000;

  // === DJ-style EQ-swap transition ===
  //
  // NEVER fades overall volume — always full-power audio playing.
  // Uses frequency-band crossfade: bass swaps first, then highs follow.
  //
  // Key design:
  //   - Pre-transition audio: BIT-PERFECT (time-split, zero filters)
  //   - Post-transition audio: BIT-PERFECT (time-split, zero filters)
  //   - Transition zone ONLY: band-split with LR4 crossover, per-band fades
  //   - No cumulative degradation on the accumulated mix
  //
  // Timeline within the transition zone:
  //   0%────[bass swaps]────60%
  //              40%────[highs swap]────100%
  //
  // At every point: outgoing_band_level + incoming_band_level = 1.0
  // per band, so total perceived loudness is constant. No silence ever.

  // ── EQ-swap crossfade filter graph ────────────────────────────────────────
  //
  // Professional DJ technique: NEVER fade the master volume.
  // Instead, swap frequency bands between the two decks:
  //   • Bass (sub/kick/bass): outgoing fades out, incoming fades in — FIRST
  //   • High mids + highs:    outgoing fades out, incoming fades in — SECOND
  //   • 20% overlap zone where both are partially audible in each band
  //
  // Band crossover: 250 Hz (separates bass from everything above)
  // Filter: 4th-order Linkwitz-Riley
  //   LR4 = two cascaded 2nd-order Butterworth filters at the SAME frequency.
  //   This gives sum(lo, hi) = unity at ALL frequencies → no magnitude bumps.
  //   Note: FFmpeg `lowpass` is 1st-order by default. We use `lowpass=f=X:p=2`
  //   (2-pole = 2nd-order Butterworth) and cascade twice for true LR4.
  //
  // Equal-power fade curves (esin/isin) ensure that at any crossfade point:
  //   out_gain² + in_gain² = 1  → constant perceived loudness, no dip or peak.
  //
  // Timeline within the td-second transition zone:
  //   [0%──────BASS OUT────────60%]
  //                [40%────HIGHS OUT────100%]
  //   [0%──────BASS IN─────────60%]
  //                [40%────HIGHS IN─────100%]

  const bassFreq = 250;
  // LR4low  = two cascaded 2nd-order Butterworth lowpass  = 4th-order LR
  // LR4high = two cascaded 2nd-order Butterworth highpass = 4th-order LR
  const lr4Lo = `lowpass=f=${bassFreq}:p=2,lowpass=f=${bassFreq}:p=2`;
  const lr4Hi = `highpass=f=${bassFreq}:p=2,highpass=f=${bassFreq}:p=2`;

  const prevFadeStartMs = Math.round(prevFadeStart * 1000);
  // postTransMs: where the incoming track's clean (post-crossfade) section sits
  // in the OUTPUT timeline = when the incoming track starts + length of the
  // crossfade zone that was trimmed away.
  const postTransMs = Math.max(0, Math.round(delayMs + td * 1000));

  // Bass swap occupies the FIRST 60% of the transition; highs the LAST 60%.
  // This creates a 20% overlap where both bands are in motion simultaneously.
  const bassDur  = td * 0.60;
  const highStart = td * 0.40;
  const highDur  = td * 0.60;

  const graph = [
    // ── OUTGOING (input 0 = accumulated mix) ─────────────────────────────
    // Force 48000 Hz / float / stereo so both inputs share the same format.
    `[0:a]aformat=sample_rates=48000:sample_fmts=fltp:channel_layouts=stereo,atrim=0:${fmt(prevDurationSec)},asetpts=PTS-STARTPTS,asplit=3[a0c1][a0c2][a0c3]`,
    // Pre-transition: left completely untouched up to the crossfade start.
    `[a0c1]atrim=0:${fmt(prevFadeStart)},asetpts=PTS-STARTPTS[a0pre]`,
    // Bass band of outgoing track: fades out with equal-power curve over bassDur.
    `[a0c2]atrim=${fmt(prevFadeStart)}:${fmt(prevDurationSec)},asetpts=PTS-STARTPTS,${lr4Lo},afade=t=out:st=0:d=${fmt(bassDur)}:curve=iqsin,adelay=${prevFadeStartMs}|${prevFadeStartMs}[a0t_lo]`,
    // High band of outgoing track: fades out with equal-power curve starting at highStart.
    `[a0c3]atrim=${fmt(prevFadeStart)}:${fmt(prevDurationSec)},asetpts=PTS-STARTPTS,${lr4Hi},afade=t=out:st=${fmt(highStart)}:d=${fmt(highDur)}:curve=iqsin,adelay=${prevFadeStartMs}|${prevFadeStartMs}[a0t_hi]`,

    // ── INCOMING (input 1 = next track stem) ─────────────────────────────
    `[1:a]aformat=sample_rates=48000:sample_fmts=fltp:channel_layouts=stereo,atrim=0:${fmt(nextDurationSec)},asetpts=PTS-STARTPTS,asplit=3[a1c1][a1c2][a1c3]`,
    // Bass band of incoming track: fades in with equal-power curve over bassDur.
    `[a1c1]atrim=0:${fmt(td)},asetpts=PTS-STARTPTS,${lr4Lo},afade=t=in:st=0:d=${fmt(bassDur)}:curve=qsin,adelay=${delayMs}|${delayMs}[a1t_lo]`,
    // High band of incoming track: fades in with equal-power curve starting at highStart.
    `[a1c2]atrim=0:${fmt(td)},asetpts=PTS-STARTPTS,${lr4Hi},afade=t=in:st=${fmt(highStart)}:d=${fmt(highDur)}:curve=qsin,adelay=${delayMs}|${delayMs}[a1t_hi]`,
    // Post-transition: incoming track continues clean after the crossfade zone.
    `[a1c3]atrim=${fmt(td)}:${fmt(nextDurationSec)},asetpts=PTS-STARTPTS,adelay=${postTransMs}|${postTransMs}[a1post]`,

    // ── Final mix: sum all 6 streams at unity gain (no normalize, no limiting). ─
    `[a0pre][a0t_lo][a0t_hi][a1t_lo][a1t_hi][a1post]amix=inputs=6:duration=longest:dropout_transition=0:normalize=0[outa]`,
  ].join(";");

  const argsList = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    prevMixPath,
    "-i",
    nextPath,
    "-filter_complex",
    graph,
    "-map",
    "[outa]",
    outputPath,
  ];

  await runCommandCapture(CONFIG.ffmpegBin, argsList, { captureBinary: false });
  const outputDurationSec = await probeDurationSec(outputPath);
  return { beatShiftSec, nextStartSec, outputDurationSec };
}

async function renderConcatMix(prevMixPath, nextPath, outputPath) {
  const graph = "[0:a][1:a]concat=n=2:v=0:a=1[outa]";
  const argsList = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    prevMixPath,
    "-i",
    nextPath,
    "-filter_complex",
    graph,
    "-map",
    "[outa]",
    outputPath,
  ];

  await runCommandCapture(CONFIG.ffmpegBin, argsList, { captureBinary: false });
}

function scheduleSongStatusPrints(startTimesSec, plan, state, transitionPlan) {
  for (let i = 0; i < plan.length; i += 1) {
    const delayMs = Math.max(0, Math.round(startTimesSec[i] * 1000));

    setTimeout(() => {
      const current = plan[i];
      markTrackAsPlayed(state, current.track.id);
      saveStateSync(state);

      const played = state.tracks.filter((t) => t.played).length;
      const unavailable = state.tracks.filter((t) => t.unavailable).length;
      const total = state.tracks.length;
      const unplayed = Math.max(0, total - played - unavailable);

      console.log("\n========================================");
      console.log(`Now playing ${i + 1}/${plan.length}: ${current.track.title}`);
      console.log(`Track ID: ${current.track.id}`);
      console.log(
        `Tempo: ${current.originalBpm.toFixed(1)} BPM -> ${current.adjustedBpm.toFixed(1)} BPM (x${current.tempoFactor.toFixed(3)})`
      );

      if (i > 0) {
        const t = transitionPlan[i - 1];
        console.log(`Transition in: ${t.name} (${t.durationSec.toFixed(2)}s)`);
      } else {
        console.log("Transition in: Start of set");
      }

      if (i < plan.length - 1) {
        console.log(`Next: ${plan[i + 1].track.title}`);
      } else {
        console.log("Next: End of playlist");
      }

      console.log(`Status -> Played: ${played}/${total} | Unavailable: ${unavailable} | Unplayed: ${unplayed}`);
      console.log("========================================");
    }, delayMs);
  }
}

function markTrackAsPlayed(state, trackId) {
  const idx = state.tracks.findIndex((t) => t.id === trackId);
  if (idx === -1) {
    return;
  }

  state.tracks[idx].played = true;
  state.tracks[idx].unavailable = false;
  state.tracks[idx].unavailableReason = null;
  state.tracks[idx].lastErrorAt = null;
  state.tracks[idx].lastPlayedAt = new Date().toISOString();
}

function markTrackAsUnavailable(state, trackId, reason) {
  const idx = state.tracks.findIndex((t) => t.id === trackId);
  if (idx === -1) {
    return;
  }

  const message = String(reason || "Unavailable").slice(0, 1200);
  state.tracks[idx].unavailable = true;
  state.tracks[idx].unavailableReason = message;
  state.tracks[idx].lastErrorAt = new Date().toISOString();
}

function isTrackUnavailableError(message) {
  const normalized = String(message || "").toLowerCase();
  if (!normalized.includes("[youtube]")) {
    return false;
  }

  const markers = [
    "video unavailable",
    "this video is not available",
    "private video",
    "this video is private",
    "has been removed",
    "not available in your country",
    "uploader has not made this video available",
  ];

  return markers.some((marker) => normalized.includes(marker));
}

async function runCommandCapture(command, argsList, options = {}) {
  const { captureBinary = false } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(command, argsList, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    const stdoutChunks = [];
    const stderrChunks = [];

    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

    child.on("error", (err) => reject(err));

    child.on("close", (code) => {
      if (code === 0) {
        const out = Buffer.concat(stdoutChunks);
        resolve(captureBinary ? out : Buffer.from(out.toString("utf8"), "utf8"));
        return;
      }

      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      reject(new Error(`${command} ${argsList.join(" ")} failed with code ${code}\n${stderr}`));
    });
  });
}

async function runCommandInherit(command, argsList) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argsList, {
      stdio: "inherit",
      shell: false,
    });

    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${argsList.join(" ")} failed with code ${code}`));
    });
  });
}

async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

async function copyFile(src, dest) {
  await ensureDir(path.dirname(dest));
  await fsp.copyFile(src, dest);
}

async function safeRm(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return;
  }
  await fsp.rm(targetPath, { recursive: true, force: true });
}

function startSpinner(text) {
  const shouldUseSpinner = !CONFIG.disableSpinners && Boolean(process.stdout && process.stdout.isTTY);
  if (!shouldUseSpinner) {
    return createNoopSpinner(text);
  }

  return ora({
    text,
    spinner: "dots",
  }).start();
}

function createNoopSpinner(initialText) {
  let currentText = initialText;
  let lastOutput = "";

  const log = (prefix, message) => {
    const line = `${prefix} ${message}`;
    if (line !== lastOutput) {
      console.log(line);
      lastOutput = line;
    }
  };

  log("...", currentText);

  return {
    isSpinning: false,
    get text() {
      return currentText;
    },
    set text(value) {
      currentText = value;
      log("...", value);
    },
    succeed(message) {
      log("OK", message || currentText);
      return this;
    },
    fail(message) {
      log("FAIL", message || currentText);
      return this;
    },
    warn(message) {
      log("WARN", message || currentText);
      return this;
    },
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function fmt(value) {
  return Number(value).toFixed(6);
}

main().catch((err) => {
  const message = String((err && err.message) || err || "Unknown error");

  console.error("\nAI DJ failed:");
  console.error(message);

  if (message.includes("Could not copy Chrome cookie database")) {
    console.error("\nTroubleshooting:");
    console.error("1) Close Chrome completely, including background processes.");
    console.error("2) Run: taskkill /F /IM chrome.exe");
    console.error("3) Start a new terminal and run: npm run dj");
    console.error("4) If it still fails, export cookies.txt and set YTDLP_COOKIES_FILE in .env, then clear YTDLP_COOKIES_FROM_BROWSER.");
  }

  process.exit(1);
});
