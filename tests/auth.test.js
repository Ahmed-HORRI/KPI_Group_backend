// End-to-end tests of the authentication and user administration module:
// real Express app + HTTP requests, with an in-memory PostgreSQL (pg-mem) and
// a fake mailer -- nothing touches the production database or sends e-mail.

const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const express = require("express");
const bodyParser = require("body-parser");
const { newDb } = require("pg-mem");
const { loadAuthConfig } = require("../src/config/auth");
const { installAuth } = require("../src/installAuth");
const model = require("../src/models/auth.model");
const { hashPassword, hashToken } = require("../src/utils/password");

const APP_ORIGIN = "http://localhost:5173";
const ADMIN_EMAIL = "admin@avocarbon.com";
const ADMIN_PASSWORD = "Admin-Password-2026";
// Stand-in for the protected Responsible KPI Dashboard API.
const DASHBOARD_API = "/api/responsibles/7/kpi-objects";

let server;
let baseUrl;
let pool;
let authService;
let clockOffsetMs = 0;
let mailShouldFail = false;
const sentMails = [];

const advanceClock = (minutes) => {
  clockOffsetMs += minutes * 60 * 1000;
};

// Minimal browser: keeps the session cookie between requests.
class Browser {
  constructor() {
    this.cookies = {};
  }

  async request(method, path, { body, origin = APP_ORIGIN, headers = {} } = {}) {
    const cookieHeader = Object.entries(this.cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        ...(origin ? { Origin: origin } : {}),
        ...headers
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });

    const setCookies = response.headers.getSetCookie();
    for (const setCookie of setCookies) {
      const [pair] = setCookie.split(";");
      const [name, ...rest] = pair.split("=");
      const value = rest.join("=");
      if (/Max-Age=0/i.test(setCookie) || !value) delete this.cookies[name.trim()];
      else this.cookies[name.trim()] = value;
    }

    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: response.status, json, text, setCookies, headers: response.headers };
  }

  get(path, options) {
    return this.request("GET", path, options);
  }

  post(path, body, options = {}) {
    return this.request("POST", path, { ...options, body: body ?? {} });
  }

  patch(path, body, options = {}) {
    return this.request("PATCH", path, { ...options, body: body ?? {} });
  }

  delete(path, options) {
    return this.request("DELETE", path, options);
  }

  async login(email, password) {
    return this.post("/api/auth/login", { email, password });
  }
}

const loggedInAs = async (email, password) => {
  const browser = new Browser();
  const res = await browser.login(email, password);
  assert.equal(res.status, 200, `login as ${email} failed: ${res.text}`);
  return browser;
};

const lastMailTo = (email) => [...sentMails].reverse().find((mail) => mail.to === email);

const extractToken = (mail) => {
  const match = /reset-password\?token=([A-Za-z0-9_-]+)/.exec(mail.text);
  assert.ok(match, "the e-mail contains a reset-password link");
  return match[1];
};

// The protected dashboard API of a signed-in user: their own (id = their people_id).
const ownDashboardApi = async (browser) => {
  const me = await browser.get("/api/auth/me");
  assert.ok(me.json.user?.people_id, "the account is linked to a person");
  return `/api/responsibles/${me.json.user.people_id}/kpi-objects`;
};

// Every account but an administrator's belongs to a person: unless the test
// picks one, the e-mail gets a row in public.people so the account is linked
// to it automatically.
const ensurePersonWithEmail = async (email, fullName = "") => {
  const existing = await pool.query("SELECT people_id FROM public.people WHERE LOWER(email) = $1", [email.toLowerCase()]);
  if (existing.rows.length) return existing.rows[0].people_id;
  const [firstName = "", ...rest] = fullName.split(" ");
  const inserted = await pool.query(
    "INSERT INTO public.people (name, first_name, email) VALUES ($1, $2, $3) RETURNING people_id",
    [rest.join(" ") || "TEST", firstName || "Test", email]
  );
  return inserted.rows[0].people_id;
};

const createUserAsAdmin = async (admin, body) => {
  if ((body.role || "user") !== "admin" && body.people_id === undefined) {
    await ensurePersonWithEmail(body.email, body.full_name);
  }
  const res = await admin.post("/api/admin/users", body);
  assert.equal(res.status, 201, res.text);
  return res.json;
};

// Invites a user, then completes the invitation with the given password.
const createActiveUser = async (admin, { email, full_name, role = "user", password }) => {
  await createUserAsAdmin(admin, { email, full_name, role });
  const token = extractToken(lastMailTo(email));
  const res = await new Browser().post("/api/auth/reset-password", { token, password });
  assert.equal(res.status, 200, res.text);
};

