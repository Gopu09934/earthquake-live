#!/bin/bash
set -euo pipefail

#############################################
# Validate required environment
#############################################
if [ -z "${YOUTUBE_STREAM_KEY:-}" ]; then
    echo "ERROR: YOUTUBE_STREAM_KEY is not set"
    exit 1
fi

WIDTH="${STREAM_WIDTH:-1280}"
HEIGHT="${STREAM_HEIGHT:-720}"
FPS="${STREAM_FPS:-24}"
DISPLAY_NUM=99
export DISPLAY=":${DISPLAY_NUM}"

echo "========================================"
echo "EQ Watch -> YouTube Live"
echo "Resolution : ${WIDTH}x${HEIGHT}"
echo "FPS        : ${FPS}"
echo "========================================"

#############################################
# 1. Virtual display
#############################################
echo "Starting Xvfb on display :${DISPLAY_NUM}..."
Xvfb ":${DISPLAY_NUM}" -screen 0 "${WIDTH}x${HEIGHT}x24" -nolisten tcp &
XVFB_PID=$!
sleep 2

#############################################
# 2. Local static server for the dashboard
#    (fetch() of data/*.json needs a real http:// origin, not file://)
#############################################
echo "Starting local dashboard server on :8080..."
python3 -m http.server 8080 --directory /app/site --bind 127.0.0.1 &
HTTP_PID=$!
sleep 1

#############################################
# 3. Chromium, rendering the dashboard, on the virtual display
#############################################
echo "Launching Chromium via Puppeteer..."
DASHBOARD_URL="${DASHBOARD_URL:-http://localhost:8080/index.html}" \
    node /app/render.js "$WIDTH" "$HEIGHT" &
RENDER_PID=$!

# give Chromium time to launch, load the page, and complete its first
# live data fetch before ffmpeg starts capturing frames
sleep 10

