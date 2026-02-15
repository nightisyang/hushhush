const http = require("http");
const { execFile } = require("child_process");
const path = require("path");
const fs = require("fs");

const OUTPUT = path.join(__dirname, "current-noise.wav");
const TEMP = path.join(__dirname, "temp-noise.wav");
const PORT = 3457;
const DURATION = 300; // 5 minutes
const FADE = 5;       // crossfade seconds

http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (req.method !== "POST" || req.url !== "/generate") {
    res.writeHead(404); res.end(); return;
  }

  let body = "";
  req.on("data", (c) => body += c);
  req.on("end", () => {
    let params;
    try { params = JSON.parse(body); } catch { res.writeHead(400); res.end(); return; }

    const { color = "white", lowCut = 0, highCut = 20000, modulation = 0, modSpeed = 15 } = params;

    let srcColor = color;
    const filters = [];

    if (color === "blue") {
      srcColor = "white";
      filters.push("highpass=f=1000:poles=2");
    } else if (color === "violet") {
      srcColor = "white";
      filters.push("highpass=f=2000:poles=4");
    }

    if (lowCut > 0) filters.push(`highpass=f=${lowCut}`);
    if (highCut < 20000) filters.push(`lowpass=f=${highCut}`);

    if (modulation > 0) {
      const freq = (0.05 + (modSpeed / 100) * 1.95).toFixed(3);
      const depth = (modulation / 100 * 0.8).toFixed(3);
      filters.push(`tremolo=f=${freq}:d=${depth}`);
    }

    // Add fade out at end and fade in at start for seamless looping
    filters.push(`afade=t=in:st=0:d=${FADE}`);
    filters.push(`afade=t=out:st=${DURATION - FADE}:d=${FADE}`);

    const args = [
      "-y", "-f", "lavfi",
      "-i", `anoisesrc=color=${srcColor}:duration=${DURATION}:sample_rate=44100`,
    ];
    if (filters.length) args.push("-af", filters.join(","));
    args.push("-ac", "1", "-acodec", "pcm_s16le", OUTPUT);

    execFile("ffmpeg", args, { timeout: 60000 }, (err) => {
      if (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
}).listen(PORT, () => console.log(`Noise generator listening on :${PORT}`));
