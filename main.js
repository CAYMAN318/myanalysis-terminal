const { app, BrowserWindow } = require('electron');
const path = require('path');
const serverModule = require('./server/app.js'); 

let expressServerInstance = null;

function createWindow() {
    const mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 1000,
        minHeight: 700,
        show: false, // Inicia oculta para evitar "pulos" na tela
        title: "MyAnalysis - Terminal de Análise & C-Pro I Lab",
        icon: path.join(__dirname, 'assets', 'icon.png'), 
        webPreferences: {
            nodeIntegration: false, 
            contextIsolation: true, 
        }
    });

    mainWindow.setMenuBarVisibility(false);
    mainWindow.webContents.openDevTools(); 
    mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

    // Quando o HTML estiver pronto, maximiza e exibe suavemente
    mainWindow.once('ready-to-show', () => {
        mainWindow.maximize();
        mainWindow.show();
    });
}

app.on('ready', () => {
    expressServerInstance = serverModule.startServer(3002); 
    createWindow();
    console.log(">>> [ELECTRON] MyAnalysis iniciado com sucesso na porta 3002");
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});