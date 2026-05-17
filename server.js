const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const ROOT = __dirname;
const SCHEDULE_PATH = path.join(ROOT, "data", "schedule.json");
const DATA_DIR = process.env.APP_DATA_DIR ? path.resolve(process.env.APP_DATA_DIR) : path.join(ROOT, "data");
const STATE_PATH = path.join(DATA_DIR, "state.json");
const RESPONSES_PATH = path.join(DATA_DIR, "responses.json");
const ADMIN_KEY_PATH = path.join(DATA_DIR, "admin-key.txt");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const CLASS_TIMEZONE = "Asia/Seoul";
const CLASS_START = "12:00";
const CLASS_END = "13:30";
const PURCHASE_STATEMENT = "I am willing to purchase this product.";

ensureDir(DATA_DIR);

const schedule = readJson(SCHEDULE_PATH, []);
const adminKey = loadAdminKey();

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return fallback;
  }
}

function writeJson(filePath, value) {
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

function loadAdminKey() {
  if (process.env.ADMIN_KEY) {
    return process.env.ADMIN_KEY.trim();
  }

  if (fs.existsSync(ADMIN_KEY_PATH)) {
    return fs.readFileSync(ADMIN_KEY_PATH, "utf8").trim();
  }

  const generated = crypto.randomBytes(24).toString("hex");
  fs.writeFileSync(ADMIN_KEY_PATH, `${generated}\n`, "utf8");
  return generated;
}

function readState() {
  return readJson(STATE_PATH, { sessions: {} });
}

function saveState(state) {
  if (!state.sessions) {
    state.sessions = {};
  }
  writeJson(STATE_PATH, state);
}

function readResponses() {
  return readJson(RESPONSES_PATH, { responses: [] });
}

function saveResponses(responses) {
  writeJson(RESPONSES_PATH, responses);
}

function send(res, statusCode, body, contentType = "text/html; charset=utf-8", extraHeaders = {}) {
  const payload = Buffer.from(body);
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Content-Length": payload.length,
    "Cache-Control": "no-store",
    ...extraHeaders
  });
  res.end(payload);
}

function sendJson(res, statusCode, body) {
  send(res, statusCode, JSON.stringify(body), "application/json; charset=utf-8");
}

