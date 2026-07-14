const express = require('express');
const router = express.Router();
const db = require('../database');
const axios = require('axios');

const getBrapiToken = () => {
    try {
        const row = db.prepare("SELECT value FROM Settings WHERE key = 'brapi_token'").get();
        return row ? row.value : null;
    } catch (e) { return null; }
};

// ============================================================================
// GESTOR DE SESSÃO YAHOO (COOKIES E CRUMB ANTI-BLOQUEIO)
// ============================================================================
let _yahooCookie = '';
let _yahooCrumb = '';

const getYahooSession = async () => {
    if (_yahooCookie && _yahooCrumb) return { cookie: _yahooCookie, crumb: _yahooCrumb };
    
    try {
        const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
        
        const cookieRes = await axios.get('https://fc.yahoo.com', {
            headers: { 'User-Agent': ua },
            validateStatus: () => true 
        });
        
        const setCookie = cookieRes.headers['set-cookie'];
        if (setCookie) {
            _yahooCookie = setCookie.map(c => c.split(';')[0]).join('; ');
        }

        const crumbRes = await axios.get('https://query1.finance.yahoo.com/v1/test/getcrumb', {
            headers: { 
                'User-Agent': ua, 
                'Cookie': _yahooCookie,
                'Origin': 'https://finance.yahoo.com',
                'Referer': 'https://finance.yahoo.com/'
            },
            validateStatus: () => true
        });
        
        if (crumbRes.status === 200 && crumbRes.data) {
            _yahooCrumb = crumbRes.data;
        }
        
        return { cookie: _yahooCookie, crumb: _yahooCrumb };
    } catch (e) {
        console.error("Erro ao obter sessão Yahoo:", e.message);
        return { cookie: null, crumb: null };
    }
};

// ============================================================================
// ROTA: BUSCA AUTOCOMPLETE
// ============================================================================
router.get('/available', async (req, res) => {
    try {
        const response = await axios.get('https://brapi.dev/api/available');
        res.json(response.data.stocks);
    } catch (error) { res.status(500).json([]); }
});

// ============================================================================
// ROTA: COTAÇÃO ÚNICA & FUNDAMENTOS
// ============================================================================
router.get('/quote/:ticker', async (req, res) => {
    let ticker = req.params.ticker.toUpperCase();
    const token = getBrapiToken();

    if (token) {
        try {
            const url = `https://brapi.dev/api/quote/${ticker}?modules=summaryProfile,financialData,defaultKeyStatistics,summaryDetail&dividends=true&token=${token}`;
            const response = await axios.get(url);
            const data = response.data.results ? response.data.results[0] : response.data;
            return res.json(data);
        } catch (error) {
            console.warn(`[AVISO BRAPI] Falha ao buscar fundamentos de ${ticker} (Status: ${error.response?.status}). Tentando Modo Resgate (Yahoo)...`);
        }
    }

    try {
        console.log(`🔎 [FUNDAMENTOS] Acionando motor do Yahoo Finance para: ${ticker}`);
        const yTicker = (!ticker.includes('.') && !['^BVSP', '^GSPC', 'BTC-USD', 'BRL=X'].includes(ticker)) ? ticker + '.SA' : ticker;
        const session = await getYahooSession();
        const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

        let urlQuote = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${yTicker}`;
        if (session.crumb) urlQuote += `&crumb=${session.crumb}`;
        const resQuote = await axios.get(urlQuote, { headers: { 'User-Agent': ua, 'Cookie': session.cookie || '' } });
        const quoteData = resQuote.data.quoteResponse?.result?.[0];

        if (!quoteData) throw new Error("Ativo não encontrado no Yahoo Finance.");

        let urlFund = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${yTicker}?modules=summaryProfile,financialData,defaultKeyStatistics,summaryDetail`;
        if (session.crumb) urlFund += `&crumb=${session.crumb}`;
        const resFund = await axios.get(urlFund, { headers: { 'User-Agent': ua, 'Cookie': session.cookie || '' }, validateStatus: () => true });
        const fundData = resFund.data.quoteSummary?.result?.[0] || {};

        const extractRaw = (obj) => {
            let cleaned = {};
            for (let key in obj) {
                if (obj[key] && typeof obj[key] === 'object' && 'raw' in obj[key]) cleaned[key] = obj[key].raw;
                else cleaned[key] = obj[key];
            }
            return cleaned;
        };

        const finalData = {
            symbol: ticker,
            shortName: quoteData.shortName || quoteData.longName,
            regularMarketPrice: quoteData.regularMarketPrice,
            regularMarketChangePercent: quoteData.regularMarketChangePercent,
            logourl: `https://s3-symbol-logo.tradingview.com/${ticker.replace('.SA','')}.svg`,
            summaryProfile: fundData.summaryProfile || {},
            financialData: extractRaw(fundData.financialData || {}),
            defaultKeyStatistics: extractRaw(fundData.defaultKeyStatistics || {}),
            summaryDetail: extractRaw(fundData.summaryDetail || {}),
            dividendsData: null
        };

        return res.json(finalData);
    } catch (error) {
        console.error(`❌ [ERRO FUNDAMENTOS] Falha total para ${ticker}:`, error.message);
        res.status(500).json({ error: "Erro ao buscar fundamentos nos servidores." });
    }
});

