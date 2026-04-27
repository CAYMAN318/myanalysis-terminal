const express = require('express');
const router = express.Router();
const db = require('../database');
const fs = require('fs');
const multer = require('multer');
const os = require('os');
const { app } = require('electron');

const upload = multer({ dest: os.tmpdir() });

// ============================================================================
// 1. GESTÃO DE CHAVES DE API (SETTINGS)
// ============================================================================
router.get('/settings/:key', (req, res) => {
    try {
        const row = db.prepare("SELECT value FROM Settings WHERE key = ?").get(req.params.key);
        res.json({ value: row ? row.value : "" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/settings', (req, res) => {
    const { key, value } = req.body;
    try {
        db.prepare("INSERT INTO Settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================================
// 2. BACKUP E RESTORE (Preparado, se decidirmos usar depois)
// ============================================================================
router.get('/system/backup', (req, res) => {
    const dbPath = db.name; 
    if (fs.existsSync(dbPath)) {
        res.download(dbPath, `myanalysis_backup_${new Date().toISOString().split('T')[0]}.db`);
    } else {
        res.status(404).json({ error: "Banco de dados não encontrado no servidor." });
    }
});

router.post('/system/restore', upload.single('database'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "Nenhum arquivo enviado." });
    
    const tempPath = req.file.path;
    const dbPath = db.name; 

    try {
        db.close(); 
        fs.copyFileSync(tempPath, dbPath);
        fs.unlinkSync(tempPath); 
        
        setTimeout(() => {
            app.relaunch();
            app.exit(0);
        }, 1000);

        res.json({ success: true, message: "Backup restaurado com sucesso. Reiniciando..." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;