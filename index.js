/**
 * StarhubXbot — WhatsApp bot + optional web dashboard
 *
 * Run:  node index.js
 *   → pick Bot only / Bot + Web UI
 *   → web mode: credentials → start server → phone + pairing
 *   → after pairing: optional Cloudflare tunnel (URL → Message Yourself)
 *   → uses project-local node_modules only (like a venv)
 */

const fs = require("fs");
const path = require("path");
const { execSync, spawn } = require("child_process");
const dns = require("dns");
const readline = require("readline");

dns.setServers(["8.8.8.8", "1.1.1.1", "8.8.4.4"]);

process.chdir(__dirname);
process.env.NODE_PATH = path.join(__dirname, "node_modules");
try {
  module.paths.unshift(path.join(__dirname, "node_modules"));
} catch (_) {}

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  brightGreen: "\x1b[92m",
  cyan: "\x1b[36m",
  brightCyan: "\x1b[96m",
  yellow: "\x1b[33m",
  brightYellow: "\x1b[93m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  white: "\x1b[97m",
};

function paint(color, text) {
  return `${color}${text}${C.reset}`;
}
function box(lines, title) {
  const width =
    Math.max(title ? title.length + 4 : 0, ...lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").length)) + 2;
  console.log(paint(C.brightCyan, "╔" + "═".repeat(width) + "╗"));
  if (title) {
    const pad = width - title.length - 2;
    const left = Math.floor(pad / 2);
    console.log(
      paint(C.brightCyan, "║") +
        " ".repeat(left + 1) +
        paint(C.bold + C.brightGreen, title) +
        " ".repeat(pad - left + 1) +
        paint(C.brightCyan, "║")
    );
    console.log(paint(C.brightCyan, "╟" + "─".repeat(width) + "╢"));
  }
  for (const raw of lines) {
    const plain = raw.replace(/\x1b\[[0-9;]*m/g, "");
    console.log(
      paint(C.brightCyan, "║") +
        " " +
        raw +
        " ".repeat(Math.max(0, width - plain.length - 1)) +
        paint(C.brightCyan, "║")
    );
  }
  console.log(paint(C.brightCyan, "╚" + "═".repeat(width) + "╝"));
}
function info(msg) {
  console.log(paint(C.cyan, "  ⓘ  ") + msg);
}
function ok(msg) {
  console.log(paint(C.brightGreen, "  ✓  ") + msg);
}
function warn(msg) {
  console.log(paint(C.brightYellow, "  ⚠  ") + msg);
}
function fail(msg) {
  console.log(paint(C.red, "  ✗  ") + msg);
}
function step(msg) {
  console.log(paint(C.magenta, "  »  ") + msg);
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(paint(C.brightCyan, "  → ") + question, (answer) => {
      rl.close();
      resolve((answer || "").trim());
    })
  );
}

function askHidden(question) {
  return ask(question + " (hidden if terminal supports it): ");
}

function depsSatisfied() {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));
  return Object.keys(pkg.dependencies || {}).every((name) => {
    try {
      require.resolve(name, { paths: [path.join(__dirname, "node_modules"), __dirname] });
      return true;
    } catch {
      return false;
    }
  });
}

function ensureDependencies() {
  if (depsSatisfied()) {
    ok("Using project-local node_modules (isolated).");
    return;
  }
  step("Installing dependencies into ./node_modules only…");
  try {
    execSync("npm install --no-fund --no-audit --prefix .", {
      stdio: "inherit",
      cwd: __dirname,
      env: { ...process.env, npm_config_prefix: __dirname },
    });
  } catch {
    fail("npm install failed. Run: npm install  inside this folder, then retry.");
    process.exit(1);
  }
  ok("Dependencies installed locally.");
}

function parseCliMode(args) {
  if (args.includes("--bot")) return "bot";
  if (args.includes("--web_bot") || args.includes("--web")) return "web_bot";
  return null;
}

async function pickModeInteractive() {
  console.log();
  box(
    [
      paint(C.white, "How do you want to run StarhubXbot?"),
      "",
      paint(C.brightGreen, "  [1]") + "  Bot only          " + paint(C.dim, "(WhatsApp, no website)"),
      paint(C.brightGreen, "  [2]") + "  Bot + Web UI      " + paint(C.dim, "(dashboard + optional tunnel)"),
      "",
      paint(C.dim, "Tip: node index.js --bot   or   node index.js --web"),
    ],
    "LAUNCH MODE"
  );
  console.log();
  while (true) {
    const ans = await ask("Choose 1 or 2: ");
    if (ans === "1" || /^bot$/i.test(ans)) return "bot";
    if (ans === "2" || /^web/i.test(ans)) return "web_bot";
    warn("Please type 1 or 2.");
  }
}

function writeEnv(updates) {
  const envPath = path.join(__dirname, ".env");
  let existing = {};
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (m) existing[m[1].trim()] = m[2].trim();
    }
  }
  Object.assign(existing, updates);
  const body =
    Object.entries(existing)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") + "\n";
  fs.writeFileSync(envPath, body);
}

async function setupWebCredentials() {
  console.log();
  box(
    [
      paint(C.white, "Dashboard login (saved to .env)"),
      paint(C.dim, "Required to open the web bot in a browser."),
    ],
    "WEB LOGIN"
  );
  console.log();
  const user = (await ask("Dashboard username [admin]: ")) || "admin";
  let pass = await askHidden("Dashboard password: ");
  while (!pass || pass.length < 4) {
    warn("Password must be at least 4 characters.");
    pass = await askHidden("Dashboard password: ");
  }
  writeEnv({ ADMIN_USER: user, ADMIN_PASS: pass, PORT: process.env.PORT || "3000" });
  process.env.ADMIN_USER = user;
  process.env.ADMIN_PASS = pass;
  ok(`Saved login → user "${user}"`);
  return { user, pass };
}