function notFound(res) {
  send(res, 404, "Not found", "text/plain; charset=utf-8");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(new Error("Invalid JSON body."));
      }
    });
    req.on("error", reject);
  });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function getKstDateParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: CLASS_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });

  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    isoLike: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} KST`
  };
}

function getTodaySchedule() {
  const today = getKstDateParts().date;
  return schedule.find((entry) => entry.date === today) || null;
}

function isClassWindowOpen(nowParts = getKstDateParts()) {
  return nowParts.time >= CLASS_START && nowParts.time <= CLASS_END;
}

function presentationMap() {
  const map = new Map();
  for (const entry of schedule) {
    for (const presentation of entry.presentations || []) {
      map.set(presentation.id, {
        ...presentation,
        week: entry.week,
        date: entry.date,
        chapter: entry.chapter,
        note: entry.note
      });
    }
  }
  return map;
}

function findPresentationByCode(code, state) {
  const normalized = String(code || "").trim();
  if (!normalized) {
    return null;
  }

  const map = presentationMap();
  for (const [presentationId, session] of Object.entries(state.sessions || {})) {
    if (session.active && session.code === normalized && map.has(presentationId)) {
      return {
        presentation: map.get(presentationId),
        session
      };
    }
  }

  return null;
}

function generateCode(state) {
  const activeCodes = new Set(
    Object.values(state.sessions || {})
      .filter((session) => session.active)
      .map((session) => session.code)
  );

  let code = "";
  do {
    code = String(crypto.randomInt(100000, 1000000));
  } while (activeCodes.has(code));

  return code;
}

function isAdminRequest(url, body = {}) {
  const provided = body.key || url.searchParams.get("key") || "";
  if (!provided || provided.length !== adminKey.length) {
    return false;
  }

  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(adminKey));
}

function getClientIp(req) {
  if (process.env.TRUST_PROXY === "1" && req.headers["x-forwarded-for"]) {
    return String(req.headers["x-forwarded-for"]).split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

function hashIp(ip) {
  return crypto.createHash("sha256").update(`${ip}|${adminKey}`).digest("hex").slice(0, 16);
}

function summarizeResponses(responses) {
  const summaries = {};
  for (const entry of schedule) {
    for (const presentation of entry.presentations || []) {
      summaries[presentation.id] = {
        presentationId: presentation.id,
        week: entry.week,
        date: entry.date,
        topic: presentation.topic,
        group: presentation.group,
        count: 0,
        average: null,
        distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
      };
    }
  }

  for (const response of responses) {
    const summary = summaries[response.presentationId];
    if (!summary) {
      continue;
    }
    summary.count += 1;
    summary.distribution[response.rating] += 1;
  }

  for (const summary of Object.values(summaries)) {
    if (summary.count > 0) {
      const total = Object.entries(summary.distribution).reduce((sum, [rating, count]) => {
        return sum + Number(rating) * count;
      }, 0);
      summary.average = Number((total / summary.count).toFixed(2));
    }
  }

  return summaries;
}

function getAdminSnapshot() {
  const state = readState();
  const storedResponses = readResponses();
  return {
    schedule,
    sessions: state.sessions || {},
    responses: storedResponses.responses || [],
    summaries: summarizeResponses(storedResponses.responses || []),
    now: getKstDateParts().isoLike,
    adminUrl: `${BASE_URL}/admin?key=${encodeURIComponent(adminKey)}`
  };
}

function renderStudentPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Presentation Evaluation</title>
  <style>${baseStyles()}</style>
</head>
<body>
  <main class="student-shell">
    <section class="form-panel">
      <div class="eyebrow">Konkuk University</div>
      <h1>Presentation Evaluation</h1>
      <p class="lede">Submit your rating for the presentation currently in progress.</p>

      <div class="notice" role="note">
        Fraudulent evaluation activity or duplicate voting may result in penalties. If multiple evaluations are submitted with the same student ID for the same presentation, only the first evaluation will be recorded.
      </div>

      <form id="evaluation-form" class="stack">
        <label for="student-id">Student ID</label>
        <input id="student-id" name="studentId" inputmode="numeric" autocomplete="off" pattern="[0-9]{4,20}" maxlength="20" placeholder="Student ID" required>

        <label for="student-name">Name</label>
        <input id="student-name" name="studentName" autocomplete="name" maxlength="80" placeholder="Name" required>

        <label for="code">Presentation code</label>
        <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="6" placeholder="Six-digit code" required>

        <fieldset class="rating-field">
          <legend>${escapeHtml(PURCHASE_STATEMENT)}</legend>
          <div class="rating-scale">
            <label class="rating-option">
              <input type="radio" name="rating" value="1" required>
              <span>1</span>
              <small>Strongly disagree</small>
            </label>
            <label class="rating-option">
              <input type="radio" name="rating" value="2">
              <span>2</span>
              <small>Disagree</small>
            </label>
            <label class="rating-option">
              <input type="radio" name="rating" value="3">
              <span>3</span>
              <small>Neutral</small>
            </label>
            <label class="rating-option">
              <input type="radio" name="rating" value="4">
              <span>4</span>
              <small>Agree</small>
            </label>
            <label class="rating-option">
              <input type="radio" name="rating" value="5">
              <span>5</span>
              <small>Strongly agree</small>
            </label>
          </div>
        </fieldset>

        <button type="submit" id="submit-button">Submit Evaluation</button>
      </form>

      <p id="message" class="message" aria-live="polite"></p>
    </section>
  </main>
  <script>
    const form = document.getElementById("evaluation-form");
    const button = document.getElementById("submit-button");
    const message = document.getElementById("message");

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      button.disabled = true;
      message.textContent = "Submitting...";

      const payload = {
        studentId: document.getElementById("student-id").value.trim(),
        studentName: document.getElementById("student-name").value.trim(),
        code: document.getElementById("code").value.trim(),
        rating: document.querySelector('input[name="rating"]:checked')?.value
      };

      try {
        const response = await fetch("/api/submit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        const result = await response.json();
        if (!response.ok) {
          throw new Error(result.error || "The evaluation could not be submitted.");
        }

        document.body.innerHTML = '<main class="student-shell"><section class="form-panel center-panel"><h1>Thank you</h1><p>Your evaluation has been recorded.</p><p class="muted">This window will close automatically.</p></section></main>';
        setTimeout(() => {
          window.open("", "_self");
          window.close();
          window.location.replace("about:blank");
        }, 900);
      } catch (error) {
        button.disabled = false;
        message.textContent = error.message;
      }
    });
  </script>
</body>
</html>`;
}

function renderAdminPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Presentation Evaluation Admin</title>
  <style>${baseStyles()}</style>
</head>
<body>
  <main class="admin-shell">
    <header class="admin-header">
      <div>
        <div class="eyebrow">Instructor Console</div>
        <h1>Presentation Evaluation Admin</h1>
      </div>
      <div class="admin-actions">
        <a id="export-link" class="secondary-button" href="#">Export CSV</a>
        <button id="refresh-button" type="button" class="secondary-button">Refresh</button>
      </div>
    </header>

    <section class="toolbar-band">
      <div>
        <span class="label">Current time</span>
        <strong id="now">Loading...</strong>
      </div>
      <div>
        <span class="label">Admin URL</span>
        <code id="admin-url">Loading...</code>
      </div>
    </section>

    <section>
      <h2>Presentation Controls</h2>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Week</th>
              <th>Date</th>
              <th>Chapter</th>
              <th>Topic</th>
              <th>Group</th>
              <th>Status</th>
              <th>Code</th>
              <th>Responses</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody id="schedule-body"></tbody>
        </table>
      </div>
    </section>

    <section>
      <h2>Response Summary</h2>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Week</th>
              <th>Group</th>
              <th>Topic</th>
              <th>Count</th>
              <th>Average</th>
              <th>1</th>
              <th>2</th>
              <th>3</th>
              <th>4</th>
              <th>5</th>
            </tr>
          </thead>
          <tbody id="summary-body"></tbody>
        </table>
      </div>
    </section>

    <section>
      <h2>Recorded Responses</h2>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Submitted</th>
              <th>Week</th>
              <th>Group</th>
              <th>Student ID</th>
              <th>Name</th>
              <th>Topic</th>
              <th>Rating</th>
              <th>IP Hash</th>
            </tr>
          </thead>
          <tbody id="responses-body"></tbody>
        </table>
      </div>
    </section>
  </main>
  <script>
    const key = new URLSearchParams(window.location.search).get("key") || "";
    const scheduleBody = document.getElementById("schedule-body");
    const summaryBody = document.getElementById("summary-body");
    const responsesBody = document.getElementById("responses-body");
    const refreshButton = document.getElementById("refresh-button");
    const exportLink = document.getElementById("export-link");

    function text(value) {
      return value === undefined || value === null || value === "" ? "—" : String(value);
    }

    function badge(active) {
      return active ? '<span class="badge active">Open</span>' : '<span class="badge">Closed</span>';
    }

    function html(value) {
      return text(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }

    async function adminPost(path, payload) {
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, key })
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || "Request failed.");
      }
      return result;
    }

    async function startPresentation(id) {
      await adminPost("/api/admin/start", { presentationId: id });
      await loadAdmin();
    }

    async function stopPresentation(id) {
      await adminPost("/api/admin/stop", { presentationId: id });
      await loadAdmin();
    }

    async function resetVotes(id) {
      const confirmed = window.confirm("Reset all recorded votes for this presentation? This cannot be undone.");
      if (!confirmed) {
        return;
      }
      await adminPost("/api/admin/reset-votes", { presentationId: id });
      await loadAdmin();
    }

    function renderSchedule(snapshot) {
      scheduleBody.innerHTML = "";
      for (const week of snapshot.schedule) {
        if (!week.presentations.length) {
          const row = document.createElement("tr");
          row.innerHTML = '<td>' + week.week + '</td><td>' + week.date + '</td><td>' + week.chapter + '</td><td colspan="6">' + text(week.note) + '</td>';
          scheduleBody.appendChild(row);
          continue;
        }

        for (const presentation of week.presentations) {
          const session = snapshot.sessions[presentation.id] || {};
          const summary = snapshot.summaries[presentation.id] || {};
          const row = document.createElement("tr");
          row.innerHTML =
            '<td>' + week.week + '</td>' +
            '<td>' + week.date + '</td>' +
            '<td>' + week.chapter + '</td>' +
            '<td>' + presentation.topic + '</td>' +
            '<td>' + presentation.group + '</td>' +
            '<td>' + badge(session.active) + '</td>' +
            '<td><strong class="code-display">' + text(session.code) + '</strong></td>' +
            '<td>' + text(summary.count || 0) + '</td>' +
            '<td><button class="small-button" data-start="' + presentation.id + '">Start</button> <button class="small-button quiet" data-stop="' + presentation.id + '">Stop</button> <a class="small-button export" href="/admin/export.xls?presentationId=' + encodeURIComponent(presentation.id) + '&key=' + encodeURIComponent(key) + '">Excel</a> <button class="small-button danger" data-reset-votes="' + presentation.id + '">Reset Votes</button></td>';
          scheduleBody.appendChild(row);
        }
      }
    }

    function renderSummary(snapshot) {
      summaryBody.innerHTML = "";
      Object.values(snapshot.summaries).forEach((summary) => {
        const row = document.createElement("tr");
        row.innerHTML =
          '<td>' + summary.week + '</td>' +
          '<td>' + summary.group + '</td>' +
          '<td>' + summary.topic + '</td>' +
          '<td>' + summary.count + '</td>' +
          '<td>' + text(summary.average) + '</td>' +
          '<td>' + summary.distribution[1] + '</td>' +
          '<td>' + summary.distribution[2] + '</td>' +
          '<td>' + summary.distribution[3] + '</td>' +
          '<td>' + summary.distribution[4] + '</td>' +
          '<td>' + summary.distribution[5] + '</td>';
        summaryBody.appendChild(row);
      });
    }

    function renderResponses(snapshot) {
      responsesBody.innerHTML = "";
      const rows = [...snapshot.responses].reverse();
      if (!rows.length) {
        responsesBody.innerHTML = '<tr><td colspan="8">No responses recorded yet.</td></tr>';
        return;
      }
      rows.forEach((response) => {
        const row = document.createElement("tr");
        row.innerHTML =
          '<td>' + response.submittedAt + '</td>' +
          '<td>' + response.week + '</td>' +
          '<td>' + response.group + '</td>' +
          '<td>' + html(response.studentId) + '</td>' +
          '<td>' + html(response.studentName) + '</td>' +
          '<td>' + response.topic + '</td>' +
          '<td><strong>' + response.rating + '</strong></td>' +
          '<td><code>' + response.ipHash + '</code></td>';
        responsesBody.appendChild(row);
      });
    }

    async function loadAdmin() {
      const response = await fetch("/api/admin/state?key=" + encodeURIComponent(key));
      const snapshot = await response.json();
      if (!response.ok) {
        throw new Error(snapshot.error || "Admin access failed.");
      }

      document.getElementById("now").textContent = snapshot.now;
      document.getElementById("admin-url").textContent = snapshot.adminUrl;
      exportLink.href = "/admin/export.csv?key=" + encodeURIComponent(key);
      renderSchedule(snapshot);
      renderSummary(snapshot);
      renderResponses(snapshot);
    }

    document.addEventListener("click", async (event) => {
      const startId = event.target.getAttribute("data-start");
      const stopId = event.target.getAttribute("data-stop");
      const resetVotesId = event.target.getAttribute("data-reset-votes");
      try {
        if (startId) {
          await startPresentation(startId);
        }
        if (stopId) {
          await stopPresentation(stopId);
        }
        if (resetVotesId) {
          await resetVotes(resetVotesId);
        }
      } catch (error) {
        alert(error.message);
      }
    });

    refreshButton.addEventListener("click", () => loadAdmin().catch((error) => alert(error.message)));
    loadAdmin().catch((error) => {
      document.body.innerHTML = '<main class="student-shell"><section class="form-panel center-panel"><h1>Admin access unavailable</h1><p>' + error.message + '</p></section></main>';
    });
    setInterval(() => loadAdmin().catch(() => {}), 5000);
  </script>