before(async () => {
  const memoryDb = newDb({ noAstCoverageCheck: true });
  const { Pool } = memoryDb.adapters.createPg();
  pool = new Pool();
  await pool.query(`
    CREATE TABLE public.people (
      people_id SERIAL PRIMARY KEY,
      name VARCHAR(100),
      first_name VARCHAR(100),
      email VARCHAR(255)
    )
  `);
  await pool.query(`
    INSERT INTO public.people (name, first_name, email) VALUES
      ('HORRI', 'Ahmed', 'ahmed.horri@avocarbon.com'),
      ('KHIARI', 'Taha', 'taha.khiari@avocarbon.com')
  `);

  // Every request comes from 127.0.0.1: the per-IP limits are raised so they do
  // not interfere; the per-account login limit keeps its real value (5).
  const config = loadAuthConfig({
    FRONTEND_URL: APP_ORIGIN,
    NODE_ENV: "test",
    AUTH_LOGIN_RATE_LIMIT_PER_IP: "10000",
    AUTH_FORGOT_PASSWORD_RATE_LIMIT_PER_IP: "10000",
    AUTH_TOKEN_RATE_LIMIT_PER_IP: "10000"
  });
  const app = express();
  app.use(bodyParser.json());
  ({ authService } = installAuth(app, {
    db: pool,
    config,
    now: () => new Date(Date.now() + clockOffsetMs),
    logger: { error: () => {}, log: () => {}, warn: () => {} },
    sendMail: async (message) => {
      if (mailShouldFail) throw new Error("SMTP unavailable");
      sentMails.push(message);
    }
  }));

  // Stand-ins for the real application routes mounted after installAuth():
  // the Responsible KPI Dashboard routes are protected, everything else is public.
  const whoAmI = (req, res) => res.json({ ok: true, email: req.auth?.user?.email || null });
  for (const route of ["/api/responsibles/:id/kpi-objects", "/api/responsibles/:id/kpis/:kpiId"]) {
    app.get(route, whoAmI);
    app.post(route, whoAmI);
    app.put(route, whoAmI);
    app.delete(route, whoAmI);
  }
  app.get("/api/responsibles/:id/dashboard-context", whoAmI);
  app.get("/api/responsibles/:id/kpi-monthly-series", whoAmI);
  app.get("/api/responsibles/:id/parameter-kpis", whoAmI);
  app.get("/api/responsibles/:id/dashboard", whoAmI);
  app.get("/api/responsibles/:id/kpi-form", whoAmI);
  app.post("/api/responsibles/:id/kpi-results", whoAmI);
  app.get("/api/kpi-training/portal", whoAmI);
  app.get("/api/kpi-target-adjustments/proposal", whoAmI);
  app.get("/api/kpis", whoAmI);
  app.post("/api/kpis", whoAmI);
  app.put("/api/kpis/:id", whoAmI);
  app.delete("/api/kpis/:id", whoAmI);
  app.get("/generate-kpi-recommendations", whoAmI);

  await authService.ensureSchema();
  await model.insertUser(pool, {
    email: ADMIN_EMAIL,
    fullName: "First Admin",
    peopleId: null,
    role: "admin",
    passwordHash: await hashPassword(ADMIN_PASSWORD),
    mustChangePassword: false,
    createdByUserId: null,
    now: new Date()
  });

  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

// ---------------------------------------------------------------------------

test("only the Responsible KPI Dashboard and the admin API require a session", async () => {
  const anonymous = new Browser();

  const privateRes = await anonymous.get(DASHBOARD_API);
  assert.equal(privateRes.status, 401);
  assert.equal(privateRes.json.code, "AUTH_REQUIRED");

  for (const [method, path] of [
    ["POST", DASHBOARD_API],
    ["PUT", "/api/responsibles/7/kpi-objects/15"],
    ["DELETE", "/api/responsibles/7/kpi-objects/15"],
    ["GET", "/api/responsibles/7/kpis"],
    ["POST", "/api/responsibles/7/kpis"],
    ["DELETE", "/api/responsibles/7/kpis/3"],
    ["GET", "/api/responsibles/7/dashboard-context"],
    ["GET", "/api/responsibles/7/kpi-monthly-series"],
    ["GET", "/api/responsibles/7/parameter-kpis"],
    ["GET", "/api/admin/users"]
  ]) {
    const res = await anonymous.request(method, path, method === "GET" ? {} : { body: {} });
    assert.equal(res.status, 401, `${method} ${path} requires a session`);
  }

  // Pages opened from e-mail links, and every other page, stay open as before.
  for (const [method, path] of [
    ["GET", "/api/responsibles/7/kpi-form"],
    ["POST", "/api/responsibles/7/kpi-results"],
    ["GET", "/api/responsibles/7/dashboard"],
    ["GET", "/api/kpi-training/portal"],
    ["GET", "/api/kpi-target-adjustments/proposal"],
    ["GET", "/api/kpis"],
    ["POST", "/api/kpis"],
    ["PUT", "/api/kpis/3"],
    ["DELETE", "/api/kpis/3"],
    ["GET", "/generate-kpi-recommendations"]
  ]) {
    const res = await anonymous.request(method, path, method === "GET" ? {} : { body: {} });
    assert.equal(res.status, 200, `${method} ${path} stays public`);
  }

  const me = await anonymous.get("/api/auth/me");
  assert.equal(me.status, 200);
  assert.equal(me.json.user, null);
});

test("login: a wrong password and an unknown e-mail get the same answer", async () => {
  const browser = new Browser();
  const wrongPassword = await browser.login(ADMIN_EMAIL, "not-the-password");
  const unknownEmail = await browser.login("nobody@avocarbon.com", "whatever-Password-1");

  assert.equal(wrongPassword.status, 401);
  assert.equal(unknownEmail.status, 401);
  assert.equal(wrongPassword.json.error, unknownEmail.json.error);
  assert.equal(wrongPassword.setCookies.length, 0);

  assert.equal((await browser.login("", "")).status, 400);
});

test("login sets an HttpOnly session cookie; only its hash is stored", async () => {
  const browser = new Browser();
  const res = await browser.login("  Admin@AvoCarbon.com ", ADMIN_PASSWORD);

  assert.equal(res.status, 200);
  assert.equal(res.json.user.email, ADMIN_EMAIL);
  assert.equal(res.json.user.role, "admin");
  assert.equal(res.json.user.password_hash, undefined);

  const cookie = res.setCookies.find((value) => value.startsWith("kpi_session="));
  assert.ok(cookie, "session cookie set");
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Max-Age=\d+/);

  const token = browser.cookies.kpi_session;
  const stored = await pool.query(`SELECT token_hash FROM public.kpi_app_session`);
  const hashes = stored.rows.map((row) => row.token_hash);
  assert.ok(hashes.includes(hashToken(token)), "the SHA-256 of the token is stored");
  assert.ok(!hashes.includes(token), "the raw token is never stored");

  const me = await browser.get("/api/auth/me");
  assert.equal(me.json.user.email, ADMIN_EMAIL);
  assert.equal((await browser.get(DASHBOARD_API)).json.email, ADMIN_EMAIL);
});

test("logout revokes the session server-side", async () => {
  const browser = await loggedInAs(ADMIN_EMAIL, ADMIN_PASSWORD);
  const stolenCookie = browser.cookies.kpi_session;

  const res = await browser.post("/api/auth/logout");
  assert.equal(res.status, 200);
  assert.equal(browser.cookies.kpi_session, undefined, "cookie cleared");

  const replay = new Browser();
  replay.cookies.kpi_session = stolenCookie;
  assert.equal((await replay.get(DASHBOARD_API)).status, 401, "the old cookie no longer works");
});

test("sessions expire after the idle timeout and the absolute lifetime", async () => {
  const idle = await loggedInAs(ADMIN_EMAIL, ADMIN_PASSWORD);
  advanceClock(121);
  assert.equal((await idle.get(DASHBOARD_API)).status, 401, "idle for more than 2 hours");

  const active = await loggedInAs(ADMIN_EMAIL, ADMIN_PASSWORD);
  for (let step = 0; step < 6; step += 1) {
    advanceClock(110);
    assert.equal((await active.get(DASHBOARD_API)).status, 200, `still active after ${(step + 1) * 110} min`);
  }
  advanceClock(110);
  assert.equal((await active.get(DASHBOARD_API)).status, 401, "12-hour absolute lifetime reached");
});

test("the router rate-limits repeated failed logins for one account", async () => {
  const browser = new Browser();
  const email = "ratelimited@avocarbon.com";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal((await browser.login(email, "Wrong-password-1")).status, 401);
  }
  const blocked = await browser.login(email, "Wrong-password-1");
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get("retry-after")) > 0);
});

