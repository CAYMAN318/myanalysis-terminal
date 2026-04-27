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
            headers: { 'User-Agent': ua, 'Cookie': _yahooCookie }
        });
        _yahooCrumb = crumbRes.data;
        
        return { cookie: _yahooCookie, crumb: _yahooCrumb };
    } catch (e) {
        console.error("⚠️ [Aviso] Falha ao gerar Crumb do Yahoo:", e.message);
        return { cookie: '', crumb: '' };
    }
};

const fetchWithSession = async (url) => {
    let session = await getYahooSession();
    const separator = url.includes('?') ? '&' : '?';
    let finalUrl = `${url}${separator}crumb=${session.crumb}`;
    
    try {
        return await axios.get(finalUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0',
                'Cookie': session.cookie,
                'Accept': 'application/json'
            }
        });
    } catch (e) {
        if (e.response && e.response.status === 401) {
            _yahooCookie = ''; _yahooCrumb = '';
            session = await getYahooSession();
            finalUrl = `${url}${separator}crumb=${session.crumb}`;
            return await axios.get(finalUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': session.cookie }
            });
        }
        throw e;
    }
};

// Formata o Ticker corretamente para o Yahoo (Ignora índices e moedas)
const formatTickerForYahoo = (ticker) => {
    if (ticker.startsWith('^') || ticker.includes('=') || ticker.includes('-USD')) return ticker;
    return ticker.includes('.SA') ? ticker : `${ticker}.SA`;
};

// ============================================================================
// 1. AUTOCOMPLETE: LISTA DE TICKERS EM CACHE
// ============================================================================
let cachedTickers = [];
router.get('/available', async (req, res) => {
    if (cachedTickers.length > 0) return res.json(cachedTickers);
    try {
        const response = await axios.get('https://brapi.dev/api/available');
        cachedTickers = response.data.stocks;
        res.json(cachedTickers);
    } catch (error) { res.json([]); } 
});

// ============================================================================
// 2. BUSCAR COTAÇÕES EM LOTE (NOVO MÓDULO DASHBOARD)
// ============================================================================
router.get('/batch-quotes', async (req, res) => {
    try {
        const symbolsParam = req.query.symbols;
        if (!symbolsParam) return res.json([]);

        const symbolsArray = symbolsParam.split(',').map(formatTickerForYahoo);
        const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbolsArray.join(',')}`;
        
        const response = await fetchWithSession(url);
        const results = response.data?.quoteResponse?.result || [];
        
        const mapped = results.map(yf => ({
            symbol: yf.symbol.replace('.SA', ''),
            name: yf.shortName || yf.longName || yf.symbol,
            price: yf.regularMarketPrice,
            changePercent: yf.regularMarketChangePercent,
            changeValue: yf.regularMarketChange
        }));

        res.json(mapped);
    } catch (error) {
        console.error(`\n❌ [ERRO BATCH QUOTES]:`, error.message);
        res.status(500).json({ error: "Erro ao buscar cotações em lote." });
    }
});

// ============================================================================
// 3. BUSCAR COTAÇÃO E FUNDAMENTOS
// ============================================================================
router.get('/quote/:ticker', async (req, res) => {
    try {
        const { ticker } = req.params;
        const tickerSA = formatTickerForYahoo(ticker);
        const token = getBrapiToken();

        const urlFund = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${tickerSA}?modules=summaryProfile,defaultKeyStatistics,financialData,price,summaryDetail`;
        const urlDiv = `https://query1.finance.yahoo.com/v8/finance/chart/${tickerSA}?interval=1mo&range=5y&events=div`;
        const urlBrapiProfile = `https://brapi.dev/api/quote/${ticker}?token=${token}&modules=summaryProfile`;

        const [resFund, resDiv, resProfile] = await Promise.all([
            fetchWithSession(urlFund).catch(e => null),
            fetchWithSession(urlDiv).catch(e => null),
            token ? axios.get(urlBrapiProfile).catch(e => null) : Promise.resolve(null)
        ]);

        if (!resFund || !resFund.data?.quoteSummary?.result) {
            return res.status(404).json({ error: "Ativo não encontrado ou sem fundamentos disponíveis." });
        }

        const yf = resFund.data.quoteSummary.result[0];
        const brapiData = resProfile?.data?.results?.[0] || {};
        
        const cashDividends = [];
        if (resDiv && resDiv.data?.chart?.result?.[0]?.events?.dividends) {
            const divs = resDiv.data.chart.result[0].events.dividends;
            for (const key in divs) {
                cashDividends.push({ rate: divs[key].amount, paymentDate: new Date(divs[key].date * 1000).toISOString() });
            }
        }

        const roeCalculated = (yf.epsTrailingTwelveMonths && yf.bookValue && yf.bookValue !== 0) ? (yf.epsTrailingTwelveMonths / yf.bookValue) : null;

        const mappedData = {
            symbol: ticker.replace('.SA', '').toUpperCase(),
            shortName: yf.price?.shortName || ticker.toUpperCase(),
            logourl: brapiData.logourl || null,
            regularMarketPrice: yf.price?.regularMarketPrice?.raw,
            regularMarketChangePercent: (yf.price?.regularMarketChangePercent?.raw || 0) * 100,
            summaryProfile: yf.summaryProfile || brapiData.summaryProfile || {},
            defaultKeyStatistics: {
                trailingPE: yf.defaultKeyStatistics?.trailingPE?.raw, priceToBook: yf.defaultKeyStatistics?.priceToBook?.raw,
                bookValue: yf.defaultKeyStatistics?.bookValue?.raw, trailingEps: yf.defaultKeyStatistics?.trailingEps?.raw
            },
            financialData: { returnOnEquity: roeCalculated, returnOnAssets: null, profitMargins: null, debtToEquity: null },
            summaryDetail: { dividendYield: yf.summaryDetail?.dividendYield?.raw },
            dividendsData: { cashDividends: cashDividends }
        };

        res.json(mappedData);
    } catch (error) {
        res.status(500).json({ error: "Erro interno do servidor ao processar fundamentos." }); 
    }
});

