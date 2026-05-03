// Nimbus overlay around the upstream openclaw-umbrel setup server.
//
// Five things, in order at startup:
//   1. Replace the "OpenClaw on Umbrel" branding string in setup.html with
//      "OpenClaw on AI Lab", and inject a model-pull banner.
//   2. Add an HTTP route /api/nimbus/lemonade-status that the banner polls
//      to know when the Lemonade model is registered + downloaded.
//   3. Hijack node-pty's spawn so that IF the wizard ever runs (fallback
//      when non-interactive onboard fails) it launches with Lemonade
//      preselection flags.
//   4. Run `openclaw onboard --non-interactive ...` synchronously if we
//      have not already onboarded. With this in place, isConfigured()
//      returns true on the first request, the wizard never appears, and
//      the user is redirected straight to the gateway.
//   5. Patch /data/.openclaw/openclaw.json with Nimbus-specific tuning
//      (context window, model max tokens, cost zeros). Idempotent — runs
//      every boot so config values stay aligned with env overrides.
//
// We require() the upstream /app/setup-server.cjs at the bottom rather than
// duplicating its contents, so upstream image bumps don't drift out of sync.

const fs = require("fs");
const { spawnSync } = require("child_process");

const SETUP_HTML = "/app/setup.html";
const CONFIG_DIR = "/data/.openclaw";
const CONFIG_FILE = `${CONFIG_DIR}/openclaw.json`;
const GATEWAY_PORT = "18790"; // matches OPENCLAW_PORT in upstream setup-server.cjs
const PROVIDER_ID = "lemonade";
const LEMONADE_BASE_URL =
  process.env.NIMBUS_LEMONADE_BASE_URL || "http://host.docker.internal:13305";
const MODEL_ID =
  process.env.NIMBUS_OPENCLAW_MODEL_ID || "user.Qwen3.5-9B-GGUF";
const CONTEXT_TOKENS = parseInt(
  process.env.NIMBUS_OPENCLAW_CONTEXT_TOKENS || "190000",
  10
);
const MAX_TOKENS = parseInt(
  process.env.NIMBUS_OPENCLAW_MAX_TOKENS || "64000",
  10
);

// ---------------------------------------------------------------------------
// 1. setup.html mutations: branding + model-pull banner
// ---------------------------------------------------------------------------
const BANNER_HTML = `
<div id="nimbus-model-banner" style="display:none;padding:10px 14px;background:linear-gradient(90deg,#ff9800,#ffcc80);color:#1a1a1a;font-size:13px;font-weight:600;text-align:center;position:relative;z-index:100;box-shadow:0 1px 4px rgba(0,0,0,0.25);">
  <span id="nimbus-model-banner-text">Lemonade model is not ready yet.</span>
</div>
`;

// The wrapper only knows whether the model is registered in Lemonade
// (present in /api/v1/models), not whether a pull is actively in progress.
// So the banner deliberately says "not ready yet" rather than "downloading"
// — it covers both "never pulled" and "still pulling" without lying.
const BANNER_SCRIPT = `
<script>
(function(){
  var banner=document.getElementById('nimbus-model-banner');
  var text=document.getElementById('nimbus-model-banner-text');
  if(!banner||!text)return;
  var lastReady=null;
  function check(){
    fetch('/api/nimbus/lemonade-status',{cache:'no-store'}).then(function(r){
      if(!r.ok)return null;return r.json();
    }).then(function(j){
      if(!j)return;
      if(j.ready){
        if(lastReady!==true){
          banner.style.background='linear-gradient(90deg,#4caf50,#81c784)';
          text.textContent='Model ready \\u2014 OpenClaw can now respond.';
          banner.style.display='block';
          setTimeout(function(){banner.style.display='none';},4000);
          lastReady=true;
        }
      }else{
        text.textContent=j.model
          ? 'Lemonade model "'+j.model+'" is not ready yet \\u2014 OpenClaw won\\u2019t respond until it is installed and loaded.'
          : 'Lemonade model is not ready yet \\u2014 OpenClaw won\\u2019t respond until it is installed and loaded.';
        banner.style.background='linear-gradient(90deg,#ff9800,#ffcc80)';
        banner.style.display='block';
        lastReady=false;
      }
    }).catch(function(){});
  }
  check();
  setInterval(check,3000);
})();
</script>
`;