test("the account is locked after 5 failures, then unlocked by time or by an admin", async () => {
  const admin = await loggedInAs(ADMIN_EMAIL, ADMIN_PASSWORD);
  const email = "lockme@avocarbon.com";
  const password = "Lock-me-Password-1";
  await createActiveUser(admin, { email, full_name: "Lock Me", password });

  // Service level: the HTTP rate limiter (in-memory, wall-clock) is tested above.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(authService.login({ email, password: "Wrong-password-1" }), { statusCode: 401 });
  }
  await assert.rejects(authService.login({ email, password }), { statusCode: 429 }, "locked even with the right password");

  const listed = await admin.get(`/api/admin/users?search=lockme`);
  const lockedUser = listed.json.users[0];
  assert.equal(lockedUser.status, "locked");

  const unlock = await admin.post(`/api/admin/users/${lockedUser.user_id}/unlock`);
  assert.equal(unlock.json.user.status, "active");
  await authService.login({ email, password });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(authService.login({ email, password: "Wrong-password-1" }), { statusCode: 401 });
  }
  advanceClock(16);
  await authService.login({ email, password });
});

test("forgot password: generic answer, single-use expiring link, sessions revoked", async () => {
  const admin = await loggedInAs(ADMIN_EMAIL, ADMIN_PASSWORD);
  const email = "forgetful@avocarbon.com";
  const oldPassword = "Old-Password-2026";
  const newPassword = "New-Password-2026";
  await createActiveUser(admin, { email, full_name: "Forgetful User", password: oldPassword });
  const signedIn = await loggedInAs(email, oldPassword);

  const anonymous = new Browser();
  const mailsBefore = sentMails.length;
  const unknown = await anonymous.post("/api/auth/forgot-password", { email: "ghost@avocarbon.com" });
  const known = await anonymous.post("/api/auth/forgot-password", { email });
  await authService.flushDeliveries();
  assert.equal(unknown.status, 200);
  assert.equal(known.status, 200);
  assert.equal(unknown.json.message, known.json.message, "same answer for unknown and known e-mails");
  assert.equal(sentMails.length, mailsBefore + 1, "only the real account gets an e-mail");

  const token = extractToken(lastMailTo(email));
  const check = await anonymous.get(`/api/auth/password-token?token=${token}`);
  assert.equal(check.status, 200);
  assert.equal(check.json.purpose, "reset");
  assert.equal(check.json.email, email);

  const weak = await anonymous.post("/api/auth/reset-password", { token, password: "short" });
  assert.equal(weak.status, 400);
  assert.match(weak.json.error, /at least 10 characters/);

  const containsEmail = await anonymous.post("/api/auth/reset-password", { token, password: "Forgetful-2026-Ok" });
  assert.equal(containsEmail.status, 400);
  assert.match(containsEmail.json.error, /not contain your e-mail name/);

  const reset = await anonymous.post("/api/auth/reset-password", { token, password: newPassword });
  assert.equal(reset.status, 200, reset.text);

  assert.equal((await signedIn.get(DASHBOARD_API)).status, 401, "existing sessions are revoked by a reset");
  assert.equal((await anonymous.login(email, oldPassword)).status, 401, "old password rejected");
  assert.equal((await new Browser().login(email, newPassword)).status, 200, "new password accepted");

  const reuse = await anonymous.post("/api/auth/reset-password", { token, password: "Another-Password-1" });
  assert.equal(reuse.status, 400, "a link works only once");

  await anonymous.post("/api/auth/forgot-password", { email });
  await authService.flushDeliveries();
  const lateToken = extractToken(lastMailTo(email));
  advanceClock(61);
  const late = await anonymous.post("/api/auth/reset-password", { token: lateToken, password: "Late-Password-2026" });
  assert.equal(late.status, 400, "a reset link expires after 60 minutes");
  assert.equal((await anonymous.get("/api/auth/password-token?token=bogus")).status, 400);
});