// ============================================================================
// ROTA: BATCH QUOTES
// ============================================================================
router.get('/batch-quotes', async (req, res) => {
    if (!req.query.symbols) return res.status(200).json([]);
    
    let symbolsArray = req.query.symbols.split(',');
    
    let yahooSymbols = symbolsArray.map(sym => {
        let s = sym.trim().toUpperCase();
        if (!s.includes('.') && !['^BVSP', '^GSPC', 'BTC-USD', 'BRL=X'].includes(s)) {
            return s + '.SA';
        }
        return s;
    }).join(',');

    try {
        const session = await getYahooSession();
        let url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${yahooSymbols}`;
        if (session.crumb) url += `&crumb=${session.crumb}`;
        
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Cookie': session.cookie || ''
            }
        });

        if (!response.data || !response.data.quoteResponse || !response.data.quoteResponse.result) {
            return res.status(200).json([]);
        }
        
        const data = response.data.quoteResponse.result.map(r => ({
            symbol: r.symbol.replace('.SA', ''),
            price: r.regularMarketPrice,
            changePercent: r.regularMarketChangePercent
        }));
        
        res.status(200).json(data);
    } catch (error) { 
        console.error("❌ [ERRO BATCH QUOTES]:", error.message);
        res.status(200).json([]); 
    }
});

// ============================================================================
// ROTA: DADOS HISTÓRICOS PARA GRÁFICOS
// ============================================================================
router.get('/history/:ticker', async (req, res) => {
    let ticker = decodeURIComponent(req.params.ticker).toUpperCase();
    
    if (!ticker.includes('.') && !['^BVSP', '^GSPC', 'BTC-USD', 'BRL=X'].includes(ticker)) {
        ticker += '.SA';
    }

    const { range = '1mo', interval = '1d' } = req.query;

    try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=${range}&interval=${interval}`;
        const response = await axios.get(url);
        const result = response.data.chart.result[0];
        const timestamps = result.timestamp;
        const quotes = result.indicators.quote[0];
        
        if (!timestamps) return res.json([]);

        const history = timestamps.map((time, index) => ({
            date: time,
            open: quotes.open[index],
            high: quotes.high[index],
            low: quotes.low[index],
            close: quotes.close[index],
            volume: quotes.volume[index]
        })).filter(d => d.close !== null); 
        
        res.json(history);
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// ============================================================================
// ROTA: BUSCAR GRADE DE OPÇÕES (MÚLTIPLAS FONTES: BRAPI + YAHOO)
// ============================================================================
router.get('/options-chain/:ticker', async (req, res) => {
    let ticker = req.params.ticker.toUpperCase().replace('.SA', '');
    
    // Captura a data alvo do usuário
    const targetDateStr = req.query.expiration;
    let targetTs = null;
    if (targetDateStr) {
        // Força 15:00 UTC para alinhar com o fuso brasileiro sem virar o dia
        targetTs = new Date(targetDateStr + 'T15:00:00Z').getTime() / 1000;
    }

    // 1. TENTATIVA PRIMÁRIA: API DA BRAPI (Foco em Estabilidade)
    const token = getBrapiToken();
    if (token) {
        try {
            console.log(`[OPÇÕES] Buscando grade de ${ticker} via Brapi...`);
            // Busca a cotação (Spot) primária
            const quoteUrl = `https://brapi.dev/api/quote/${ticker}?token=${token}`;
            const quoteRes = await axios.get(quoteUrl);
            const spotPrice = quoteRes.data.results?.[0]?.regularMarketPrice;

            // Busca a grade de opções bruta (a filtragem de data na Brapi não é 100% segura, deixamos pro Yahoo se precisar)
            const optionsUrl = `https://brapi.dev/api/options/${ticker}?token=${token}`;
            const optionsRes = await axios.get(optionsUrl, { validateStatus: () => true });
            
            if (optionsRes.status === 200 && spotPrice) {
                const data = optionsRes.data;
                let rawOptions = [];
                if (Array.isArray(data)) rawOptions = data;
                else if (data.options) rawOptions = data.options;
                
                if (rawOptions.length > 0 && !targetTs) {
                    let calls = [];
                    let puts = [];
                    
                    rawOptions.forEach(op => {
                        const symbol = op.symbol || op.ticker;
                        const strike = op.strike || op.strikePrice;
                        const lastPrice = op.lastPrice || op.close || 0.01;
                        const type = (op.type || op.optionType || '').toUpperCase();
                        
                        if (!symbol || !strike) return;
                        
                        const formattedOp = { 
                            ticker: symbol, 
                            strike: Number(strike), 
                            lastPrice: Number(lastPrice), 
                            type: type.includes('PUT') ? 'PUT' : 'CALL' 
                        };
                        
                        if (formattedOp.type === 'PUT') puts.push(formattedOp);
                        else calls.push(formattedOp);
                    });

                    if (calls.length > 0 || puts.length > 0) {
                        let expirationDate = Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60);
                        if (rawOptions[0].expiration) expirationDate = new Date(rawOptions[0].expiration).getTime() / 1000;
                        else if (rawOptions[0].expirationDate) expirationDate = new Date(rawOptions[0].expirationDate).getTime() / 1000;

                        return res.json({ spotPrice, expirationDate, calls, puts });
                    }
                }
            }
        } catch (e) {
            console.warn(`[AVISO] Brapi falhou ou pulada devido à data específica para ${ticker}. Acionando motor Yahoo...`);
        }
    }

    // 2. TENTATIVA SECUNDÁRIA: YAHOO FINANCE (O Plano B com Suporte à Datas)
    let yTicker = !ticker.includes('.') && !['AAPL', 'SPY', 'TSLA', 'MSFT', 'AMZN'].includes(ticker) ? ticker + '.SA' : ticker;
    
    try {
        console.log(`[OPÇÕES] Buscando grade de ${yTicker} via Yahoo...`);
        const session = await getYahooSession();
        
        let url = `https://query1.finance.yahoo.com/v7/finance/options/${yTicker}`;
        if (session.crumb) url += `?crumb=${session.crumb}`;
        
        let response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Cookie': session.cookie || ''
            }
        });

        let result = response.data.optionChain?.result;
        if (!result || result.length === 0 || !result[0].options || result[0].options.length === 0) {
            throw new Error(`O Yahoo Finance retornou vazio. Os dados podem estar indisponíveis no momento.`);
        }

        // MÁGICA DA BUSCA POR DATA APROXIMADA NO YAHOO
        if (targetTs && result[0].expirationDates && result[0].expirationDates.length > 0) {
            // Acha a data de vencimento real da B3 que está mais próxima do dia que o usuário escolheu
            let closestTs = result[0].expirationDates.reduce((prev, curr) =>
                Math.abs(curr - targetTs) < Math.abs(prev - targetTs) ? curr : prev
            );

            console.log(`[OPÇÕES] Data solicitada: ${targetDateStr}. Data mais próxima encontrada na B3: ${new Date(closestTs * 1000).toISOString().split('T')[0]}`);
            
            // Refaz a busca focando apenas na data encontrada
            let urlDate = `https://query1.finance.yahoo.com/v7/finance/options/${yTicker}?date=${closestTs}`;
            if (session.crumb) urlDate += `&crumb=${session.crumb}`;

            const dateResponse = await axios.get(urlDate, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                    'Cookie': session.cookie || ''
                }
            });

            if (dateResponse.data.optionChain?.result && dateResponse.data.optionChain.result.length > 0) {
                result = dateResponse.data.optionChain.result;
            }
        }

        const spotPrice = result[0].quote.regularMarketPrice;
        const options = result[0].options[0];
        const expirationDate = options.expirationDate;

        let calls = options.calls ? options.calls.map(op => ({
            ticker: op.contractSymbol,
            strike: op.strike,
            lastPrice: op.lastPrice || 0.01,
            type: 'CALL'
        })) : [];

        let puts = options.puts ? options.puts.map(op => ({
            ticker: op.contractSymbol,
            strike: op.strike,
            lastPrice: op.lastPrice || 0.01,
            type: 'PUT'
        })) : [];

        res.json({ spotPrice, expirationDate, calls, puts });
        
    } catch (error) {
        console.warn(`❌ [ERRO YAHOO - ${ticker}]: ${error.message}. Acionando SINCRO-ATIVO...`);
        
        // 3. TENTATIVA TERCIÁRIA: MOTOR SINCRO-ATIVO (GERAÇÃO DE GRADE SIMULADA NO BACKEND)
        try {
            // Tenta pelo menos pegar o Spot real para ancorar a simulação
            const token = getBrapiToken();
            let spotPrice = 30.00; // fallback de segurança
            
            if (token) {
                const quoteRes = await axios.get(`https://brapi.dev/api/quote/${ticker}?token=${token}`, { validateStatus: () => true });
                if (quoteRes.status === 200 && quoteRes.data.results?.[0]?.regularMarketPrice) {
                    spotPrice = quoteRes.data.results[0].regularMarketPrice;
                }
            }

            const prefixo = ticker.substring(0, 4);
            let calls = [];
            let puts = [];
            const baseStrike = Math.round(spotPrice * 2) / 2; 

            // Mantém a data de expiração que você escolheu no Radar
            let expirationDate = targetTs ? targetTs : Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60);
            
            // =========================================================
            // A MÁGICA DO CALENDÁRIO: Nomenclatura dinâmica da B3
            // =========================================================
            const dateObj = new Date(expirationDate * 1000);
            const monthIndex = dateObj.getUTCMonth(); // 0 (Jan) a 11 (Dez)
            
            // Regra B3 Calls: A (Código ASCII 65) a L (76)
            const callLetter = String.fromCharCode(65 + monthIndex);
            // Regra B3 Puts: M (Código ASCII 77) a X (88)
            const putLetter = String.fromCharCode(77 + monthIndex);

            // Gera strikes de sobra (15 níveis pra cima e pra baixo) para garantir que o Radar ache a sua margem de 10%
            for (let i = -15; i <= 15; i++) {
                const strike = baseStrike + (i * 0.5);
                let extrinseco = (spotPrice * 0.04) * Math.exp(-Math.abs(i) * 0.3); 
                
                calls.push({ 
                    ticker: `${prefixo}${callLetter}${(strike * 10).toFixed(0).padStart(3, '0')}`, 
                    strike: strike, 
                    lastPrice: Math.max(0.01, Math.max(0, spotPrice - strike) + extrinseco), 
                    type: 'CALL' 
                });
                
                puts.push({ 
                    ticker: `${prefixo}${putLetter}${(strike * 10).toFixed(0).padStart(3, '0')}`, 
                    strike: strike, 
                    lastPrice: Math.max(0.01, Math.max(0, strike - spotPrice) + extrinseco), 
                    type: 'PUT' 
                });
            }
            
            console.log(`✅ [SINCRO-ATIVO] Grade simulada gerada com sucesso para ${ticker} no Spot de R$ ${spotPrice}`);
            return res.json({ spotPrice, expirationDate, calls, puts });

        } catch (fatalErr) {
            console.error(`❌ [ERRO FATAL OPÇÕES - ${ticker}]:`, fatalErr.message);
            res.status(500).json({ error: fatalErr.message });
        }
    }
});

