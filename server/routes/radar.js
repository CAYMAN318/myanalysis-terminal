const express = require('express');
const router = express.Router();
const db = require('../database');
const axios = require('axios'); 

// ============================================================================
// GESTÃO DA LISTA DE ALVOS (TICKERS FAVORITOS)
// ============================================================================
router.get('/targets', (req, res) => {
    try {
        const targets = db.prepare("SELECT * FROM RadarTargets ORDER BY added_at DESC").all();
        res.json(targets);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/targets', (req, res) => {
    try {
        const ticker = req.body.ticker.toUpperCase().trim();
        db.prepare("INSERT OR IGNORE INTO RadarTargets (ticker) VALUES (?)").run(ticker);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/targets/:ticker', (req, res) => {
    try {
        db.prepare("DELETE FROM RadarTargets WHERE ticker = ?").run(req.params.ticker);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================================
// MOTOR DE VARREDURA E FILTRAGEM (INTEGRADO COM A BRAPI/YAHOO)
// ============================================================================
router.post('/scan', async (req, res) => {
    // Recebe os parâmetros, incluindo a Data Alvo
    const { tickers, type, marginMin, marginMax, targetDate } = req.body;

    if (!tickers || tickers.length === 0) {
        return res.status(400).json({ error: "Nenhum ativo selecionado para o radar." });
    }

    let resultados = [];
    const port = req.socket.localPort || 3002; 

    // Varre cada ativo da lista
    for (const ticker of tickers) {
        try {
            console.log(`[RADAR] Rastreando ${ticker}...`);
            
            // Acopla a data na URL se o usuário preencheu no frontend
            let apiUrl = `http://localhost:${port}/api/brapi/options-chain/${ticker}`;
            if (targetDate) apiUrl += `?expiration=${targetDate}`;

            const response = await axios.get(apiUrl);
            
            const data = response.data; 
            const spot = data.spotPrice;
            const options = type === 'PUT' ? data.puts : data.calls;

            // 1. A Matemática da sua Zona de Segurança
            let strikeMin, strikeMax;
            
            if (type === 'PUT') {
                strikeMax = spot * (1 - (marginMin / 100));
                strikeMin = spot * (1 - (marginMax / 100));
            } else { // CALL
                strikeMin = spot * (1 + (marginMin / 100));
                strikeMax = spot * (1 + (marginMax / 100));
            }

            // 2. Filtra a grade jogando fora tudo que não está na sua margem
            const filteredOptions = options.filter(op => op.strike >= strikeMin && op.strike <= strikeMax);

            // 3. Monta o pacote de dados limpo para a tela
            const hoje = Date.now();
            const vencimento = data.expirationDate * 1000;
            const diasFaltantes = Math.max(0, Math.ceil((vencimento - hoje) / (1000 * 60 * 60 * 24)));
            
            const vencimentoStr = new Date(vencimento).toLocaleDateString('pt-BR', { timeZone: 'UTC' });

            for (const op of filteredOptions) {
                const distance = (Math.abs(spot - op.strike) / spot) * 100;
                
                // Filtro extra: Ignora opções com prêmio muito baixo (sem liquidez)
                if (op.lastPrice >= 0.02) {
                    resultados.push({
                        asset: ticker,
                        spot: spot,
                        optionTicker: op.ticker,
                        type: type,
                        strike: op.strike,
                        distance: Number(distance.toFixed(2)),
                        premium: op.lastPrice,
                        daysToExpiry: diasFaltantes,
                        expirationDateStr: vencimentoStr
                    });
                }
            }

        } catch (err) {
            console.log(`[RADAR] Falha ou sem opções para ${ticker}: ${err.message}`);
        }
    }

    // Ordena mostrando as opções mais distantes e mais gordinhas
    resultados.sort((a, b) => b.premium - a.premium);
    res.json(resultados);
});

module.exports = router;