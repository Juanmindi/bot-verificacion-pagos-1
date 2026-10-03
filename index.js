const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const qrcode = require('qrcode');
const axios = require('axios');
const Papa = require('papaparse');
const pino = require('pino');

const app = express();
const port = process.env.PORT || 3000;

let qrBase64 = ''; 
let isConnected = false;

// 1. Servidor Web para mostrar el QR
app.get('/', (req, res) => {
    if (isConnected) {
        res.send('<h1 style="font-family:sans-serif; text-align:center; color:green; margin-top:20%;">¡El bot está conectado y funcionando!</h1>');
    } else if (qrBase64) {
        res.send(`
            <html>
                <body style="display:flex; justify-content:center; align-items:center; height:100vh; background-color:#f0f0f0; font-family:sans-serif;">
                    <div style="text-align:center; background:white; padding:30px; border-radius:10px; box-shadow:0 0 15px rgba(0,0,0,0.2);">
                        <h2>Escanea este QR con WhatsApp</h2>
                        <img src="${qrBase64}" alt="QR Code" style="width:300px; height:300px; margin: 15px 0;"/>
                        <p style="color:gray;">Si escaneas y no pasa nada, recarga esta página para un QR nuevo.</p>
                    </div>
                </body>
            </html>
        `);
    } else {
        res.send('<h1 style="font-family:sans-serif; text-align:center; margin-top:20%;">Generando QR... Recarga la página en 5 segundos.</h1>');
    }
});

app.listen(port, () => {
    console.log(`Servidor web corriendo en el puerto ${port}`);
});

// FUNCIÓN SÚPER FLEXIBLE PARA LEER CUALQUIER MONTO
function parseMonto(montoStr) {
    if (!montoStr) return NaN;
    let limpio = String(montoStr).replace(/[^\d.,]/g, '');
    let lastDot = limpio.lastIndexOf('.');
    let lastComma = limpio.lastIndexOf(',');
    
    if (lastComma > lastDot) {
        limpio = limpio.replace(/\./g, '').replace(',', '.');
    } else if (lastDot > lastComma) {
        limpio = limpio.replace(/,/g, '');
    }
    return parseFloat(limpio);
}

// 2. Función principal del Bot
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('Nuevo QR generado. Entra a tu página web de Render para escanearlo.');
            qrBase64 = await qrcode.toDataURL(qr);
        }

        if (connection === 'close') {
            isConnected = false;
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            isConnected = true;
            qrBase64 = ''; 
        }
    });

    // 3. Escuchando mensajes
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const remoteJid = msg.key.remoteJid;
        const msgText = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
        const msgLower = msgText.toLowerCase();

        if (msgLower.includes('verificar')) {
            // Buscamos la referencia (agarrará los dígitos que le pongas, ej: r998589)
            const refMatch = msgLower.match(/r\s*(\d+)/i) || msgLower.match(/(?:ref|referencia)?\s*(\d{4,})/i);

            if (refMatch) {
                const refBuscada = refMatch[1];
                
                const msgSinRef = msgLower.replace(refMatch[0], '');
                const amountMatch = msgSinRef.match(/([\d.,]+)\s*(?:bs|ves)?/i);

                if (amountMatch) {
                    const montoOriginalStr = amountMatch[1];
                    const montoBuscadoNum = parseMonto(montoOriginalStr); 

                    const sheetId = '14bLRZ31MdiAT4N-v5ZbymSsHr4cd06ePaA22gmZSTlU';
                    const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`;

                    try {
                        const response = await axios.get(csvUrl);
                        const parsed = Papa.parse(response.data, { header: true, skipEmptyLines: true });
                        let pagoEncontrado = null;

                        for (const fila of parsed.data) {
                            const keys = Object.keys(fila);
                            const keyRef = keys.find(k => k.toLowerCase().includes('ref')) || keys[0];
                            const keyMonto = keys.find(k => k.toLowerCase().includes('monto')) || keys[1];
                            const keyFecha = keys.find(k => k.toLowerCase().includes('fecha')) || keys[2];
                            const keyBanco = keys.find(k => k.toLowerCase().includes('banco')) || keys[4];

                            const refEnHoja = String(fila[keyRef] || '').trim();
                            const montoEnHojaNum = parseMonto(fila[keyMonto]); 

                            // COMPROBACIÓN EXACTA DE ÚLTIMOS DÍGITOS
                            // Verifica si la referencia guardada termina con los números que tú escribiste
                            const coincideRef = refEnHoja.endsWith(refBuscada) || refEnHoja === refBuscada;
                            
                            const coincideMonto = !isNaN(montoBuscadoNum) && !isNaN(montoEnHojaNum) 
                                ? Math.abs(montoBuscadoNum - montoEnHojaNum) < 0.01 
                                : false;

                            if (coincideRef && coincideMonto) {
                                pagoEncontrado = {
                                    fecha: fila[keyFecha] || 'Fecha no registrada',
                                    monto: fila[keyMonto] || montoOriginalStr,
                                    referencia: refEnHoja, // Muestra la referencia completa en la respuesta
                                    banco: (keyBanco && fila[keyBanco] && fila[keyBanco].trim() !== '') ? fila[keyBanco] : 'Mercantil'
                                };
                                break;
                            }
                        }

                        if (pagoEncontrado) {
                            await sock.sendMessage(remoteJid, { text: `*Si, hay un pago movil registrado con la fecha ${pagoEncontrado.fecha} con el monto ${pagoEncontrado.monto} Bs, el numero de referencia ${pagoEncontrado.referencia} al banco ${pagoEncontrado.banco}*` }, { quoted: msg });
                        } else {
                            await sock.sendMessage(remoteJid, { text: '*No, no existe un pago movil registrado con la referencia y monto indicados*' }, { quoted: msg });
                        }

                    } catch (error) {
                        console.error('Error al consultar Google Sheets:', error.message);
                        await sock.sendMessage(remoteJid, { text: 'Hubo un error de conexión con la base de datos al intentar verificar el pago.' });
                    }
                }
            }
        }
    });
}

connectToWhatsApp();
