#!/usr/bin/env node
//
// emulator-grpc.js - gRPC client for Vela emulator control
//
// Usage:
//   node emulator-grpc.js [--port <port>] <command> [args...]
//
// Commands:
//   screenshot [output.png]          Take a screenshot
//   click <x> <y>                    Mouse click (use this for UI elements)
//   tap <x> <y>                      Touch tap (may not trigger onclick)
//   swipe <x1> <y1> <x2> <y2> [ms]  Swipe gesture
//   status                           Show emulator status
//
// Options:
//   --port <port>         gRPC port (default: auto-detect or 8554)
//   --proto-dir <dir>     Path to proto files (default: auto-detect from AIoT IDE)
//   -h, --help            Show this help
//
// Environment variables:
//   GRPC_PORT             gRPC port (overridden by --port)
//   VELA_PROTO_DIR        Path to proto files (overridden by --proto-dir)
//

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// --- Parse options before command ---
const rawArgs = process.argv.slice(2);
let grpcPort = process.env.GRPC_PORT || "";
let protoDir = process.env.VELA_PROTO_DIR || "";
const commandArgs = [];

for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === "--port" && i + 1 < rawArgs.length) {
    grpcPort = rawArgs[++i];
  } else if (rawArgs[i] === "--proto-dir" && i + 1 < rawArgs.length) {
    protoDir = rawArgs[++i];
  } else if (rawArgs[i] === "-h" || rawArgs[i] === "--help") {
    const lines = fs.readFileSync(__filename, "utf8").split("\n");
    for (let j = 1; j < lines.length; j++) {
      if (!lines[j].startsWith("//")) break;
      console.log(lines[j].replace(/^\/\/ ?/, ""));
    }
    process.exit(0);
  } else {
    commandArgs.push(rawArgs[i]);
  }
}

// --- Auto-detect proto dir ---
function findProtoDir() {
  if (protoDir && fs.existsSync(protoDir)) return protoDir;

  // Search common AIoT IDE extension locations
  const home = process.env.HOME || process.env.USERPROFILE;
  const searchPaths = [
    path.join(home, ".aiot-ide/extensions"),
    path.join(home, ".vscode/extensions"),
    "/Applications/AIoT IDE.app/Contents/Resources/app/extensions",
  ];

  for (const base of searchPaths) {
    if (!fs.existsSync(base)) continue;
    try {
      const dirs = fs.readdirSync(base).filter((d) => d.startsWith("vela.aiot-emulator"));
      for (const d of dirs) {
        const p = path.join(base, d, "proto");
        if (fs.existsSync(path.join(p, "emulator_controller.proto"))) return p;
      }
    } catch {}
  }

  console.error("ERROR: Could not find emulator proto files.");
  console.error("Set VELA_PROTO_DIR or use --proto-dir <path>");
  console.error("Proto files are in: <AIoT IDE extensions>/vela.aiot-emulator-*/proto/");
  process.exit(1);
}

// --- Auto-detect gRPC port ---
function detectGrpcPort() {
  if (grpcPort) return parseInt(grpcPort);
  try {
    const lsof = execSync("lsof -i -P 2>/dev/null | grep qemu | grep LISTEN", { encoding: "utf8" });
    if (lsof.includes(":8554")) return 8554;
    const ports = [];
    for (const line of lsof.split("\n")) {
      const m = line.match(/:(\d+)\s+\(LISTEN\)/);
      if (m) ports.push(parseInt(m[1]));
    }
    const grpcPorts = ports.filter((p) => p > 8000);
    if (grpcPorts.length > 0) return grpcPorts[0];
  } catch {}
  return 8554;
}

// --- Load dependencies ---
let grpc, protoLoader;
try {
  grpc = require("@grpc/grpc-js");
  protoLoader = require("@grpc/proto-loader");
} catch {
  const scriptDir = path.dirname(__filename);
  try {
    grpc = require(path.join(scriptDir, "node_modules/@grpc/grpc-js"));
    protoLoader = require(path.join(scriptDir, "node_modules/@grpc/proto-loader"));
  } catch {
    console.error("ERROR: @grpc/grpc-js not found. Run: cd scripts && npm install");
    process.exit(1);
  }
}

const PROTO_DIR = findProtoDir();
const PROTO_FILE = path.join(PROTO_DIR, "emulator_controller.proto");
const GRPC_PORT = detectGrpcPort();
const GRPC_ADDR = `localhost:${GRPC_PORT}`;

const packageDefinition = protoLoader.loadSync(PROTO_FILE, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [PROTO_DIR],
});

const proto = grpc.loadPackageDefinition(packageDefinition);
const EmulatorController = proto.android.emulation.control.EmulatorController;

