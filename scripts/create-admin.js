#!/usr/bin/env node
// Creates the first administrator (or promotes an existing account to admin).
//
//   npm run create-admin -- --email ahmed.horri@avocarbon.com
//       asks for the password (hidden input) and sets it.
//   npm run create-admin -- --email someone@avocarbon.com --invite
//       sends an invitation e-mail with a "set your password" link instead.
//
// Only touches the kpi_app_* tables (and reads public.people for the name).

require("dotenv").config();
const readline = require("readline");
const { pool } = require("../src/config/db");
const { createTransporter } = require("../src/config/mailer");
const { loadAuthConfig } = require("../src/config/auth");
const model = require("../src/models/auth.model");
const { createAuthService, normalizeEmail } = require("../src/services/auth.service");
const { hashPassword, getPasswordPolicyErrors, formatPasswordPolicyErrors } = require("../src/utils/password");

const parseArgs = (argv) => {
  const args = { invite: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--invite") args.invite = true;
    else if (arg === "--email") args.email = argv[(index += 1)];
    else if (arg === "--name") args.name = argv[(index += 1)];
  }
  return args;
};

const askHidden = (question) =>
  new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    rl._writeToOutput = (text) => {
      if (!muted) rl.output.write(text);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
    muted = true;
  });

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const email = normalizeEmail(args.email);
  if (!email) {
    console.error("Usage: npm run create-admin -- --email <address> [--name \"Full Name\"] [--invite]");
    process.exitCode = 1;
    return;
  }

  const config = loadAuthConfig();
  await model.ensureAuthSchema(pool);

  const personResult = await pool.query(
    `SELECT people_id, name, first_name FROM public.people WHERE LOWER(TRIM(email)) = $1 ORDER BY people_id LIMIT 1`,
    [email]
  );
  const person = personResult.rows[0] || null;
  const linkedUser = person ? await model.findUserByPeopleId(pool, person.people_id) : null;
  const peopleId = person && (!linkedUser || linkedUser.email === email) ? person.people_id : null;
  const fullName =
    String(args.name || "").trim() ||
    [person?.first_name, person?.name].filter(Boolean).join(" ").trim() ||
    email;

  let passwordHash = null;
  if (!args.invite) {
    if (!process.stdin.isTTY) {
      console.error("No terminal to type a password in: run it in a terminal, or use --invite.");
      process.exitCode = 1;
      return;
    }
    const password = await askHidden(`Password for ${email}: `);
    const errors = getPasswordPolicyErrors(password, { email });
    if (errors.length) {
      console.error(formatPasswordPolicyErrors(errors));
      process.exitCode = 1;
      return;
    }
    if ((await askHidden("Confirm the password: ")) !== password) {
      console.error("The two passwords do not match.");
      process.exitCode = 1;
      return;
    }
    passwordHash = await hashPassword(password);
  }

  const now = new Date();
  let user = await model.findUserByEmail(pool, email);
  if (user) {
    user = await model.updateUserProfile(pool, user.user_id, {
      fullName: user.full_name || fullName,
      peopleId: user.people_id || peopleId,
      role: "admin",
      isActive: true,
      now
    });
  } else {
    user = await model.insertUser(pool, {
      email,
      fullName,
      peopleId,
      role: "admin",
      passwordHash: null,
      mustChangePassword: false,
      createdByUserId: null,
      now
    });
  }
  if (passwordHash) {
    await model.setUserPassword(pool, user.user_id, { passwordHash, mustChangePassword: false, now });
  }
  await model.insertAuthEvent(pool, {
    eventType: "admin.bootstrap",
    userId: user.user_id,
    email,
    details: { mode: args.invite ? "invitation" : "password", via: "scripts/create-admin.js" },
    now
  });

  console.log(`Administrator ready: ${fullName} <${email}> (user_id ${user.user_id}).`);

  if (args.invite) {
    const transporter = createTransporter();
    const authService = createAuthService({
      db: pool,
      config,
      sendMail: (message) => transporter.sendMail(message)
    });
    const delivery = await authService.sendPasswordLink({ user_id: null }, user.user_id, {});
    transporter.close();
    if (delivery.email_sent) {
      console.log(`Invitation e-mail sent to ${email}.`);
    } else {
      console.log(`The e-mail could not be sent (${delivery.email_error}).`);
      console.log(`Open this link to set the password (single use): ${delivery.manual_link}`);
    }
  }
};

main()
  .catch((error) => {
    console.error("create-admin failed:", error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