try {
  let html = fs.readFileSync(SETUP_HTML, "utf8");
  const before = html;
  html = html.replace(/OpenClaw on Umbrel/g, "OpenClaw on AI Lab");
  if (!html.includes("nimbus-model-banner")) {
    // Banner immediately after <body>; script just before </body>. Both
    // matches are in setup.html and the inserts are idempotent across
    // restarts (guarded by the includes() check above).
    html = html.replace(/<body[^>]*>/, (m) => `${m}\n${BANNER_HTML}`);
    html = html.replace("</body>", `${BANNER_SCRIPT}\n</body>`);
  }
  if (html !== before) {
    fs.writeFileSync(SETUP_HTML, html);
    console.log("[nimbus-overlay] Patched setup.html (branding + model banner)");
  }
} catch (e) {
  console.error("[nimbus-overlay] Failed to patch setup.html:", e.message);
}

// ---------------------------------------------------------------------------
// 2. HTTP route: /api/nimbus/lemonade-status
// ---------------------------------------------------------------------------
// Monkey-patch http.createServer so we can intercept /api/nimbus/* before
// upstream's request handler routes everything else to the OpenClaw gateway
// proxy. Cached after first require, so server.cjs's createServer call sees
// our wrapped factory.
const http = require("http");
const originalCreateServer = http.createServer;

async function handleLemonadeStatus(req, res) {
  const url = `${LEMONADE_BASE_URL}/api/v1/models`;
  let ready = false;
  let error = null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (r.ok) {
      const data = await r.json();
      const models = Array.isArray(data) ? data : data && data.data;
      if (Array.isArray(models)) {
        ready = models.some((m) => m && m.id === MODEL_ID);
      }
    } else {
      error = `HTTP ${r.status}`;
    }
  } catch (e) {
    error = e.message || String(e);
  }
  res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify({ ready, model: MODEL_ID, error }));
}

http.createServer = function nimbusCreateServer(handler, ...rest) {
  const wrapped = (req, res) => {
    if (req.url === "/api/nimbus/lemonade-status" && req.method === "GET") {
      handleLemonadeStatus(req, res).catch((e) => {
        try {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ready: false, error: e.message }));
        } catch (_) {}
      });
      return;
    }
    return handler(req, res);
  };
  return originalCreateServer.call(this, wrapped, ...rest);
};

// ---------------------------------------------------------------------------
// 2. node-pty spawn hijack
// ---------------------------------------------------------------------------
// node-pty is cached after first require, so patching pty.spawn here means
// the upstream server.cjs (which requires the same module) sees our wrapped
// version when it spawns the wizard.
const pty = require("/app/node_modules/node-pty");
const originalSpawn = pty.spawn;

function injectOnboardFlags(args) {
  const has = (flag) => args.includes(flag);
  const extras = [];
  const add = (flag, value) => {
    if (!has(flag)) {
      extras.push(flag);
      if (value !== undefined) extras.push(value);
    }
  };
  add("--auth-choice", "custom-api-key");
  add("--custom-base-url", `${LEMONADE_BASE_URL}/api/v1`);
  add("--custom-model-id", MODEL_ID);
  add("--custom-provider-id", PROVIDER_ID);
  add("--custom-compatibility", "openai");
  // Lemonade ignores the API key but the field is required by the wizard.
  add("--custom-api-key", PROVIDER_ID);
  add("--secret-input-mode", "plaintext");
  return [...args, ...extras];
}

pty.spawn = function nimbusPtySpawn(file, args, opts) {
  const isOnboard =
    file === "openclaw" && Array.isArray(args) && args[0] === "onboard";
  const finalArgs = isOnboard ? injectOnboardFlags(args) : args;
  if (isOnboard) {
    console.log(
      "[nimbus-overlay] Spawning openclaw onboard with Lemonade preselection"
    );
  }
  const proc = originalSpawn.call(this, file, finalArgs, opts);
  if (isOnboard && typeof proc.onExit === "function") {
    proc.onExit(({ exitCode }) => {
      if (exitCode !== 0) return;
      try {
        autoTuneConfig();
      } catch (e) {
        console.error("[nimbus-overlay] auto-tune failed:", e.message);
      }
    });
  }
  return proc;
};