test("a new reset link invalidates the previous one", async () => {
  const admin = await loggedInAs(ADMIN_EMAIL, ADMIN_PASSWORD);
  const email = "twolinks@avocarbon.com";
  await createActiveUser(admin, { email, full_name: "Two Links", password: "First-Password-2026" });

  const anonymous = new Browser();
  await anonymous.post("/api/auth/forgot-password", { email });
  await authService.flushDeliveries();
  const firstToken = extractToken(lastMailTo(email));
  await anonymous.post("/api/auth/forgot-password", { email });
  await authService.flushDeliveries();
  const secondToken = extractToken(lastMailTo(email));

  assert.notEqual(firstToken, secondToken);
  assert.equal((await anonymous.get(`/api/auth/password-token?token=${firstToken}`)).status, 400);
  assert.equal((await anonymous.get(`/api/auth/password-token?token=${secondToken}`)).status, 200);
});

test("change password keeps the current session and signs out the others", async () => {
  const admin = await loggedInAs(ADMIN_EMAIL, ADMIN_PASSWORD);
  const email = "changer@avocarbon.com";
  const password = "Swap-Secret-2026";
  await createActiveUser(admin, { email, full_name: "Password Changer", password });

  const laptop = await loggedInAs(email, password);
  const phone = await loggedInAs(email, password);

  const wrongCurrent = await laptop.post("/api/auth/change-password", {
    current_password: "nope",
    new_password: "Swapped-Secret-2026"
  });
  assert.equal(wrongCurrent.status, 400);

  const same = await laptop.post("/api/auth/change-password", { current_password: password, new_password: password });
  assert.equal(same.status, 400);

  const changed = await laptop.post("/api/auth/change-password", {
    current_password: password,
    new_password: "Swapped-Secret-2026"
  });
  assert.equal(changed.status, 200, changed.text);
  assert.equal((await laptop.get(await ownDashboardApi(laptop))).status, 200, "this device stays signed in");
  assert.equal((await phone.get(DASHBOARD_API)).status, 401, "other devices are signed out");
  assert.equal((await new Browser().login(email, "Swapped-Secret-2026")).status, 200);
});