function cloudflaredAvailable() {
  try {
    execSync("cloudflared --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function startCloudflared(port) {
  return new Promise((resolve) => {
    if (!cloudflaredAvailable()) {
      warn(
        "cloudflared not found. Install: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/"
      );
      resolve(null);
      return;
    }
    step("Starting Cloudflare quick tunnel… (logs masked)");
    const child = spawn(
      "cloudflared",
      ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate"],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let resolved = false;
    let buffer = "";
    const onData = (buf) => {
      buffer += buf.toString();
      const m = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (m && !resolved) {
        resolved = true;
        ok("Public URL: " + m[0]);
        resolve({ url: m[0], child });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", () => {
      if (!resolved) resolve(null);
    });
    setTimeout(() => {
      if (!resolved) {
        warn("cloudflared did not return a URL in time — continuing with localhost only.");
        resolve({ url: null, child });
      }
    }, 30000);
  });
}

async function main() {
  console.log();
  box(
    [paint(C.dim, "WhatsApp multi-device companion"), paint(C.dim, "Isolated deps · pairing · dashboard · tunnel")],
    "S T A R H U B X B O T"
  );
  console.log();

  ensureDependencies();
  require("dotenv").config({ path: path.join(__dirname, ".env") });

  const args = process.argv.slice(2);
  let mode = parseCliMode(args);
  if (!mode) mode = await pickModeInteractive();

  console.log();
  ok(`Mode: ${mode === "bot" ? "Bot only" : "Bot + Web dashboard"}`);

  let tunnelInfo = null;
  let tunnelAsked = false;
  let tunnelWanted = null;

  if (mode === "web_bot") {
    await setupWebCredentials();
    const port = process.env.PORT || "3000";
    info("Local dashboard: http://localhost:" + port + "/login (after pairing)");
    console.log();
    box(
      [
        paint(C.white, "After WhatsApp is linked, expose the dashboard online?"),
        paint(C.dim, "Uses Cloudflare quick tunnel. URL is sent to Message Yourself."),
      ],
      "CLOUDFLARE TUNNEL"
    );
    console.log();
    const pre = await ask("Start Cloudflare tunnel after pairing? (y/N): ");
    tunnelWanted = /^y(es)?$/i.test(pre);
    if (tunnelWanted) {
      ok("Tunnel will start automatically after pairing succeeds.");
    } else {
      info("Tunnel skipped for now. You can still use http://localhost:" + port);
    }
    console.log();
  }

  const { state } = require("./lib/state");
  const cache = require("./lib/cache");
  const { startBot, notifySelfText } = require("./lib/bot");

  if (mode === "web_bot") {
    const { startServer } = require("./lib/server");
    startServer();
  }

  step("Starting WhatsApp connection…");
  info("Phone number → pairing code will appear in the terminal.");
  console.log();

  async function startTunnelAndNotify() {
    if (mode !== "web_bot" || tunnelAsked) return;
    tunnelAsked = true;

    let want = tunnelWanted;
    if (want === null) {
      console.log();
      box(
        [
          paint(C.white, "WhatsApp is linked."),
          paint(C.dim, "Optionally put the web dashboard online via Cloudflare."),
        ],
        "WEB PANEL"
      );
      console.log();
      const tunnelAns = await ask("Start web bot panel online (Cloudflare tunnel)? (y/N): ");
      want = /^y(es)?$/i.test(tunnelAns);
    }

    if (!want) {
      const port = process.env.PORT || "3000";
      info("Panel stays local: http://localhost:" + port + "/login");
      return;
    }

    const port = process.env.PORT || "3000";
    tunnelInfo = await startCloudflared(port);
    if (tunnelInfo?.url) {
      try {
        await notifySelfText(
          "🌐 *StarhubXbot dashboard (Cloudflare)*\n\n" +
            tunnelInfo.url +
            "\n\nLogin with the username/password you set at startup."
        );
        ok("Tunnel URL sent to Message Yourself on WhatsApp.");
        info("Open that URL in a browser and log in.");
      } catch (e) {
        warn("Could not send tunnel URL to Message Yourself: " + (e.message || e));
        info("Copy this URL manually: " + tunnelInfo.url);
      }
    } else if (tunnelInfo?.child) {
      warn("Tunnel process running but no public URL yet — use localhost.");
    }
  }

  try {
    await startBot({
      onOpen: async () => {
        await startTunnelAndNotify();
      },
    });
  } catch (err) {
    fail("Fatal error starting bot: " + (err.message || err));
    process.exit(1);
  }

  const poll = setInterval(() => {
    if (mode === "web_bot" && !tunnelAsked && state.status === "open") {
      startTunnelAndNotify().catch(() => {});
      clearInterval(poll);
    }
    if (tunnelAsked) clearInterval(poll);
  }, 2000);
  setTimeout(() => clearInterval(poll), 120000);

  function shutdown() {
    if (tunnelInfo?.child) {
      try {
        tunnelInfo.child.kill();
      } catch (_) {}
    }
    cache.flushSave(() => ({
      chats: [...state.chats.values()],
      messages: state.messages,
      contacts: [...(state.contacts?.values?.() || [])],
      statuses: state.statuses || [],
      settings: state.settings,
      menuSent: state.menuSent,
    }));
    console.log();
    ok("Shutting down. Session saved.");
    process.exit(0);
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
