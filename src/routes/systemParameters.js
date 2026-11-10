// App-wide system parameters. Read through GET /api/db; writes are Admin-only.
const express = require('express');
const pool = require('../db');
const { rowToRecord } = require('../caseConvert');

const router = express.Router();

const ALLOWED_UPLOAD_TYPES = new Set(['photo', 'pdf', 'ppt']);

function validDate(value) {
  if (value == null || value === '') return true;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

router.post('/', async (req, res, next) => {
  if (req.user?.role !== 'Admin') {
    return res.status(403).json({ error: 'Only an Admin can change system parameters.' });
  }

  try {
    const body = req.body || {};
    const productType = typeof body.productType === 'string' ? body.productType.trim() : '';
    const orgName = typeof body.orgName === 'string' ? body.orgName.trim() : '';
    const maxNamedUsers = Number(body.maxNamedUsers);
    const productValidityEnd = body.productValidityEnd || null;
    const loginByEmail = body.loginByEmail;
    const gpsOnBeneficiary = body.gpsOnBeneficiary;
    const allowedUploadTypes = body.allowedUploadTypes;

    if (!productType) return res.status(400).json({ error: 'Product type is required.' });
    if (!orgName) return res.status(400).json({ error: 'Organisation name is required.' });
    if (!Number.isInteger(maxNamedUsers) || maxNamedUsers < 1) {
      return res.status(400).json({ error: 'Maximum named users must be a whole number greater than zero.' });
    }
    if (!validDate(productValidityEnd)) {
      return res.status(400).json({ error: 'Product validity end date must use YYYY-MM-DD format.' });
    }
    if (typeof loginByEmail !== 'boolean' || typeof gpsOnBeneficiary !== 'boolean') {
      return res.status(400).json({ error: 'Login and GPS settings must be true or false.' });
    }
    if (
      !Array.isArray(allowedUploadTypes) ||
      allowedUploadTypes.some((type) => typeof type !== 'string' || !ALLOWED_UPLOAD_TYPES.has(type))
    ) {
      return res.status(400).json({ error: 'Allowed upload types must contain only photo, pdf or ppt.' });
    }

    const { rows } = await pool.query(
      `INSERT INTO system_parameters
         (id, product_type, org_name, max_named_users, product_validity_end,
          login_by_email, gps_on_beneficiary, allowed_upload_types)
       VALUES (TRUE, $1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         product_type = EXCLUDED.product_type,
         org_name = EXCLUDED.org_name,
         max_named_users = EXCLUDED.max_named_users,
         product_validity_end = EXCLUDED.product_validity_end,
         login_by_email = EXCLUDED.login_by_email,
         gps_on_beneficiary = EXCLUDED.gps_on_beneficiary,
         allowed_upload_types = EXCLUDED.allowed_upload_types
       RETURNING *`,
      [
        productType,
        orgName,
        maxNamedUsers,
        productValidityEnd,
        loginByEmail,
        gpsOnBeneficiary,
        JSON.stringify(allowedUploadTypes),
      ]
    );

    res.json(rowToRecord(rows[0]));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