test("a temporary password forces a password change before anything else", async () => {
  const admin = await loggedInAs(ADMIN_EMAIL, ADMIN_PASSWORD);
  const email = "temporary@avocarbon.com";
  const created = await createUserAsAdmin(admin, {
    email,
    full_name: "Temporary User",
    temporary_password: "Temp-Secret-2026"
  });
  assert.equal(created.email_sent, false);
  assert.equal(created.user.status, "password_change_required");

  const user = await loggedInAs(email, "Temp-Secret-2026");
  const me = await user.get("/api/auth/me");
  assert.equal(me.json.user.must_change_password, true);

  const blocked = await user.get(DASHBOARD_API);
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.code, "PASSWORD_CHANGE_REQUIRED");

  const changed = await user.post("/api/auth/change-password", {
    current_password: "Temp-Secret-2026",
    new_password: "My-Own-Password-1"
  });
  assert.equal(changed.status, 200, changed.text);
  assert.equal(changed.json.user.must_change_password, false);
  assert.equal((await user.get(await ownDashboardApi(user))).status, 200);
});

test("only administrators can use the admin API", async () => {
  const admin = await loggedInAs(ADMIN_EMAIL, ADMIN_PASSWORD);
  const email = "regular@avocarbon.com";
  await createActiveUser(admin, { email, full_name: "Regular User", password: "Plain-Secret-2026" });

  const regular = await loggedInAs(email, "Plain-Secret-2026");
  assert.equal((await regular.get(await ownDashboardApi(regular))).status, 200);
  for (const [method, path] of [
    ["GET", "/api/admin/users"],
    ["POST", "/api/admin/users"],
    ["GET", "/api/admin/auth-events"],
    ["GET", "/api/admin/people?search=ah"]
  ]) {
    const res = await regular.request(method, path, method === "POST" ? { body: {} } : {});
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.equal(res.json.code, "ADMIN_REQUIRED");
  }
});

test("invitation: the account works only once the user has chosen a password", async () => {
  const admin = await loggedInAs(ADMIN_EMAIL, ADMIN_PASSWORD);
  const email = "invited@avocarbon.com";
  const created = await createUserAsAdmin(admin, { email, full_name: "Invited User", role: "user" });
  assert.equal(created.email_sent, true);
  assert.equal(created.user.status, "invited");
  assert.equal(created.manual_link, undefined);

  const mail = lastMailTo(email);
  assert.equal(mail.subject, "Your KPI Manager account is ready");
  assert.match(mail.text, /mode=invite/);
  assert.match(mail.html, /First Admin/, "the invitation names the administrator who sent it");
  assert.match(mail.html, /cid:kpi-manager-logo/);
  assert.equal(mail.attachments[0].cid, "kpi-manager-logo", "the logo is attached inline");
  assert.ok(require("node:fs").existsSync(mail.attachments[0].path), "the logo file exists");
  const token = extractToken(mail);

  assert.equal((await new Browser().login(email, "Anything-1234")).status, 401, "no password yet");
  const check = await new Browser().get(`/api/auth/password-token?token=${token}`);
  assert.equal(check.json.purpose, "invite");

  const accepted = await new Browser().post("/api/auth/reset-password", { token, password: "Welcome-Secret-2026" });
  assert.equal(accepted.status, 200);
  assert.equal((await new Browser().login(email, "Welcome-Secret-2026")).status, 200);

  const duplicate = await admin.post("/api/admin/users", { email: "INVITED@avocarbon.com", full_name: "Again" });
  assert.equal(duplicate.status, 409);
  assert.equal((await admin.post("/api/admin/users", { email: "not-an-email", full_name: "X" })).status, 400);
  assert.equal((await admin.post("/api/admin/users", { email: "x@avocarbon.com", full_name: "X", role: "root" })).status, 400);
});