// ---------------------------------------------------------------------------
// 3. Post-wizard config tuning
// ---------------------------------------------------------------------------
function autoTuneConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    console.log("[nimbus-overlay] no openclaw.json yet, skipping tune");
    return;
  }
  const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  const modelRef = `${PROVIDER_ID}/${MODEL_ID}`;

  // Upstream's isConfigured() returns false unless cfg.wizard exists, in
  // which case it skips the boot-time startOpenclaw() call and the gateway
  // never comes up. Non-interactive onboard does not always write this
  // section, so we plant a minimal marker ourselves.
  if (!cfg.wizard) {
    cfg.wizard = {
      completed: true,
      completedAt: new Date().toISOString(),
      source: "nimbus-overlay",
    };
  }

  cfg.agents = cfg.agents || {};
  const defaults = (cfg.agents.defaults = cfg.agents.defaults || {});
  if (typeof defaults.model === "string" || !defaults.model) {
    defaults.model = { primary: modelRef };
  } else {
    defaults.model.primary = modelRef;
  }
  defaults.contextTokens = CONTEXT_TOKENS;

  cfg.models = cfg.models || {};
  const providers = (cfg.models.providers = cfg.models.providers || {});
  const provider = (providers[PROVIDER_ID] = providers[PROVIDER_ID] || {});
  const models = (provider.models = provider.models || []);
  let entry = models.find(
    (m) => m && typeof m === "object" && m.id === MODEL_ID
  );
  if (!entry) {
    entry = { id: MODEL_ID, name: MODEL_ID };
    models.push(entry);
  }
  entry.contextWindow = CONTEXT_TOKENS;
  entry.maxTokens = MAX_TOKENS;
  entry.reasoning = true;
  entry.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log("[nimbus-overlay] tuned openclaw.json for Lemonade");
}

// ---------------------------------------------------------------------------
// 4. Non-interactive onboard at startup
// ---------------------------------------------------------------------------
function isAlreadyOnboarded() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return false;
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    return !!(cfg && cfg.wizard);
  } catch {
    return false;
  }
}

function runNonInteractiveOnboard() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const args = [
    "onboard",
    "--non-interactive",
    "--accept-risk",
    "--mode", "local",
    "--flow", "quickstart",
    "--skip-channels",
    "--skip-skills",
    "--skip-search",
    "--skip-daemon",
    "--skip-ui",
    "--skip-health",
    "--auth-choice", "custom-api-key",
    "--custom-base-url", `${LEMONADE_BASE_URL}/api/v1`,
    "--custom-model-id", MODEL_ID,
    "--custom-provider-id", PROVIDER_ID,
    "--custom-compatibility", "openai",
    "--custom-api-key", PROVIDER_ID, // lemonade ignores the value but the field is required
    "--secret-input-mode", "plaintext",
    "--gateway-port", GATEWAY_PORT,
  ];
  console.log("[nimbus-overlay] Running non-interactive openclaw onboard...");
  const r = spawnSync("openclaw", args, {
    cwd: CONFIG_DIR,
    env: { ...process.env, HOME: "/data" },
    stdio: "inherit",
    timeout: 60_000,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`openclaw onboard exited with code ${r.status}`);
  }
}

if (isAlreadyOnboarded()) {
  console.log("[nimbus-overlay] openclaw.json already has wizard section, skipping onboard");
} else {
  try {
    runNonInteractiveOnboard();
    console.log("[nimbus-overlay] non-interactive onboard complete");
  } catch (e) {
    console.error(
      "[nimbus-overlay] non-interactive onboard failed; the user will see the wizard as a fallback:",
      e.message
    );
  }
}

// Always run the tune — idempotent; ensures contextTokens / maxTokens stay
// aligned with current env overrides even across container restarts.
try {
  autoTuneConfig();
} catch (e) {
  console.error("[nimbus-overlay] auto-tune failed:", e.message);
}

// ---------------------------------------------------------------------------
// 5. Delegate to upstream
// ---------------------------------------------------------------------------
require("/app/setup-server.cjs");
