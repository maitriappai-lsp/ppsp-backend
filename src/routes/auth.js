// ---------------------------------------------------------------------------
// Auth: phone + password login (spec section 1 -- no self-signup, Admin
// creates every account, login ID is the phone number). Issues a short-lived
// JWT the client attaches as a Bearer token on every subsequent request.
// ---------------------------------------------------------------------------
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const { rowToRecord } = require('../caseConvert');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

function scrubResource(record) {
  const { passwordHash, ...rest } = record;
  return rest;
}

// Reads and verifies the Bearer token on a request. Returns the token's
// claims ({ sub, role }) or null. /api/auth/* is mounted before requireAuth
// (login has to work without a token), so routes here that need a signed-in
// user must check for themselves.
function verifyBearer(req) {
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }
}

// Minimal in-memory limiter for password guesses on the unauthenticated
// change-password route: 5 wrong attempts per phone number per 15 minutes.
// (Resets if the server restarts, which is fine for this purpose.)
const MAX_FAILED_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const failedAttempts = new Map(); // phone -> { count, resetAt }

function isLockedOut(phone) {
  const entry = failedAttempts.get(phone);
  if (!entry) return false;
  if (Date.now() > entry.resetAt) {
    failedAttempts.delete(phone);
    return false;
  }
  return entry.count >= MAX_FAILED_ATTEMPTS;
}
function recordFailure(phone) {
  const entry = failedAttempts.get(phone);
  if (!entry || Date.now() > entry.resetAt) {
    failedAttempts.set(phone, { count: 1, resetAt: Date.now() + ATTEMPT_WINDOW_MS });
  } else {
    entry.count += 1;
  }
}

router.post('/login', async (req, res, next) => {
  try {
    const { phone, password } = req.body;
    if (!phone || !password) return res.status(400).json({ ok: false, error: 'phone and password are required' });

    const { rows } = await pool.query('SELECT * FROM resources WHERE phone = $1', [phone]);
    if (rows.length === 0) {
      return res.status(401).json({ ok: false, error: 'No account found for that phone number.' });
    }
    const resource = rowToRecord(rows[0]);
    if (resource.active === false) {
      return res.status(401).json({ ok: false, error: 'This account has been deactivated. Contact your Admin.' });
    }
    const match = await bcrypt.compare(password, resource.passwordHash);
    if (!match) {
      return res.status(401).json({ ok: false, error: 'Incorrect password.' });
    }

    const user = scrubResource(resource);
    const token = jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: '12h' });
    res.json({ ok: true, user, token });
  } catch (err) {
    next(err);
  }
});

// POST /auth/change-password { resourceId, newPassword }
// Used for the forced first-login change (and an Admin resetting someone
// else's password). Requires a valid token for the account being changed,
// or an Admin's token -- without this check anyone who guessed a resource
// id could set that account's password.
router.post('/change-password', async (req, res, next) => {
  try {
    const { resourceId, newPassword } = req.body;
    if (!resourceId || !newPassword || newPassword.length < 6) {
      return res.status(400).json({ ok: false, error: 'resourceId and a newPassword of 6+ characters are required' });
    }
    const claims = verifyBearer(req);
    if (!claims) return res.status(401).json({ ok: false, error: 'Sign in required.' });
    if (claims.sub !== resourceId && claims.role !== 'Admin') {
      return res.status(403).json({ ok: false, error: 'You can only change your own password.' });
    }
    const passwordHash = await bcrypt.hash(newPassword, 10);
    const { rows } = await pool.query(
      'UPDATE resources SET password_hash = $1, must_change_password = FALSE WHERE id = $2 RETURNING *',
      [passwordHash, resourceId]
    );
    if (rows.length === 0) return res.status(404).json({ ok: false, error: 'Resource not found' });
    res.json({ ok: true, user: scrubResource(rowToRecord(rows[0])) });
  } catch (err) {
    next(err);
  }
});

// POST /auth/change-password-with-old { phone, currentPassword, newPassword }
// For the Login screen's "Change password": nobody is signed in yet, so the
// person proves who they are with their current password instead of a token.
router.post('/change-password-with-old', async (req, res, next) => {
  try {
    const { phone, currentPassword, newPassword } = req.body;
    if (!phone || !currentPassword || !newPassword) {
      return res.status(400).json({ ok: false, error: 'Phone, current password and new password are required.' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ ok: false, error: 'New password must be at least 6 characters.' });
    }
    if (newPassword === currentPassword) {
      return res.status(400).json({ ok: false, error: 'New password must be different from the current one.' });
    }
    if (isLockedOut(phone)) {
      return res.status(429).json({ ok: false, error: 'Too many incorrect attempts. Try again in 15 minutes.' });
    }

    const { rows } = await pool.query('SELECT * FROM resources WHERE phone = $1', [phone]);
    const resource = rows[0] ? rowToRecord(rows[0]) : null;
    // One message for "no such phone" and "wrong password", so this route
    // can't be used to find out which phone numbers have accounts.
    const match = resource ? await bcrypt.compare(currentPassword, resource.passwordHash) : false;
    if (!resource || !match) {
      recordFailure(phone);
      return res.status(401).json({ ok: false, error: 'Phone number or current password is incorrect.' });
    }
    if (resource.active === false) {
      return res.status(401).json({ ok: false, error: 'This account has been deactivated. Contact your Admin.' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await pool.query(
      'UPDATE resources SET password_hash = $1, must_change_password = FALSE WHERE id = $2',
      [passwordHash, resource.id]
    );
    failedAttempts.delete(phone);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = { router, JWT_SECRET };