test("when the invitation e-mail fails, the admin gets the link to pass on", async () => {
  const admin = await loggedInAs(ADMIN_EMAIL, ADMIN_PASSWORD);
  mailShouldFail = true;
  try {
    const created = await createUserAsAdmin(admin, { email: "nomail@avocarbon.com", full_name: "No Mail" });
    assert.equal(created.email_sent, false);
    assert.match(created.manual_link, /^http:\/\/localhost:5173\/reset-password\?token=.+&mode=invite$/);

    const resent = await admin.post(`/api/admin/users/${created.user.user_id}/password-link`);
    assert.equal(resent.json.purpose, "invite");
    assert.equal(resent.json.email_sent, false);
  } finally {
    mailShouldFail = false;
  }
});

test("accounts can be linked to a person from public.people", async () => {
  const admin = await loggedInAs(ADMIN_EMAIL, ADMIN_PASSWORD);

  const search = await admin.get("/api/admin/people?search=horri");
  assert.equal(search.status, 200);
  const person = search.json.people[0];
  assert.equal(person.full_name, "Ahmed HORRI");
  assert.equal(person.linked_user_id, null);

  const created = await createUserAsAdmin(admin, { email: person.email, people_id: person.people_id });
  assert.equal(created.user.full_name, "Ahmed HORRI", "name taken from people");
  assert.equal(created.user.people_id, person.people_id);
  assert.deepEqual(created.user.person, {
    people_id: person.people_id,
    full_name: "Ahmed HORRI",
    email: "ahmed.horri@avocarbon.com"
  });
  const listedPerson = (await admin.get("/api/admin/users?search=horri")).json.users[0].person;
  assert.equal(listedPerson.full_name, "Ahmed HORRI", "the list shows the linked person too");

  const again = await admin.post("/api/admin/users", {
    email: "other@avocarbon.com",
    full_name: "Other",
    people_id: person.people_id
  });
  assert.equal(again.status, 409, "one account per person");
  assert.equal((await admin.post("/api/admin/users", { email: "p@avocarbon.com", full_name: "P", people_id: 9999 })).status, 400);

  const linked = await admin.get("/api/admin/people?search=horri");
  assert.equal(linked.json.people[0].linked_user_id, created.user.user_id);
});

test("a new account is linked automatically to the person with the same e-mail", async () => {
  const admin = await loggedInAs(ADMIN_EMAIL, ADMIN_PASSWORD);
  const taha = (await pool.query("SELECT people_id FROM public.people WHERE email = 'taha.khiari@avocarbon.com'")).rows[0];

  // No person picked, e-mail typed with another case: still found.
  const created = await createUserAsAdmin(admin, { email: "Taha.Khiari@avocarbon.com", full_name: "" });
  assert.equal(created.user.people_id, taha.people_id);
  assert.equal(created.user.full_name, "Taha KHIARI", "name taken from people");
  assert.equal(created.user.person.people_id, taha.people_id);
});

test("a user account must belong to a person; an administrator may have none", async () => {
  const admin = await loggedInAs(ADMIN_EMAIL, ADMIN_PASSWORD);

  const noPerson = await admin.post("/api/admin/users", { email: "ghost@avocarbon.com", full_name: "Ghost User" });
  assert.equal(noPerson.status, 400, "no person picked and none with this e-mail");
  assert.match(noPerson.json.error, /person this account belongs to/);

  const itAdmin = await admin.post("/api/admin/users", {
    email: "it-admin@avocarbon.com",
    full_name: "IT Admin",
    role: "admin"
  });
  assert.equal(itAdmin.status, 201, itAdmin.text);
  assert.equal(itAdmin.json.user.people_id, null);
  const demoted = await admin.patch(`/api/admin/users/${itAdmin.json.user.user_id}`, { role: "user" });
  assert.equal(demoted.status, 400, "becoming a user requires a person");

  const linked = await createUserAsAdmin(admin, { email: "linked-user@avocarbon.com", full_name: "Linked User" });
  const unlinked = await admin.patch(`/api/admin/users/${linked.user.user_id}`, { people_id: null });
  assert.equal(unlinked.status, 400, "a user cannot lose their person");

  // An older account without a person can still be managed.
  const legacy = await model.insertUser(pool, {
    email: "legacy@avocarbon.com",
    fullName: "Legacy User",
    peopleId: null,
    role: "user",
    passwordHash: null,
    mustChangePassword: false,
    createdByUserId: null,
    now: new Date()
  });
  assert.equal((await admin.patch(`/api/admin/users/${legacy.user_id}`, { is_active: false })).status, 200);

  // Leave the admin count as the following tests expect it.
  assert.equal((await admin.delete(`/api/admin/users/${itAdmin.json.user.user_id}`)).status, 200);
});