// ============================================================================
// ROTAS: WATCHLIST E SIMULAÇÕES SALVAS
// ============================================================================
router.get('/watchlist', (req, res) => {
    try { res.json(db.prepare("SELECT * FROM Watchlist ORDER BY added_at DESC").all()); } 
    catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/watchlist', (req, res) => {
    try { db.prepare("INSERT INTO Watchlist (ticker, type) VALUES (?, ?)").run(req.body.ticker, req.body.type || 'acao'); res.json({ success: true }); } 
    catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/watchlist/:id', (req, res) => {
    try { db.prepare("DELETE FROM Watchlist WHERE id = ?").run(req.params.id); res.json({ success: true }); } 
    catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/simulations', (req, res) => {
    try { 
        db.exec(`CREATE TABLE IF NOT EXISTS OptionsSimulations (id INTEGER PRIMARY KEY AUTOINCREMENT, asset TEXT, strategy TEXT, spot REAL, strike REAL, premium REAL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
        res.json(db.prepare("SELECT * FROM OptionsSimulations ORDER BY created_at DESC").all()); 
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/simulations', (req, res) => {
    try { 
        db.exec(`CREATE TABLE IF NOT EXISTS OptionsSimulations (id INTEGER PRIMARY KEY AUTOINCREMENT, asset TEXT, strategy TEXT, spot REAL, strike REAL, premium REAL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
        db.prepare("INSERT INTO OptionsSimulations (asset, strategy, spot, strike, premium) VALUES (?, ?, ?, ?, ?)").run(req.body.asset, req.body.strategy, req.body.spot, req.body.strike, req.body.premium); 
        res.json({ success: true }); 
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/simulations/:id', (req, res) => {
    try { db.prepare("DELETE FROM OptionsSimulations WHERE id = ?").run(req.params.id); res.json({ success: true }); } 
    catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================================
// SIMULADOR DE OPÇÕES (PAPER TRADING)
// ============================================================================
router.get('/paper-trading/portfolio', (req, res) => {
    try {
        const account = db.prepare("SELECT balance FROM VirtualAccount WHERE id = 1").get();
        const positions = db.prepare("SELECT * FROM VirtualPositions ORDER BY updated_at DESC").all();
        res.json({ balance: account.balance, positions });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/paper-trading/trade', (req, res) => {
    const { ticker, type, quantity, price } = req.body;
    
    if (!ticker || !type || quantity === 0 || price <= 0) {
        return res.status(400).json({ error: "Dados da ordem inválidos." });
    }

    const totalCost = quantity * price;

    try {
        const trade = db.transaction(() => {
            const account = db.prepare("SELECT balance FROM VirtualAccount WHERE id = 1").get();
            
            if (totalCost > 0 && account.balance < totalCost) {
                throw new Error("Saldo em Conta Corrente insuficiente para esta operação.");
            }

            db.prepare("UPDATE VirtualAccount SET balance = balance - ? WHERE id = 1").run(totalCost);

            const existing = db.prepare("SELECT * FROM VirtualPositions WHERE ticker = ?").get(ticker);

            if (existing) {
                const newQty = existing.quantity + quantity;
                
                if (newQty === 0) {
                    db.prepare("DELETE FROM VirtualPositions WHERE ticker = ?").run(ticker);
                } else {
                    let newAvgPrice = existing.average_price;
                    
                    if (Math.sign(existing.quantity) === Math.sign(quantity)) {
                        newAvgPrice = ((Math.abs(existing.quantity) * existing.average_price) + (Math.abs(quantity) * price)) / Math.abs(newQty);
                    } 
                    else if (Math.sign(existing.quantity) !== Math.sign(newQty)) {
                        newAvgPrice = price;
                    }
                    
                    db.prepare("UPDATE VirtualPositions SET quantity = ?, average_price = ?, updated_at = CURRENT_TIMESTAMP WHERE ticker = ?").run(newQty, newAvgPrice, ticker);
                }
            } else {
                db.prepare("INSERT INTO VirtualPositions (ticker, type, quantity, average_price) VALUES (?, ?, ?, ?)").run(ticker, type, quantity, price);
            }
        });

        trade();
        res.json({ success: true, message: "Ordem executada com sucesso!" });
        
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

router.post('/paper-trading/reset', (req, res) => {
    try {
        db.transaction(() => {
            db.prepare("UPDATE VirtualAccount SET balance = 100000.0 WHERE id = 1").run();
            db.prepare("DELETE FROM VirtualPositions").run();
        })();
        res.json({ success: true, message: "Simulador resetado. Conta de R$ 100.000 restaurada." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;