const crypto = require("crypto");
const { promisify } = require("util");

const scrypt = promisify(crypto.scrypt);

// scrypt cost: N=2^15 (32 MiB), r=8, p=3 -- one of the OWASP-recommended
// equivalent settings. The parameters are stored in each hash, so they can be
// raised later without invalidating existing passwords.
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 3;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_MAX_MEMORY = 128 * 1024 * 1024;

const PASSWORD_MIN_LENGTH = 10;
const PASSWORD_MAX_LENGTH = 128;

const hashPassword = async (password) => {
  const salt = crypto.randomBytes(16);
  const derivedKey = await scrypt(String(password), salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAX_MEMORY
  });
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64"),
    derivedKey.toString("base64")
  ].join("$");
};

const verifyPassword = async (password, storedHash) => {
  const parts = String(storedHash || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const [, n, r, p, saltBase64, keyBase64] = parts;
  const expectedKey = Buffer.from(keyBase64, "base64");
  const derivedKey = await scrypt(String(password), Buffer.from(saltBase64, "base64"), expectedKey.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT_MAX_MEMORY
  });
  return derivedKey.length === expectedKey.length && crypto.timingSafeEqual(derivedKey, expectedKey);
};

// Returns the list of unmet rules, each phrased to follow "The password must"
// (empty when the password is acceptable).
const getPasswordPolicyErrors = (password, { email = "" } = {}) => {
  const value = String(password ?? "");
  const errors = [];
  if (value.length < PASSWORD_MIN_LENGTH) errors.push(`be at least ${PASSWORD_MIN_LENGTH} characters long`);
  if (value.length > PASSWORD_MAX_LENGTH) errors.push(`be at most ${PASSWORD_MAX_LENGTH} characters long`);
  if (!/[a-z]/.test(value)) errors.push("contain a lowercase letter");
  if (!/[A-Z]/.test(value)) errors.push("contain an uppercase letter");
  if (!/[0-9]/.test(value)) errors.push("contain a digit");

  const emailName = String(email || "").split("@")[0].trim().toLowerCase();
  if (emailName.length >= 4 && value.toLowerCase().includes(emailName)) {
    errors.push("not contain your e-mail name");
  }
  return errors;
};

const formatPasswordPolicyErrors = (errors) => {
  if (!errors.length) return "";
  const list = errors.length === 1 ? errors[0] : `${errors.slice(0, -1).join(", ")} and ${errors[errors.length - 1]}`;
  return `The password must ${list}.`;
};

// Opaque random token handed to the browser (session cookie, reset link); only
// its SHA-256 is stored, so a database leak does not expose usable tokens.
const generateToken = () => crypto.randomBytes(32).toString("base64url");

const hashToken = (token) => crypto.createHash("sha256").update(String(token || "")).digest("hex");

module.exports = {
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  hashPassword,
  verifyPassword,
  getPasswordPolicyErrors,
  formatPasswordPolicyErrors,
  generateToken,
  hashToken
};