function getClient() {
  return new EmulatorController(GRPC_ADDR, grpc.credentials.createInsecure());
}

function takeScreenshot(outputPath) {
  return new Promise((resolve, reject) => {
    const client = getClient();
    client.getScreenshot({ format: "PNG", width: 0, height: 0 }, (err, response) => {
      if (err) { reject(new Error(`gRPC getScreenshot failed: ${err.message}`)); return; }
      if (!response || !response.image || response.image.length === 0) {
        reject(new Error("Empty screenshot (display may be inactive)")); return;
      }
      fs.writeFileSync(outputPath, response.image);
      const fmt = response.format || {};
      console.log(JSON.stringify({
        status: "ok", path: outputPath, size: response.image.length,
        width: fmt.width || "unknown", height: fmt.height || "unknown",
      }));
      resolve(outputPath);
      client.close();
    });
  });
}

function sendMouseClick(x, y) {
  return new Promise((resolve, reject) => {
    const client = getClient();
    client.sendMouse({ x, y, buttons: 1, display: 0 }, (err) => {
      if (err) { reject(err); return; }
      setTimeout(() => {
        client.sendMouse({ x, y, buttons: 0, display: 0 }, (err2) => {
          if (err2) { reject(err2); return; }
          console.log(JSON.stringify({ status: "ok", action: "click", x, y }));
          resolve();
          client.close();
        });
      }, 80);
    });
  });
}

function sendTouch(x, y) {
  return new Promise((resolve, reject) => {
    const client = getClient();
    client.sendTouch({ touches: [{ x, y, identifier: 0 }], display: 0 }, (err) => {
      if (err) { reject(new Error(`sendTouch failed: ${err.message}`)); return; }
      setTimeout(() => {
        client.sendTouch({ touches: [], display: 0 }, (err2) => {
          if (err2) { reject(new Error(`sendTouch release failed: ${err2.message}`)); return; }
          console.log(JSON.stringify({ status: "ok", action: "tap", x, y }));
          resolve();
          client.close();
        });
      }, 80);
    });
  });
}

function sendSwipe(x1, y1, x2, y2, durationMs) {
  return new Promise((resolve, reject) => {
    const client = getClient();
    const steps = Math.max(5, Math.floor(durationMs / 30));
    let step = 0;
    function nextStep() {
      const t = step / steps;
      const cx = Math.round(x1 + (x2 - x1) * t);
      const cy = Math.round(y1 + (y2 - y1) * t);
      client.sendTouch({ touches: [{ x: cx, y: cy, identifier: 0, pressure: 1 }], display: 0 }, (err) => {
        if (err) { reject(err); return; }
        step++;
        if (step <= steps) {
          setTimeout(nextStep, durationMs / steps);
        } else {
          client.sendTouch({ touches: [{ x: x2, y: y2, identifier: 0, pressure: 0 }], display: 0 }, () => {
            console.log(JSON.stringify({ status: "ok", action: "swipe", from: { x: x1, y: y1 }, to: { x: x2, y: y2 }, steps }));
            resolve();
            client.close();
          });
        }
      });
    }
    nextStep();
  });
}

function getStatus() {
  return new Promise((resolve, reject) => {
    const client = getClient();
    client.getStatus({}, (err, response) => {
      if (err) { reject(new Error(`getStatus failed: ${err.message}`)); return; }
      console.log(JSON.stringify(response, null, 2));
      resolve(response);
      client.close();
    });
  });
}

async function main() {
  const command = commandArgs[0];
  if (!command) {
    console.error("Usage: emulator-grpc.js [--port <port>] <screenshot|click|tap|swipe|status> [args...]");
    console.error("Use --help for full usage");
    process.exit(1);
  }

  try {
    switch (command) {
      case "screenshot":
        await takeScreenshot(commandArgs[1] || "/tmp/emulator_screenshot.png");
        break;
      case "click":
        await sendMouseClick(parseInt(commandArgs[1]), parseInt(commandArgs[2]));
        break;
      case "touch":
      case "tap":
        await sendTouch(parseInt(commandArgs[1]), parseInt(commandArgs[2]));
        break;
      case "swipe":
        await sendSwipe(
          parseInt(commandArgs[1]), parseInt(commandArgs[2]),
          parseInt(commandArgs[3]), parseInt(commandArgs[4]),
          parseInt(commandArgs[5]) || 300
        );
        break;
      case "status":
        await getStatus();
        break;
      default:
        console.error(`Unknown command: ${command}. Use --help for usage`);
        process.exit(1);
    }
  } catch (err) {
    console.error("ERROR:", err.message);
    process.exit(1);
  }
}

main();
