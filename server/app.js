const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const db = require('./database'); 

const app = express();

app.use(cors());
app.use(bodyParser.json());

// Serve os arquivos do frontend
const staticPath = path.join(__dirname, '../src');
const configuracoesRoutes = require('./routes/configuracoes');
app.use('/api/configuracoes', configuracoesRoutes);

const brapiRoutes = require('./routes/brapi');
app.use('/api/brapi', brapiRoutes);

// NOVO: ROTA DO RADAR
const radarRoutes = require('./routes/radar');
app.use('/api/radar', radarRoutes);

// Fallback para abrir a index.html (SPA Pattern com iframes)
app.get('/', (req, res) => {
    res.sendFile('index.html', { root: staticPath });
});

let serverInstance = null;

/**
 * Inicia o servidor Express na porta especificada (padrão 3002 para MyAnalysis)
 */
const startServer = (port = 3002) => {
    if (serverInstance) return serverInstance;
    serverInstance = app.listen(port, () => {
        console.log(`>>> [MYANALYSIS] Servidor operacional na porta ${port}`);
    });
    return serverInstance;
};

/**
 * Encerra o servidor de forma limpa
 */
const stopServer = () => {
    if (serverInstance) {
        serverInstance.close();
        serverInstance = null;
    }
};

module.exports = { startServer, stopServer };