test("CEO, VP, plant and zone managers are roles of accounts linked to a person", async () => {
  const admin = await loggedInAs(ADMIN_EMAIL, ADMIN_PASSWORD);
  for (const role of ["ceo", "vp", "plant_manager", "zone_manager"]) {
    const created = await createUserAsAdmin(admin, { email: `${role.replace("_", "-")}@avocarbon.com`, full_name: `A ${role}`, role });
    assert.equal(created.user.role, role);
    assert.ok(created.user.people_id, `a ${role} is linked to a person`);
  }

  const noPerson = await admin.post("/api/admin/users", { email: "ceo-ghost@avocarbon.com", full_name: "Ghost", role: "ceo" });
  assert.equal(noPerson.status, 400, "only an administrator may have no person");

  const ceos = (await admin.get("/api/admin/users?role=ceo")).json.users;
  assert.deepEqual(ceos.map((user) => user.email), ["ceo@avocarbon.com"], "the role filter");

  // These roles do not give access to the administration.
  const managerEmail = "zone-manager@avocarbon.com";
  const token = extractToken(lastMailTo(managerEmail));
  await new Browser().post("/api/auth/reset-password", { token, password: "Area-Secret-2026" });
  const manager = await loggedInAs(managerEmail, "Area-Secret-2026");
  assert.equal((await manager.get("/api/admin/users")).status, 403);
});

test("a user only opens their own KPI dashboard; administrators open anyone's", async () => {
  const admin = await loggedInAs(ADMIN_EMAIL, ADMIN_PASSWORD);
  const email = "own-dashboard@avocarbon.com";
  await createActiveUser(admin, { email, full_name: "Own Dashboard", password: "Kpi-Isolation-2026" });
  const user = await loggedInAs(email, "Kpi-Isolation-2026");
  const ownId = (await user.get("/api/auth/me")).json.user.people_id;
  const otherId = ownId + 1000;

  for (const [method, suffix] of [
    ["GET", "kpi-objects"],
    ["POST", "kpi-objects"],
    ["PUT", "kpis/3"],
    ["DELETE", "kpis/3"],
    ["GET", "dashboard-context"],
    ["GET", "kpi-monthly-series"]
  ]) {
    const options = method === "GET" ? {} : { body: {} };
    const own = await user.request(method, `/api/responsibles/${ownId}/${suffix}`, options);
    assert.equal(own.status, 200, `${method} ${suffix} on their own dashboard`);

    const other = await user.request(method, `/api/responsibles/${otherId}/${suffix}`, options);
    assert.equal(other.status, 403, `${method} ${suffix} on another person's dashboard`);
    assert.equal(other.json.code, "NOT_OWN_DASHBOARD");
  }

  // Public pages (e-mail links) are not affected.
  assert.equal((await user.get(`/api/responsibles/${otherId}/kpi-form`)).status, 200);
  // Administrators can open any dashboard.
  assert.equal((await admin.get(`/api/responsibles/${otherId}/kpi-objects`)).status, 200);
});

test("disabling an account signs it out and blocks login", async () => {
  const admin = await loggedInAs(ADMIN_EMAIL, ADMIN_PASSWORD);
  const email = "leaver@avocarbon.com";
  await createActiveUser(admin, { email, full_name: "Leaver", password: "Goodbye-Secret-2026" });
  const leaver = await loggedInAs(email, "Goodbye-Secret-2026");

  const target = (await admin.get("/api/admin/users?search=leaver")).json.users[0];
  const disabled = await admin.patch(`/api/admin/users/${target.user_id}`, { is_active: false });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.json.user.status, "disabled");

  assert.equal((await leaver.get(DASHBOARD_API)).status, 401, "signed out immediately");
  const login = await new Browser().login(email, "Goodbye-Secret-2026");
  assert.equal(login.status, 403);
  assert.match(login.json.error, /disabled/);

  const forgot = await new Browser().post("/api/auth/forgot-password", { email });
  assert.equal(forgot.status, 200);
  await authService.flushDeliveries();
  assert.notEqual(lastMailTo(email)?.subject, "Reset your KPI Manager password", "no reset e-mail for a disabled account");

  assert.equal((await admin.post(`/api/admin/users/${target.user_id}/password-link`)).status, 400);
  const enabled = await admin.patch(`/api/admin/users/${target.user_id}`, { is_active: true });
  assert.equal(enabled.json.user.status, "active");
  assert.equal((await new Browser().login(email, "Goodbye-Secret-2026")).status, 200);
});