</body>
</html>`;
}

function baseStyles() {
  return `
    :root {
      color-scheme: light;
      --ink: #17212b;
      --muted: #65717f;
      --line: #d8dee6;
      --surface: #ffffff;
      --page: #f4f6f8;
      --primary: #1b6b63;
      --primary-dark: #124b45;
      --accent: #b45309;
      --soft: #e8f3f1;
      --danger-soft: #fff3df;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Arial, Helvetica, sans-serif;
      color: var(--ink);
      background: var(--page);
      line-height: 1.5;
    }
    h1, h2, p { margin-top: 0; }
    h1 { font-size: 2rem; line-height: 1.15; margin-bottom: 0.7rem; letter-spacing: 0; }
    h2 { font-size: 1.15rem; margin: 1.7rem 0 0.7rem; letter-spacing: 0; }
    button, input, select {
      font: inherit;
    }
    .student-shell {
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 2rem 1rem;
    }
    .form-panel {
      width: min(100%, 520px);
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 1.4rem;
      box-shadow: 0 16px 40px rgba(23, 33, 43, 0.08);
    }
    .center-panel { text-align: center; }
    .eyebrow {
      color: var(--primary);
      font-size: 0.78rem;
      font-weight: 700;
      letter-spacing: 0;
      text-transform: uppercase;
      margin-bottom: 0.35rem;
    }
    .lede { color: var(--muted); margin-bottom: 1rem; }
    .notice {
      border-left: 4px solid var(--accent);
      background: var(--danger-soft);
      padding: 0.8rem 0.9rem;
      margin: 1rem 0 1.2rem;
      border-radius: 6px;
    }
    .stack {
      display: grid;
      gap: 0.55rem;
    }
    label {
      font-weight: 700;
      margin-top: 0.45rem;
    }
    input, select {
      width: 100%;
      min-height: 44px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
      padding: 0.65rem 0.75rem;
      color: var(--ink);
    }
    input:focus, select:focus {
      outline: 3px solid var(--soft);
      border-color: var(--primary);
    }
    .rating-field {
      border: 0;
      padding: 0;
      margin: 0.45rem 0 0;
    }
    .rating-field legend {
      font-weight: 700;
      margin-bottom: 0.55rem;
    }
    .rating-scale {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 0.45rem;
    }
    .rating-option {
      display: grid;
      grid-template-rows: auto auto;
      align-items: center;
      justify-items: center;
      min-height: 92px;
      margin: 0;
      padding: 0.55rem 0.35rem;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
      cursor: pointer;
      text-align: center;
      gap: 0.25rem;
    }
    .rating-option input {
      position: absolute;
      opacity: 0;
      pointer-events: none;
    }
    .rating-option span {
      display: grid;
      place-items: center;
      width: 34px;
      height: 34px;
      border-radius: 999px;
      background: #eef2f5;
      color: var(--ink);
      font-weight: 700;
    }
    .rating-option small {
      color: var(--muted);
      font-size: 0.74rem;
      line-height: 1.2;
    }
    .rating-option:has(input:checked) {
      border-color: var(--primary);
      background: var(--soft);
    }
    .rating-option:has(input:checked) span {
      background: var(--primary);
      color: #fff;
    }
    button, .secondary-button, .small-button {
      border: 0;
      border-radius: 6px;
      background: var(--primary);
      color: #fff;
      min-height: 44px;
      padding: 0.65rem 0.95rem;
      cursor: pointer;
      font-weight: 700;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      white-space: nowrap;
    }
    button:hover, .secondary-button:hover { background: var(--primary-dark); }
    button:disabled { opacity: 0.6; cursor: wait; }
    .message { min-height: 1.5rem; color: var(--accent); margin: 0.8rem 0 0; }
    .muted { color: var(--muted); }
    .admin-shell {
      width: min(100% - 2rem, 1180px);
      margin: 0 auto;
      padding: 1.5rem 0 2rem;
    }
    .admin-header {
      display: flex;
      justify-content: space-between;
      gap: 1rem;
      align-items: flex-start;
      padding: 1rem 0;
    }
    .admin-actions {
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .secondary-button {
      background: #2f4052;
      min-height: 38px;
      font-size: 0.92rem;
    }
    .toolbar-band {
      display: grid;
      grid-template-columns: minmax(180px, 260px) 1fr;
      gap: 1rem;
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 0.9rem;
      margin-bottom: 0.8rem;
    }
    .label {
      display: block;
      color: var(--muted);
      font-size: 0.78rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0;
    }
    code {
      font-family: Consolas, Monaco, monospace;
      overflow-wrap: anywhere;
    }
    .table-wrap {
      width: 100%;
      overflow-x: auto;
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 820px;
    }
    th, td {
      border-bottom: 1px solid var(--line);
      padding: 0.65rem 0.7rem;
      text-align: left;
      vertical-align: middle;
      font-size: 0.92rem;
    }
    th {
      background: #eef2f5;
      color: #25313f;
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0;
    }
    tr:last-child td { border-bottom: 0; }
    .badge {
      display: inline-flex;
      align-items: center;
      min-height: 26px;
      border-radius: 999px;
      background: #e7ebef;
      color: #43505d;
      padding: 0.15rem 0.6rem;
      font-weight: 700;
      font-size: 0.82rem;
    }
    .badge.active {
      background: var(--soft);
      color: var(--primary-dark);
    }
    .code-display {
      font-size: 1.05rem;
      letter-spacing: 0;
    }
    .small-button {
      min-height: 32px;
      padding: 0.4rem 0.7rem;
      font-size: 0.86rem;
    }
    .small-button.export {
      background: #2f4052;
    }
    .small-button.export:hover {
      background: #22303d;
    }
    .small-button.quiet {
      background: #6b7280;
    }
    .small-button.danger {
      background: #9f2d24;
    }
    .small-button.danger:hover {
      background: #7d211a;
    }
    @media (max-width: 720px) {
      .admin-header,
      .toolbar-band {
        grid-template-columns: 1fr;
        display: grid;
      }
      .admin-actions {
        justify-content: stretch;
      }
      .secondary-button {
        width: 100%;
      }
      .rating-scale {
        grid-template-columns: 1fr;
      }
      .rating-option {
        grid-template-columns: 42px 1fr;
        grid-template-rows: 1fr;
        justify-items: start;
        min-height: 56px;
        text-align: left;
      }
      h1 { font-size: 1.65rem; }
    }
  `;
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function excelCell(value, styleId = "") {
  const style = styleId ? ` ss:StyleID="${styleId}"` : "";
  return `<Cell${style}><Data ss:Type="String">${xmlEscape(value)}</Data></Cell>`;
}

function excelRow(values, styleId = "") {
  return `<Row>${values.map((value) => excelCell(value, styleId)).join("")}</Row>`;
}

function renderCsv() {
  const rows = readResponses().responses || [];
  const header = ["submittedAt", "week", "date", "group", "studentId", "studentName", "topic", "rating", "ipHash"];
  const body = rows.map((row) => header.map((key) => csvEscape(row[key])).join(","));
  return [header.join(","), ...body].join("\n");
}

function renderPresentationExcel(presentationId) {
  const presentation = presentationMap().get(presentationId);
  if (!presentation) {
    return null;
  }

  const state = readState();
  const session = (state.sessions || {})[presentationId] || {};
  const rows = (readResponses().responses || []).filter((response) => response.presentationId === presentationId);
  const filename = `week-${presentation.week}-group-${presentation.group}-responses.xls`;
  const worksheetName = `W${presentation.week} G${presentation.group}`;
  const header = ["Submitted At", "Week", "Date", "Chapter", "Group", "Topic", "Student ID", "Name", "Rating", "IP Hash"];
  const dataRows = rows.map((response) => [
    response.submittedAt,
    response.week,
    response.date,
    response.chapter,
    response.group,
    response.topic,
    response.studentId || "",
    response.studentName || "",
    response.rating,
    response.ipHash
  ]);

  const tableRows = [
    excelRow(["Presentation Evaluation Responses"], "Title"),
    excelRow(["Week", presentation.week]),
    excelRow(["Date", presentation.date]),
    excelRow(["Chapter", presentation.chapter]),
    excelRow(["Group", presentation.group]),
    excelRow(["Topic", presentation.topic]),
    excelRow(["Session Code", session.code || ""]),
    excelRow(["Session Status", session.active ? "Open" : "Closed"]),
    excelRow(["Started At", session.startedAt || ""]),
    excelRow(["Stopped At", session.stoppedAt || ""]),
    excelRow(["Response Count", rows.length]),
    "<Row />",
    excelRow(header, "Header"),
    ...dataRows.map((row) => excelRow(row))
  ].join("");

  const body = `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
  xmlns:o="urn:schemas-microsoft-com:office:office"
  xmlns:x="urn:schemas-microsoft-com:office:excel"
  xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
  xmlns:html="http://www.w3.org/TR/REC-html40">
  <Styles>
    <Style ss:ID="Title"><Font ss:Bold="1" ss:Size="14" /></Style>
    <Style ss:ID="Header"><Font ss:Bold="1" /><Interior ss:Color="#EEF2F5" ss:Pattern="Solid" /></Style>
  </Styles>
  <Worksheet ss:Name="${xmlEscape(worksheetName)}">
    <Table>
      <Column ss:Width="150" />
      <Column ss:Width="70" />
      <Column ss:Width="90" />
      <Column ss:Width="210" />
      <Column ss:Width="70" />
      <Column ss:Width="230" />
      <Column ss:Width="110" />
      <Column ss:Width="140" />
      <Column ss:Width="60" />
      <Column ss:Width="140" />
      ${tableRows}
    </Table>
  </Worksheet>
</Workbook>`;

  return { filename, body };
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/status") {
    const today = getTodaySchedule();
    sendJson(res, 200, {
      now: getKstDateParts().isoLike,
      classWindowOpen: isClassWindowOpen(),
      today: today ? { week: today.week, date: today.date, note: today.note, hasPresentations: today.presentations.length > 0 } : null
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/submit") {
    let body;
    try {
      body = await readBody(req);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
      return;
    }

    const rating = Number(body.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      sendJson(res, 400, { error: "Please choose a rating from 1 to 5." });
      return;
    }

    const studentId = String(body.studentId || "").trim();
    if (!/^[0-9]{4,20}$/.test(studentId)) {
      sendJson(res, 400, { error: "Please enter a valid student ID." });
      return;
    }

    const studentName = String(body.studentName || "").trim().replace(/\s+/g, " ");
    if (studentName.length < 1 || studentName.length > 80) {
      sendJson(res, 400, { error: "Please enter a valid name." });
      return;
    }

    const state = readState();
    const match = findPresentationByCode(body.code, state);
    if (!match) {
      sendJson(res, 404, { error: "The code is not active. Please confirm it and try again." });
      return;
    }

    const ipHash = hashIp(getClientIp(req));
    const stored = readResponses();
    const existing = (stored.responses || []).find((response) => {
      return response.presentationId === match.presentation.id && response.studentId === studentId;
    });

    if (existing) {
      sendJson(res, 200, { ok: true, duplicate: true });
      return;
    }

    const response = {
      id: crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex"),
      presentationId: match.presentation.id,
      week: match.presentation.week,
      date: match.presentation.date,
      chapter: match.presentation.chapter,
      topic: match.presentation.topic,
      group: match.presentation.group,
      studentId,
      studentName,
      rating,
      ipHash,
      submittedAt: getKstDateParts().isoLike
    };

    stored.responses = stored.responses || [];
    stored.responses.push(response);
    saveResponses(stored);
    sendJson(res, 201, { ok: true });
    return;
  }

  if (url.pathname === "/api/admin/state" && req.method === "GET") {
    if (!isAdminRequest(url)) {
      sendJson(res, 403, { error: "Invalid admin key." });
      return;
    }
    sendJson(res, 200, getAdminSnapshot());
    return;
  }

  if (url.pathname === "/api/admin/start" && req.method === "POST") {
    let body;
    try {
      body = await readBody(req);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
      return;
    }
    if (!isAdminRequest(url, body)) {
      sendJson(res, 403, { error: "Invalid admin key." });
      return;
    }

    const map = presentationMap();
    const presentationId = String(body.presentationId || "");
    if (!map.has(presentationId)) {
      sendJson(res, 404, { error: "Presentation not found." });
      return;
    }

    const state = readState();
    state.sessions = state.sessions || {};
    state.sessions[presentationId] = {
      code: generateCode(state),
      active: true,
      startedAt: getKstDateParts().isoLike,
      stoppedAt: null
    };
    saveState(state);
    sendJson(res, 200, { ok: true, session: state.sessions[presentationId] });
    return;
  }

  if (url.pathname === "/api/admin/stop" && req.method === "POST") {
    let body;
    try {
      body = await readBody(req);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
      return;
    }
    if (!isAdminRequest(url, body)) {
      sendJson(res, 403, { error: "Invalid admin key." });
      return;
    }

    const presentationId = String(body.presentationId || "");
    const state = readState();
    if (state.sessions && state.sessions[presentationId]) {
      state.sessions[presentationId].active = false;
      state.sessions[presentationId].stoppedAt = getKstDateParts().isoLike;
      saveState(state);
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  if (url.pathname === "/api/admin/reset-votes" && req.method === "POST") {
    let body;
    try {
      body = await readBody(req);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
      return;
    }
    if (!isAdminRequest(url, body)) {
      sendJson(res, 403, { error: "Invalid admin key." });
      return;
    }

    const map = presentationMap();
    const presentationId = String(body.presentationId || "");
    if (!map.has(presentationId)) {
      sendJson(res, 404, { error: "Presentation not found." });
      return;
    }

    const stored = readResponses();
    const beforeCount = (stored.responses || []).length;
    stored.responses = (stored.responses || []).filter((response) => response.presentationId !== presentationId);
    saveResponses(stored);
    sendJson(res, 200, { ok: true, removed: beforeCount - stored.responses.length });
    return;
  }

  notFound(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, BASE_URL);

  if (url.pathname.startsWith("/api/")) {
    handleApi(req, res, url).catch((error) => {
      console.error(error);
      sendJson(res, 500, { error: "Internal server error." });
    });
    return;
  }

  if (url.pathname === "/admin/export.csv") {
    if (!isAdminRequest(url)) {
      send(res, 403, "Invalid admin key.", "text/plain; charset=utf-8");
      return;
    }
    send(res, 200, renderCsv(), "text/csv; charset=utf-8");
    return;
  }

  if (url.pathname === "/admin/export.xls") {
    if (!isAdminRequest(url)) {
      send(res, 403, "Invalid admin key.", "text/plain; charset=utf-8");
      return;
    }

    const exportFile = renderPresentationExcel(url.searchParams.get("presentationId") || "");
    if (!exportFile) {
      send(res, 404, "Presentation not found.", "text/plain; charset=utf-8");
      return;
    }

    send(res, 200, exportFile.body, "application/vnd.ms-excel; charset=utf-8", {
      "Content-Disposition": `attachment; filename="${exportFile.filename}"`
    });
    return;
  }

  if (url.pathname === "/admin") {
    send(res, 200, renderAdminPage());
    return;
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    send(res, 200, renderStudentPage());
    return;
  }

  notFound(res);
});

server.listen(PORT, HOST, () => {
  console.log(`Presentation evaluation service listening on ${BASE_URL}`);
  console.log(`Admin URL: ${BASE_URL}/admin?key=${encodeURIComponent(adminKey)}`);
});