// ============================================================================
// 4. GRADE DE OPÇÕES (OPTIONS CHAIN VIA YAHOO FINANCE)
// ============================================================================
router.get('/options-chain/:ticker', async (req, res) => {
    try {
        const { ticker } = req.params;
        const tickerSA = formatTickerForYahoo(ticker);
        const url = `https://query1.finance.yahoo.com/v7/finance/options/${tickerSA}`;
        const response = await fetchWithSession(url);
        
        const result = response.data?.optionChain?.result?.[0];
        if (!result || !result.options || result.options.length === 0) throw new Error("Nenhuma opção listada para este ativo no momento.");

        const spotPrice = result.quote.regularMarketPrice;
        const optionsData = result.options[0];
        const expirationDate = optionsData.expirationDate; 
        
        const calls = optionsData.calls.map(c => ({ ticker: c.contractSymbol, strike: c.strike, lastPrice: c.lastPrice, type: 'CALL' }));
        const puts = optionsData.puts.map(p => ({ ticker: p.contractSymbol, strike: p.strike, lastPrice: p.lastPrice, type: 'PUT' }));

        res.json({ underlying: ticker.replace('.SA', ''), spotPrice, expirationDate, calls, puts });
    } catch (error) {
        res.status(500).json({ error: "Erro ao buscar a grade de opções." });
    }
});

// ============================================================================
// 5. INTEGRAÇÃO OPÇÕES: BUSCA SPOT E PRÊMIO
// ============================================================================
router.get('/quote-option/:optionTicker', async (req, res) => {
    const token = getBrapiToken();
    if (!token) return res.status(401).json({ error: "Token não configurado." });

    try {
        const optionTicker = req.params.optionTicker.toUpperCase();
        const underlying = optionTicker.substring(0, 5); 
        const optRes = await axios.get(`https://brapi.dev/api/quote/${optionTicker}?token=${token}`);
        const spotRes = await axios.get(`https://brapi.dev/api/quote/${underlying}?token=${token}`);
        res.json({ underlying, optionTicker, spot: spotRes.data.results[0].regularMarketPrice, premio: optRes.data.results[0].regularMarketPrice });
    } catch (error) { res.status(500).json({ error: "Erro extrair opção." }); }
});

// ============================================================================
// 6. HISTÓRICO DE COTAÇÕES
// ============================================================================
router.get('/history/:ticker', async (req, res) => {
    try {
        const { ticker } = req.params;
        const range = req.query.range || '6mo';
        const interval = req.query.interval || '1d';

        if (ticker.length < 3) return res.status(400).json({ error: "Ticker inválido ou muito curto." });

        const tickerSA = formatTickerForYahoo(ticker);
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${tickerSA}?range=${range}&interval=${interval}`;
        
        const response = await fetchWithSession(url);
        const result = response.data?.chart?.result?.[0];
        
        if (!result || !result.timestamp || !result.indicators?.quote?.[0]) throw new Error("Dados históricos não encontrados.");

        const timestamps = result.timestamp;
        const quote = result.indicators.quote[0];

        const history = timestamps.map((t, index) => ({
            date: t, close: quote.close[index], open: quote.open[index],
            high: quote.high[index], low: quote.low[index], volume: quote.volume[index]
        })).filter(d => d.close !== null && d.close !== undefined);

        if (history.length === 0) throw new Error("Nenhum histórico válido.");
        res.json(history);
    } catch (error) {
        res.status(500).json({ error: "Erro ao buscar histórico." });
    }
});

// ============================================================================
// 7. BANCO DE DADOS LOCAL (CRUD WATCHLIST E SIMULAÇÕES)
// ============================================================================
router.get('/watchlist', (req, res) => {
    try { res.json(db.prepare("SELECT * FROM Watchlist ORDER BY added_at DESC").all()); } catch (err) { res.status(500).json({ error: err.message }); }
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
        db.exec(`CREATE TABLE IF NOT EXISTS SavedSimulations (id INTEGER PRIMARY KEY AUTOINCREMENT, asset TEXT, strategy TEXT, spot REAL, strike REAL, premium REAL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
        res.json(db.prepare("SELECT * FROM SavedSimulations ORDER BY created_at DESC").all()); 
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/simulations', (req, res) => {
    try { db.prepare("INSERT INTO SavedSimulations (asset, strategy, spot, strike, premium) VALUES (?, ?, ?, ?, ?)").run(req.body.asset, req.body.strategy, req.body.spot, req.body.strike, req.body.premium); res.json({ success: true }); } 
    catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/simulations/:id', (req, res) => {
    try { db.prepare("DELETE FROM SavedSimulations WHERE id = ?").run(req.params.id); res.json({ success: true }); } 
    catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;