test("there is always at least one active administrator, and admins cannot lock themselves out", async () => {
  const admin = await loggedInAs(ADMIN_EMAIL, ADMIN_PASSWORD);
  const self = (await admin.get("/api/auth/me")).json.user;

  assert.equal((await admin.patch(`/api/admin/users/${self.user_id}`, { role: "user" })).status, 400);
  assert.equal((await admin.patch(`/api/admin/users/${self.user_id}`, { is_active: false })).status, 400);
  assert.equal((await admin.delete(`/api/admin/users/${self.user_id}`)).status, 400);

  const email = "second.admin@avocarbon.com";
  await createActiveUser(admin, { email, full_name: "Second Admin", role: "admin", password: "Second-Admin-Pass-1" });
  const second = await loggedInAs(email, "Second-Admin-Pass-1");
  const secondId = (await second.get("/api/auth/me")).json.user.user_id;

  // Two admins: one can demote the other (a user needs a person), but not the last one left.
  const firstAdminPerson = await ensurePersonWithEmail(ADMIN_EMAIL, "First Admin");
  const demoted = await second.patch(`/api/admin/users/${self.user_id}`, { role: "user", people_id: firstAdminPerson });
  assert.equal(demoted.status, 200);
  assert.equal(demoted.json.user.role, "user");
  assert.equal((await admin.get("/api/admin/users")).status, 403, "the role change applies immediately");

  const restored = await second.patch(`/api/admin/users/${self.user_id}`, { role: "admin" });
  assert.equal(restored.json.user.role, "admin");

  const deleted = await admin.delete(`/api/admin/users/${secondId}`);
  assert.equal(deleted.status, 200);
  assert.equal((await second.get(DASHBOARD_API)).status, 401, "a deleted account's sessions are gone");
  const remaining = await admin.get("/api/admin/users");
  assert.ok(!remaining.json.users.some((user) => user.user_id === secondId));
});

test("an admin can revoke a user's sessions", async () => {
  const admin = await loggedInAs(ADMIN_EMAIL, ADMIN_PASSWORD);
  const email = "revoked@avocarbon.com";
  await createActiveUser(admin, { email, full_name: "Revoked", password: "Kick-Secret-2026" });
  const device = await loggedInAs(email, "Kick-Secret-2026");

  const target = (await admin.get("/api/admin/users?search=revoked")).json.users[0];
  assert.equal(target.active_sessions, 1);
  const res = await admin.post(`/api/admin/users/${target.user_id}/revoke-sessions`);
  assert.equal(res.json.sessions_revoked, 1);
  assert.equal((await device.get(DASHBOARD_API)).status, 401);

  const selfId = (await admin.get("/api/auth/me")).json.user.user_id;
  await admin.post(`/api/admin/users/${selfId}/revoke-sessions`);
  assert.equal((await admin.get(DASHBOARD_API)).status, 200, "the admin's own current session is kept");
});

test("cookie-authenticated writes from another site are rejected (CSRF)", async () => {
  const admin = await loggedInAs(ADMIN_EMAIL, ADMIN_PASSWORD);

  const crossSite = await admin.post(DASHBOARD_API, {}, { origin: "https://evil.example" });
  assert.equal(crossSite.status, 403);
  assert.equal(crossSite.json.code, "ORIGIN_NOT_ALLOWED");

  const crossSiteAdmin = await admin.post(
    "/api/admin/users",
    { email: "csrf@avocarbon.com", full_name: "CSRF" },
    { origin: "https://evil.example" }
  );
  assert.equal(crossSiteAdmin.status, 403);

  assert.equal((await admin.post(DASHBOARD_API, {})).status, 200, "same request from the app works");
  assert.equal((await admin.get(DASHBOARD_API, { origin: "https://evil.example" })).status, 200, "reads are not affected");
});

test("admin responses never expose password hashes; actions are audited", async () => {
  const admin = await loggedInAs(ADMIN_EMAIL, ADMIN_PASSWORD);

  const list = await admin.get("/api/admin/users");
  assert.equal(list.status, 200);
  assert.ok(!list.text.includes("password_hash"));
  assert.ok(!list.text.includes("scrypt$"));

  const events = await admin.get("/api/admin/auth-events?limit=500");
  const types = new Set(events.json.events.map((event) => event.event_type));
  for (const type of [
    "login.success",
    "login.failure",
    "logout",
    "account.locked",
    "password.reset_requested",
    "password.reset",
    "password.changed",
    "invite.accepted",
    "user.created",
    "user.updated",
    "user.deleted",
    "user.unlocked",
    "user.sessions_revoked",
    "user.password_link_sent"
  ]) {
    assert.ok(types.has(type), `audit log contains ${type}`);
  }

  const failure = events.json.events.find(
    (event) => event.event_type === "login.failure" && event.details?.reason === "unknown_email"
  );
  assert.ok(failure, "unknown e-mail attempts are logged with their reason");
  assert.ok(!JSON.stringify(events.json).includes("Wrong-password-1"), "passwords are never logged");
});
