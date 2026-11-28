/**
 * Captures the built showcase with a real browser, through the DevTools protocol.
 *
 * Two reasons not to use `--screenshot`: the capture has to press a card, and a synthetic DOM click
 * does not satisfy react-native-web's Pressable, which listens to real pointer input; and the page
 * is served over loopback because a sandboxed Chromium is not reliable with `file://` modules.
 *
 *   node .showcase/shoot.mjs docs/images/screenshot.png 1440 2
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, extname } from "node:path";
import { tmpdir } from "node:os";

const out = process.argv[2] ?? "docs/images/screenshot.png";
const width = Number(process.argv[3] ?? 1440);
const scale = Number(process.argv[4] ?? 2);
const pageName = process.argv[5] ?? "index.html";
const port = 9223;

const dir = new URL(".", import.meta.url).pathname;
const profile = mkdtempSync(join(tmpdir(), "tallimeter-shot-"));

/** The smallest static server that can serve the harness: an HTML page and its bundle. */
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".png": "image/png", ".css": "text/css" };
const server = createServer((request, response) => {
  const name = (request.url ?? "/").split("?")[0].replace(/^\//, "") || "index.html";
  try {
    const body = readFileSync(join(dir, name));
    response.writeHead(200, { "content-type": TYPES[extname(name)] ?? "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404).end("not found");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + server.address().port;

const browser = spawn(
  process.env.BRAVE_PATH ?? "brave",
  [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--hide-window",
    "--remote-debugging-port=" + port,
    "--user-data-dir=" + profile,
    "--window-size=" + width + ",1000",
    origin + "/" + pageName,
  ],
  { stdio: "ignore", detached: true },
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function target(timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch("http://127.0.0.1:" + port + "/json/list")).json();
      const found = list.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl);
      if (found) return found;
    } catch {
      // The browser is still starting.
    }
    await sleep(200);
  }
  throw new Error("the browser did not expose a debuggable page");
}

let nextId = 0;
function makeSend(socket) {
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const resolve = pending.get(message.id);
    if (resolve) {
      pending.delete(message.id);
      resolve(message.result ?? message.error);
    }
  });
  return (method, params) =>
    new Promise((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });
}

const found = await target();
const socket = new WebSocket(found.webSocketDebuggerUrl);
await new Promise((resolve) => socket.addEventListener("open", resolve));
const send = makeSend(socket);

await send("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: scale, mobile: false });
await sleep(2000);

// Press the first account card with the browser's own input pipeline, then let it render. Two
// attempts: the first may land before the screen has laid out.
for (let attempt = 0; attempt < 3; attempt += 1) {
  const rect = await send("Runtime.evaluate", {
    expression:
      '(() => {' +
      ' const card = document.querySelector(\'button[aria-label*="spent this cycle"]\');' +
      ' if (!card) return null;' +
      ' const box = card.getBoundingClientRect();' +
      ' return { x: box.left + 30, y: box.top + 18 };' +
      '})()',
    returnByValue: true,
  });
  const point = rect && rect.result ? rect.result.value : null;
  if (!point) {
    await sleep(800);
    continue;
  }
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", {
      type,
      x: point.x,
      y: point.y,
      button: "left",
      buttons: type === "mousePressed" ? 1 : 0,
      clickCount: 1,
    });
    await sleep(120);
  }
  await sleep(700);
  break;
}

// Wait until the root actually holds the screen: a capture of an empty div is a bug that looks
// like a screenshot of a blank page.
const deadline = Date.now() + 20_000;
let content = { width, height: 800 };
while (Date.now() < deadline) {
  const measured = await send("Runtime.evaluate", {
    expression:
      '(() => {' +
      ' const root = document.getElementById("root");' +
      ' return { width: root ? root.scrollWidth : 0, height: root ? root.scrollHeight : 0, nodes: root ? root.childElementCount : 0 };' +
      '})()',
    returnByValue: true,
  });
  const value = measured && measured.result ? measured.result.value : null;
  if (value && value.nodes > 0 && value.height > 300) {
    content = value;
    break;
  }
  await sleep(250);
}

// Grow the viewport to the content, so the capture has no dead space and no scrollbar.
const height = Math.min(Math.max(content.height, 400), 3000);
await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false });
await sleep(600);

const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
if (!shot || !shot.data) throw new Error("the screenshot came back empty");
writeFileSync(out, Buffer.from(shot.data, "base64"));

console.log("captured " + out + ": " + width + "x" + height + " @" + scale + "x (content " + content.width + "x" + content.height + ", " + content.nodes + " nodes)");
socket.close();
server.close();
try {
  process.kill(-browser.pid, "SIGTERM");
} catch {
  browser.kill("SIGTERM");
}
