// ---------------------------------------------------------------------------
// File storage abstraction: uploads a file buffer to Cloudflare R2 (an
// S3-compatible object store) when R2_* env vars are set, or falls back to
// local disk under backend/uploads/ otherwise (e.g. local development
// without R2 credentials configured). Local disk works fine for testing on
// your own machine, but doesn't survive a redeploy/restart on a host like
// Render -- R2 does, and its free tier (10GB, no egress fees, nothing
// deleted for inactivity) is what makes uploads actually persistent.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const r2Configured = !!(
  process.env.R2_ACCOUNT_ID &&
  process.env.R2_ACCESS_KEY_ID &&
  process.env.R2_SECRET_ACCESS_KEY &&
  process.env.R2_BUCKET_NAME &&
  process.env.R2_PUBLIC_URL_BASE
);

let s3Client = null;
let PutObjectCommand = null;
if (r2Configured) {
  // Only required when actually configured, so local-disk-only setups
  // don't need @aws-sdk/client-s3 installed at all.
  const { S3Client, PutObjectCommand: POC } = require('@aws-sdk/client-s3');
  PutObjectCommand = POC;
  s3Client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
  console.log('File storage: Cloudflare R2 (persistent)');
} else {
  console.log('File storage: local disk (backend/uploads/) -- not persistent on hosts like Render');
}

function keyFor(originalName) {
  const unique = crypto.randomBytes(8).toString('hex');
  return `${Date.now()}-${unique}${path.extname(originalName)}`;
}

// Returns { storagePath, url }. For R2, url is the final public URL. For
// local disk, url is null -- the caller builds a full URL from the current
// request's host, since there's no fixed public address for a local file.
async function saveFile(file) {
  const key = keyFor(file.originalname);

  if (r2Configured) {
    await s3Client.send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
      })
    );
    return {
      storagePath: key,
      url: `${process.env.R2_PUBLIC_URL_BASE.replace(/\/$/, '')}/${key}`,
    };
  }

  const dir = path.join(__dirname, '..', '..', 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, key), file.buffer);
  return { storagePath: `/uploads/${key}`, url: null };
}

module.exports = { saveFile, r2Configured };
