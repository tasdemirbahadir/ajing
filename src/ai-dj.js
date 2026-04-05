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
  bpmSampleSeconds: parseInteger(process.env.BPM_SAMPLE_SECONDS, 35),
  tempoMatchPoolSize: parseInteger(process.env.TEMPO_MATCH_POOL_SIZE, 5),
  strictBpmMatch: parseBoolean(process.env.STRICT_BPM_MATCH, true),
  maxTempoShiftPercent: parseNumber(process.env.MAX_TEMPO_SHIFT_PERCENT, 8),
  minTransitionSeconds: parseNumber(process.env.MIN_TRANSITION_SECONDS, 5),
  maxTransitionSeconds: parseNumber(process.env.MAX_TRANSITION_SECONDS, 10),
  playAudio: parseBoolean(process.env.PLAY_AUDIO, true),
  markPlayedWhenNotPlaying: parseBoolean(process.env.MARK_PLAYED_WHEN_NOT_PLAYING, true),
  cleanTempAfterRun: parseBoolean(process.env.CLEAN_TEMP_AFTER_RUN, false),
  autoResetOnStart: parseBoolean(process.env.AUTO_RESET_ON_START, false),
  disableSpinners: parseBoolean(process.env.DISABLE_SPINNERS, false),
};

const TRANSITIONS = [
  {
    name: "Velvet Fade",
    baseSeconds: 7,
    c1: "qsin",
    c2: "qsin",
    outFx: "lowpass=f=10000",
    inFx: "highpass=f=70",
  },
  {
    name: "Club Lift",
    baseSeconds: 8,
    c1: "exp",
    c2: "hsin",
    outFx: "highpass=f=180,bass=g=-3:f=120",
    inFx: "bass=g=5:f=110",
  },
  {
    name: "Air Sweep",
    baseSeconds: 6,
    c1: "hsin",
    c2: "esin",
    outFx: "treble=g=-4:f=6500",
    inFx: "treble=g=6:f=7000",
  },
  {
    name: "Echo Mist",
    baseSeconds: 9,
    c1: "tri",
    c2: "exp",
    outFx: "aecho=0.7:0.75:45:0.2",
    inFx: "aecho=0.6:0.7:35:0.15",
  },
  {
    name: "Radio Tunnel",
    baseSeconds: 7,
    c1: "log",
    c2: "qsin",
    outFx: "lowpass=f=3200,highpass=f=220",
    inFx: "lowpass=f=3800,highpass=f=200",
  },
  {
    name: "Warm Bloom",
    baseSeconds: 8,
    c1: "par",
    c2: "cub",
    outFx: "bass=g=4:f=115,treble=g=-2:f=7000",
    inFx: "bass=g=6:f=120",
  },
  {
    name: "Tight Pump",
    baseSeconds: 6,
    c1: "exp",
    c2: "exp",
    outFx: "acompressor=threshold=-20dB:ratio=3:attack=10:release=140",
    inFx: "acompressor=threshold=-19dB:ratio=2.8:attack=8:release=120",
  },
  {
    name: "Crystal Blend",
    baseSeconds: 7,
    c1: "qua",
    c2: "qua",
    outFx: "treble=g=3:f=7800",
    inFx: "highpass=f=100,treble=g=4:f=8200",
  },
  {
    name: "Bass Relay",
    baseSeconds: 8,
    c1: "cbr",
    c2: "qsin",
    outFx: "highpass=f=200",
    inFx: "bass=g=7:f=105",
  },
  {
    name: "Sunset Drift",
    baseSeconds: 10,
    c1: "tri",
    c2: "hsin",
    outFx: "aecho=0.55:0.7:60:0.2,lowpass=f=7200",
    inFx: "highpass=f=80,lowpass=f=12000",
  },
  {
    name: "Clean Arc",
    baseSeconds: 5,
    c1: "squ",
    c2: "cub",
    outFx: "volume=0.98",
    inFx: "volume=1.02",
  },
  {
    name: "Neon Glide",
    baseSeconds: 9,
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

      trackSpinner.text = `${prefix} ${track.title} -> estimating BPM`;
      if (!isPositiveNumber(track.bpm)) {
        track.bpm = await estimateBpm(track.filePath, track.durationSec);
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
  console.log("Tempo mode: strict beatmatch (each next track is matched to previous track BPM exactly)");

  console.log("\nRendering tempo-adjusted stems...");
  for (let i = 0; i < plan.length; i += 1) {
    const item = plan[i];
    const prefix = `[${i + 1}/${plan.length}]`;
    const stemSpinner = startSpinner(`${prefix} ${item.track.title} -> applying tempo factor x${item.tempoFactor.toFixed(3)}`);
    item.adjustedPath = path.join(workDir, "adjusted", `${String(i + 1).padStart(3, "0")}-${item.track.id}.wav`);
    try {
      await renderTempoAdjustedStem(item.track.filePath, item.adjustedPath, item.tempoFactor);
      stemSpinner.text = `${prefix} ${item.track.title} -> measuring adjusted duration`;
      item.adjustedDurationSec = await probeDurationSec(item.adjustedPath);
      stemSpinner.succeed(
        `${prefix} stem ready: ${item.track.title} (${Math.round(item.adjustedDurationSec)}s, ${item.adjustedBpm.toFixed(1)} BPM)`
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

  for (let i = 1; i < plan.length; i += 1) {
    const incoming = plan[i];
    const transition = pickRandomTransition();
    const applied = applyTransitionSettings(transition, mixDuration, incoming.adjustedDurationSec);
    const transitionSpinner = startSpinner(
      `Transition ${i}/${plan.length - 1} -> ${applied.name} (${applied.durationSec.toFixed(2)}s) into ${incoming.track.title}`
    );

    const outPath = path.join(workDir, "mix", `mix-${String(i).padStart(3, "0")}.wav`);
    try {
      await renderTransitionMix({
        prevMixPath: mixPath,
        nextPath: incoming.adjustedPath,
        outputPath: outPath,
        prevDurationSec: mixDuration,
        nextDurationSec: incoming.adjustedDurationSec,
        transition: applied,
      });
    } catch (err) {
      transitionSpinner.fail(`Transition ${i}/${plan.length - 1} failed: ${incoming.track.title}`);
      throw err;
    }

    transitionPlan.push(applied);
    startTimesSec[i] = startTimesSec[i - 1] + plan[i - 1].adjustedDurationSec - applied.durationSec;

    mixPath = outPath;
    mixDuration = mixDuration + incoming.adjustedDurationSec - applied.durationSec;

    transitionSpinner.succeed(
      `Transition ${i}/${plan.length - 1}: ${applied.name} (${applied.durationSec.toFixed(2)}s) -> ${incoming.track.title}`
    );
  }

  const finalizeSpinner = startSpinner("Finalizing output mix file...");
  await copyFile(mixPath, CONFIG.outputFile);
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

async function estimateBpm(filePath, durationSec) {
  const sampleSeconds = Math.max(15, Math.min(CONFIG.bpmSampleSeconds, Math.floor(durationSec || CONFIG.bpmSampleSeconds)));
  const startSec = Math.max(0, Math.floor(((durationSec || sampleSeconds) - sampleSeconds) / 2));

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
    "22050",
    "-f",
    "f32le",
    "-",
  ];

  let raw;
  try {
    raw = await runCommandCapture(CONFIG.ffmpegBin, argsList, { captureBinary: true });
  } catch (err) {
    console.warn(`BPM extraction failed, using fallback for: ${path.basename(filePath)}`);
    return 120;
  }

  const sampleCount = Math.floor(raw.length / 4);
  if (sampleCount < 22050 * 5) {
    return 120;
  }

  const step = 2;
  const samples = new Array(Math.floor(sampleCount / step));
  let outIndex = 0;
  for (let i = 0; i < sampleCount; i += step) {
    samples[outIndex] = raw.readFloatLE(i * 4);
    outIndex += 1;
  }

  try {
    const mt = new MusicTempo(samples);
    if (!isPositiveNumber(mt.tempo)) {
      return 120;
    }

    const bpm = clamp(mt.tempo, 70, 190);
    return bpm;
  } catch (err) {
    return 120;
  }
}

function buildTempoAwareOrder(unplayedTracks, poolSize) {
  const remaining = [...unplayedTracks];
  const order = [];

  const firstIndex = Math.floor(Math.random() * remaining.length);
  order.push(remaining.splice(firstIndex, 1)[0]);

  while (remaining.length) {
    const current = order[order.length - 1];
    const currentBpm = isPositiveNumber(current.bpm) ? current.bpm : 120;

    const scored = remaining
      .map((track) => {
        const bpm = isPositiveNumber(track.bpm) ? track.bpm : 120;
        const diff = Math.abs(bpm - currentBpm);
        return { track, diff };
      })
      .sort((a, b) => a.diff - b.diff);

    const pool = scored.slice(0, Math.max(1, Math.min(poolSize, scored.length)));
    const pick = pool[Math.floor(Math.random() * pool.length)].track;

    order.push(pick);
    remaining.splice(
      remaining.findIndex((x) => x.id === pick.id),
      1
    );
  }

  return order;
}

function buildTempoPlan(order) {
  const plan = [];

  for (let i = 0; i < order.length; i += 1) {
    const track = order[i];
    const originalBpm = isPositiveNumber(track.bpm) ? track.bpm : 120;

    if (i === 0) {
      plan.push({
        track,
        originalBpm,
        adjustedBpm: originalBpm,
        tempoFactor: 1,
      });
      continue;
    }

    const prev = plan[i - 1];
    const desired = prev.adjustedBpm;
    const rawFactor = desired / originalBpm;
    const tempoFactor = rawFactor;

    plan.push({
      track,
      originalBpm,
      adjustedBpm: originalBpm * tempoFactor,
      tempoFactor,
    });
  }

  return plan;
}

async function renderTempoAdjustedStem(inputPath, outputPath, tempoFactor) {
  const tempoFilter = buildAtempoFilter(tempoFactor);
  const filter = `${tempoFilter},aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo`;

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

function pickRandomTransition() {
  return TRANSITIONS[Math.floor(Math.random() * TRANSITIONS.length)];
}

function applyTransitionSettings(transition, prevDurationSec, nextDurationSec) {
  const maxAllowed = Math.min(prevDurationSec * 0.35, nextDurationSec * 0.35);
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

async function renderTransitionMix({ prevMixPath, nextPath, outputPath, prevDurationSec, nextDurationSec, transition }) {
  const td = transition.durationSec;

  if (!isPositiveNumber(td) || td <= 0.5 || prevDurationSec <= td || nextDurationSec <= td) {
    await renderConcatMix(prevMixPath, nextPath, outputPath);
    transition.durationSec = 0;
    transition.name = `${transition.name} (fallback concat)`;
    return;
  }

  const prevFadeStart = Math.max(0, prevDurationSec - td);
  const delayMs = Math.max(0, Math.round(prevFadeStart * 1000));

  const graph = [
    `[0:a]aformat=sample_rates=48000:sample_fmts=fltp:channel_layouts=stereo,atrim=0:${fmt(prevDurationSec)},asetpts=PTS-STARTPTS,afade=t=out:st=${fmt(prevFadeStart)}:d=${fmt(td)}[a0]`,
    `[1:a]aformat=sample_rates=48000:sample_fmts=fltp:channel_layouts=stereo,atrim=0:${fmt(nextDurationSec)},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${fmt(td)},adelay=${delayMs}|${delayMs}[a1]`,
    `[a0][a1]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.98[outa]`,
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
