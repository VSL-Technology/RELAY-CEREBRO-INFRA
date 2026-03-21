import fetch from "node-fetch";

const BASE_URL = (process.env.RELAY_BASE_URL || process.env.RELAY_URL || "http://localhost:3000").replace(/\/+$/, "");
const MONITOR_WAIT_MS = Number(process.env.SESSION_TEST_MONITOR_WAIT_MS || 7000);

async function readJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const payload = {
    ip: process.env.SESSION_TEST_IP || "192.168.88.50",
    mac: process.env.SESSION_TEST_MAC || "aa:bb:cc:dd:ee:ff",
    router: process.env.SESSION_TEST_ROUTER || "router-test",
    identity: process.env.SESSION_TEST_IDENTITY || "session-monitor-test"
  };

  const startResponse = await fetch(`${BASE_URL}/session/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const startBody = await readJson(startResponse);
  console.log("[session/start]", { status: startResponse.status, body: startBody });

  if (!startResponse.ok || !startBody || !startBody.sessionId) {
    process.exit(1);
  }

  const sessionId = startBody.sessionId;

  const authorizeResponse = await fetch(`${BASE_URL}/session/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId,
      plano: process.env.SESSION_TEST_PLANO || "teste",
      tempo: Number(process.env.SESSION_TEST_TEMPO || 300000)
    })
  });
  const authorizeBody = await readJson(authorizeResponse);
  console.log("[session/authorize]", { status: authorizeResponse.status, body: authorizeBody });

  if (!authorizeResponse.ok) {
    process.exit(1);
  }

  console.log("[session/monitor_wait]", { ms: MONITOR_WAIT_MS });
  await sleep(MONITOR_WAIT_MS);

  const sessionResponse = await fetch(`${BASE_URL}/session/${sessionId}`);
  const sessionBody = await readJson(sessionResponse);
  console.log("[session/get]", { status: sessionResponse.status, body: sessionBody });

  const activeResponse = await fetch(`${BASE_URL}/session/active`);
  const activeBody = await readJson(activeResponse);
  console.log("[session/active]", { status: activeResponse.status, body: activeBody });

  if (!sessionResponse.ok || !activeResponse.ok) {
    process.exit(1);
  }

  const sessionRow = activeBody && Array.isArray(activeBody.sessions)
    ? activeBody.sessions.find((item) => item && item.sessionId === sessionId)
    : null;

  console.log("[session/active:matched]", sessionRow || null);

  if (!sessionRow) {
    console.error("[sessionTest] session not found in /session/active");
    process.exit(1);
  }

  if (process.env.SESSION_TEST_EXPECT_ACTIVE === "true" && sessionRow.active !== true) {
    console.error("[sessionTest] expected active=true after monitor sync");
    process.exit(1);
  }

  if (process.env.SESSION_TEST_EXPECT_ACTIVE === "false" && sessionRow.active !== false) {
    console.error("[sessionTest] expected active=false after monitor sync");
    process.exit(1);
  }

  console.log("[sessionTest] disconnect the client and rerun with SESSION_TEST_EXPECT_ACTIVE=false to validate deactivation");
}

main().catch((error) => {
  console.error("[sessionTest] unexpected_error", error);
  process.exit(1);
});