cleanup() {
    echo "Shutting down..."
    kill "$RENDER_PID" "$HTTP_PID" "$XVFB_PID" 2>/dev/null || true
    wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

#############################################
# 4. Optional looping background audio (same convention as the video
#    stream project — comma-separated URLs, looped in-memory)
#
#    IMPORTANT: this deliberately avoids ffmpeg's usual "-stream_loop -1"
#    approach. That works by seeking back to byte 0 and reopening the
#    input once it hits EOF — and in this container that seek is denied
#    outright ("Seek to start failed. / Operation not permitted"), even
#    against a fully local file. Whatever's sandboxing this environment
#    is blocking the reopen/seek syscall itself, not just remote access,
#    so no amount of "make it local" fixes that path.
#
#    Instead: read each track forward exactly once (no seeking involved
#    in a straight sequential read), and hand the result to ffmpeg's
#    `aloop` filter, which buffers the decoded audio in memory and loops
#    it there — no further file I/O, so there's nothing left to deny.
#############################################
AUDIO_INPUT_ARGS=(-f lavfi -i "anullsrc=r=44100:cl=stereo")
AUDIO_FILTER_ARGS=()
AUDIO_MAP="1:a"

if [ -n "${AUDIO_URL:-}" ]; then
    CACHE_DIR="/tmp/audio_cache"
    mkdir -p "$CACHE_DIR"
    PLAYLIST="/tmp/audio_playlist.txt"
    echo "ffconcat version 1.0" > "$PLAYLIST"

    idx=0
    TRACK_FILES=()
    IFS=',' read -ra RAW_AUDIO_URLS <<< "$AUDIO_URL"
    for a in "${RAW_AUDIO_URLS[@]}"; do
        a="${a#"${a%%[![:space:]]*}"}"
        a="${a%"${a##*[![:space:]]}"}"
        [ -n "$a" ] || continue
        idx=$((idx + 1))

        if [[ "$a" =~ ^https?:// ]]; then
            ext="${a##*.}"
            # strip any query string from the extension guess
            ext="${ext%%\?*}"
            [[ "$ext" =~ ^[A-Za-z0-9]{1,5}$ ]] || ext="audio"
            local_file="${CACHE_DIR}/track_${idx}.${ext}"
            echo "Downloading background audio track ${idx}: ${a}"
            if curl -fsSL --retry 3 --retry-delay 2 -o "$local_file" "$a"; then
                a="$local_file"
            else
                echo "WARNING: failed to download ${a} — skipping this track."
                continue
            fi
        fi

        # local path (either given directly, or just downloaded above)
        if [ ! -f "$a" ]; then
            echo "WARNING: audio track not found on disk: ${a} — skipping."
            continue
        fi

        TRACK_FILES+=("$a")
        esc="${a//\'/\'\\\'\'}"
        echo "file '${esc}'" >> "$PLAYLIST"
    done

    if [ "${#TRACK_FILES[@]}" -eq 1 ]; then
        # Single track — use it as-is, no re-encode needed.
        COMBINED_FILE="${TRACK_FILES[0]}"
        echo "Background audio enabled from AUDIO_URL (1 track, looped in-memory)."
        AUDIO_INPUT_ARGS=(-i "$COMBINED_FILE")
        AUDIO_FILTER_ARGS=(-af "aloop=loop=-1:size=2000000000")
    elif [ "${#TRACK_FILES[@]}" -gt 1 ]; then
        # Multiple tracks — concatenate once into a single local file.
        # This is a plain forward sequential read (no seeking), so it's
        # unaffected by the seek restriction above.
        COMBINED_FILE="${CACHE_DIR}/combined.wav"
        echo "Pre-concatenating ${#TRACK_FILES[@]} audio track(s) into a single local file..."
        if ffmpeg -y -hide_banner -loglevel error -f concat -safe 0 -i "$PLAYLIST" \
            -ar 44100 -ac 2 -c:a pcm_s16le "$COMBINED_FILE"; then
            echo "Background audio enabled from AUDIO_URL (${#TRACK_FILES[@]} tracks, looped in-memory)."
            AUDIO_INPUT_ARGS=(-i "$COMBINED_FILE")
            AUDIO_FILTER_ARGS=(-af "aloop=loop=-1:size=2000000000")
        else
            echo "WARNING: failed to pre-concatenate audio tracks — streaming silent audio."
        fi
    else
        echo "NOTICE: AUDIO_URL set but no tracks could be downloaded/found — streaming silent audio."
    fi
else
    echo "NOTICE: AUDIO_URL not set — streaming with a silent audio track (YouTube requires an audio stream)."
fi

#############################################
# 5. ffmpeg: capture the X11 display, push to YouTube RTMP
#    Retries a few times on transient failure before giving up (the
#    outer GitHub Actions restart/watchdog workflows handle recovery
#    beyond that).
#############################################
MAX_RETRIES="${MAX_RETRIES:-3}"
RETRY_DELAY="${RETRY_DELAY:-5}"
attempt=1

while [ "$attempt" -le "$MAX_RETRIES" ]; do
    echo "----------------------------------------"
    echo "Starting ffmpeg capture (attempt ${attempt}/${MAX_RETRIES})..."
    echo "----------------------------------------"

    set +e
    ffmpeg \
        -hide_banner \
        -loglevel warning \
        -stats \
        -nostdin \
        -f x11grab -draw_mouse 0 -video_size "${WIDTH}x${HEIGHT}" -framerate "${FPS}" -i "${DISPLAY}.0" \
        "${AUDIO_INPUT_ARGS[@]}" \
        "${AUDIO_FILTER_ARGS[@]}" \
        -c:v libx264 \
        -preset veryfast \
        -tune zerolatency \
        -pix_fmt yuv420p \
        -b:v 3000k \
        -maxrate 3000k \
        -bufsize 6000k \
        -g $((FPS * 2)) \
        -keyint_min $((FPS * 2)) \
        -sc_threshold 0 \
        -c:a aac \
        -b:a 128k \
        -ar 44100 \
        -ac 2 \
        -map 0:v \
        -map "${AUDIO_MAP}" \
        -f flv \
        "rtmp://a.rtmp.youtube.com/live2/${YOUTUBE_STREAM_KEY}"
    exit_code=$?
    set -e

    if [ "$exit_code" -eq 0 ]; then
        echo "ffmpeg exited normally."
        break
    fi

    echo "WARNING: ffmpeg exited with code ${exit_code} (attempt ${attempt}/${MAX_RETRIES})."
    attempt=$((attempt + 1))

    # Chromium may have died along with a bad capture — check and relaunch if needed.
    if ! kill -0 "$RENDER_PID" 2>/dev/null; then
        echo "Chromium process is no longer running — relaunching..."
        DASHBOARD_URL="${DASHBOARD_URL:-http://localhost:8080/index.html}" \
            node /app/render.js "$WIDTH" "$HEIGHT" &
        RENDER_PID=$!
        sleep 8
    fi

    if [ "$attempt" -le "$MAX_RETRIES" ]; then
        echo "Retrying in ${RETRY_DELAY}s..."
        sleep "$RETRY_DELAY"
    else
        echo "ERROR: Max retries reached. Exiting — the restart/watchdog workflows will start a fresh run."
        exit 1
    fi
done
