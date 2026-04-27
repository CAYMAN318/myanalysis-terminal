const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

/**
 * Lógica de Isolamento de Dados:
 * Criando banco de dados específico para o MyAnalysis.
 */
const userDataPath = app.getPath('userData');
const dbPath = path.join(userDataPath, 'bd_myanalysis.db');

// Garante que a pasta userData existe
if (!fs.existsSync(userDataPath)) {
    fs.mkdirSync(userDataPath, { recursive: true });
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// 1. Inicialização das Tabelas do MyAnalysis
db.exec(`
    -- Tabela para salvar ativos favoritos para acompanhamento rápido
    CREATE TABLE IF NOT EXISTS Watchlist (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticker TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL, -- 'acao', 'fii', 'bdr'
        added_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Tabela para salvar as simulações de opções que você criar
    CREATE TABLE IF NOT EXISTS SavedSimulations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        strategy_type TEXT, -- 'covered_call', 'straddle', 'iron_condor' etc.
        parameters_json TEXT NOT NULL, -- Guarda todos os inputs (spot, strike, premio, etc)
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Configurações gerais (Ex: Token da Brapi)
    CREATE TABLE IF NOT EXISTS Settings (
        key TEXT PRIMARY KEY,
        value TEXT
    );
`);

module.exports = db;