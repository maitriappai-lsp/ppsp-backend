// ---------------------------------------------------------------------------
// Real file storage for PSR photos and content uploads. Delegates to
// ../storage.js, which uploads to Cloudflare R2 when configured (persistent
// across restarts/redeploys) or local disk otherwise (fine for local dev,
// not persistent on a host like Render). The route itself doesn't need to
// know or care which one is active.
// ---------------------------------------------------------------------------
const express = require('express');
const multer = require('multer');
const { saveFile } = require('../storage');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

// POST /api/files -- multipart/form-data, field name "file".
// Returns { fileName, storagePath, url } for the client to attach onto the
// uploads/content record it creates via POST /api/uploads or /api/content.
router.post('/', upload.single('file'), async (req, res, next) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided (expected field "file")' });
  try {
    const { storagePath, url } = await saveFile(req.file);
    res.status(201).json({
      fileName: req.file.originalname,
      storagePath,
      url: url || `${req.protocol}://${req.get('host')}${storagePath}`,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
