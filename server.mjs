#!/usr/bin/env node
/**
 * Local / Domvs-friendly static server.
 * Serves /ek030 and /ek030/ with relative assets; /api/status.json mirrors status.
 */
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 8787);

const app = express();

app.get('/api/status.json', (_req, res) => {
  const p = path.join(publicDir, 'status.json');
  const alt = path.join(publicDir, 'ek030', 'status.json');
  const file = fs.existsSync(p) ? p : alt;
  res.set('Cache-Control', 'no-store');
  res.sendFile(file);
});

// Canonical dashboard paths
app.use('/ek030', express.static(path.join(publicDir, 'ek030'), {
  extensions: ['html'],
  setHeaders(res, filePath) {
    if (filePath.endsWith('status.json')) {
      res.setHeader('Cache-Control', 'no-store');
    }
  },
}));

app.get(['/ek030', '/ek030/'], (_req, res) => {
  res.sendFile(path.join(publicDir, 'ek030', 'index.html'));
});

app.get('/', (_req, res) => {
  res.redirect(302, '/ek030/');
});

app.listen(PORT, () => {
  console.log(`EK030 dashboard http://127.0.0.1:${PORT}/ek030/`);
});
