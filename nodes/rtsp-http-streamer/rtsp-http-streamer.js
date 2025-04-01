module.exports = function(RED) {
    const { spawn } = require('child_process');
    const MJPEG_BOUNDARY = "NODE_RED_MJPEG_BOUNDARY"; // String delimitadora para os frames

    function RTSPHttpStreamerNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;

        node.rtsp_address = config.address;
        node.rtsp_username = config.username;
        node.rtsp_password = config.password;
        node.ffmpegCmd = config.ffmpegPath || 'ffmpeg'; // Caminho do FFmpeg ou padrão
        node.ffmpeg_process = null;
        node.clientResponse = null; // Guarda o objeto 'res' da requisição HTTP

        // --- Função para Parar o Stream e Limpar ---
        function stopStream(reason) {
            node.log(`Parando stream ffmpeg. Razão: ${reason}`);
            if (node.clientResponse && !node.clientResponse.writableEnded) {
                try {
                    node.clientResponse.end(); // Tenta fechar a resposta HTTP
                    node.log("Resposta HTTP finalizada.");
                } catch (e) {
                    node.warn(`Erro ao finalizar resposta HTTP: ${e.message}`);
                }
            }
            node.clientResponse = null;

            if (node.ffmpeg_process) {
                const pid = node.ffmpeg_process.pid;
                node.log(`Matando processo ffmpeg (PID: ${pid})...`);
                node.ffmpeg_process.kill('SIGTERM'); // Tenta terminar graciosamente

                // Fallback com SIGKILL
                setTimeout(() => {
                    if (node.ffmpeg_process && !node.ffmpeg_process.killed) {
                        node.warn(`Forçando parada do ffmpeg (PID: ${pid}) com SIGKILL.`);
                        node.ffmpeg_process.kill('SIGKILL');
                    }
                    node.ffmpeg_process = null; // Garante a limpeza da referência
                }, 1500); // Espera 1.5 segundos
            } else {
                 node.ffmpeg_process = null; // Garante que está nulo
            }
            node.status({ fill: "grey", shape: "ring", text: `Parado (${reason})` });
        }

        // --- Handler de Input (Recebe de http in) ---
        node.on('input', function(msg, send, done) {
            if (node.ffmpeg_process) {
                node.warn("Stream já em andamento para este nó. Ignorando nova requisição.");
                // Poderia fechar a conexão antiga e iniciar uma nova, mas vamos manter simples
                if (msg.res && !msg.res.writableEnded) {
                     msg.res.status(503).send("Stream já em uso por outra conexão.");
                }
                if (done) done();
                return;
            }

            if (!msg.req || !msg.res) {
                node.error("Mensagem de entrada inválida. Esperado output do nó 'http in'.");
                if (done) done();
                return;
            }

            // Guarda a resposta para uso posterior
            node.clientResponse = msg.res;
            const req = msg.req; // Referência à requisição

            const rtspUrl = buildRtspUrl(node.rtsp_address, node.rtsp_username, node.rtsp_password);
            if (!rtspUrl) {
                node.error("Endereço RTSP inválido ou não configurado.");
                node.status({ fill: "red", shape: "ring", text: "Erro: Config RTSP" });
                 if (!node.clientResponse.headersSent) node.clientResponse.status(500).send("Configuração RTSP inválida no servidor.");
                stopStream("Config RTSP inválida");
                if (done) done();
                return;
            }

            const displayUrl = rtspUrl.replace(/:(?:[^@/]+)@/, ':****@'); // Oculta senha para log
            node.log(`Iniciando stream para ${req.ip} - Conectando a: ${displayUrl}`);
            node.status({ fill: "blue", shape: "dot", text: "Conectando..." });

            // --- Cabeçalhos HTTP para MJPEG Stream ---
            const headers = {
                'Content-Type': `multipart/x-mixed-replace; boundary=--${MJPEG_BOUNDARY}`,
                'Connection': 'close', // Ou 'keep-alive' se gerenciado corretamente
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
            };
             if (!node.clientResponse.headersSent) {
                 node.clientResponse.writeHead(200, headers);
                 node.log("Cabeçalhos HTTP MJPEG enviados.");
             } else {
                 node.warn("Cabeçalhos HTTP já enviados para esta resposta.");
             }


            // --- Parâmetros e Início do FFMPEG ---
            const ffmpegParams = [
                '-loglevel', 'error',
                '-fflags', 'nobuffer',
                '-rtsp_transport', 'tcp',
                '-i', rtspUrl,
                '-f', 'mjpeg',
                '-q:v', '5', // Ajuste a qualidade conforme necessário
                'pipe:1'
            ];

            let ffmpegErrorBuffer = ''; // Buffer para erros do ffmpeg

            try {
                node.ffmpeg_process = spawn(node.ffmpegCmd, ffmpegParams, { stdio: ['ignore', 'pipe', 'pipe'] });
                node.log(`Processo ffmpeg iniciado (PID: ${node.ffmpeg_process.pid}) com comando '${node.ffmpegCmd}'`);
            } catch (err) {
                node.error(`Falha ao iniciar '${node.ffmpegCmd}': ${err.message}. Verifique instalação e caminho.`);
                node.status({ fill: "red", shape: "ring", text: `Erro spawn (${err.code})` });
                if (!node.clientResponse.headersSent) node.clientResponse.status(500).send("Erro interno ao iniciar stream de vídeo.");
                stopStream(`Falha spawn ${err.code}`);
                if (done) done();
                return;
            }

            // --- Handlers do Processo FFMPEG ---

            // Enviar dados (frames) para o cliente HTTP
            node.ffmpeg_process.stdout.on('data', (data) => {
                if (!node.clientResponse || node.clientResponse.writableEnded) {
                    // Cliente desconectou ou resposta já terminou
                    if (node.ffmpeg_process) stopStream("Cliente desconectou (stdout)");
                    return;
                }
                try {
                    // Monta o cabeçalho do frame MJPEG
                    const frameHeader = Buffer.from(
                        `--${MJPEG_BOUNDARY}\r\n` +
                        `Content-Type: image/jpeg\r\n` +
                        `Content-Length: ${data.length}\r\n\r\n`
                    );
                    // Envia o cabeçalho e depois o dado do frame
                    node.clientResponse.write(frameHeader);
                    node.clientResponse.write(data);
                    node.status({ fill: "green", shape: "dot", text: "Streaming" });
                } catch (e) {
                     node.error(`Erro ao escrever na resposta HTTP: ${e.message}`);
                     stopStream("Erro escrita HTTP");
                }
            });

            // Logar erros do ffmpeg
            node.ffmpeg_process.stderr.on('data', (data) => {
                const errorMsg = data.toString();
                ffmpegErrorBuffer += errorMsg;
                node.log(`FFmpeg stderr: ${errorMsg.substring(0,150)}${errorMsg.length > 150 ? '...' : ''}`);
                // Poderia tentar identificar erros fatais aqui e parar
                 if (/Connection refused/i.test(ffmpegErrorBuffer)) {
                     node.error("FFmpeg: Conexão recusada.");
                     node.status({fill:"red", shape:"ring", text:"Erro: Conexão recusada"});
                     stopStream("Conexão recusada");
                 } else if (/401 Unauthorized/i.test(ffmpegErrorBuffer) || /Invalid data found when processing input/i.test(ffmpegErrorBuffer)) {
                     node.error("FFmpeg: Autenticação falhou ou URL inválida.");
                     node.status({fill:"red", shape:"ring", text:"Erro: Auth/URL"});
                     stopStream("Auth/URL inválida");
                 }
            });

            // Limpeza quando o ffmpeg fecha
            node.ffmpeg_process.on('close', (code, signal) => {
                node.log(`Processo ffmpeg (PID: ${node.ffmpeg_process?.pid}) encerrado. Código: ${code}, Sinal: ${signal}`);
                 const pid = node.ffmpeg_process?.pid; // Salva antes de zerar
                 node.ffmpeg_process = null; // Limpa referência ANTES de chamar stopStream

                if (code !== 0 && code !== null && signal !== 'SIGTERM') { // Ignora fechamento normal ou por SIGTERM
                    node.error(`FFmpeg (PID: ${pid}) terminou inesperadamente (cód ${code}). Último erro: ${ffmpegErrorBuffer}`);
                    stopStream(`FFmpeg exit code ${code}`); // Passa motivo
                } else {
                    // Fechamento normal ou esperado
                     stopStream(`FFmpeg closed (code ${code}, signal ${signal})`);
                }
                 ffmpegErrorBuffer = ''; // Limpa buffer
            });

            // Erro no spawn/execução do ffmpeg
            node.ffmpeg_process.on('error', (err) => {
                node.error(`Erro no processo ffmpeg (PID: ${node.ffmpeg_process?.pid}): ${err.message}`);
                 const pid = node.ffmpeg_process?.pid;
                 if (node.ffmpeg_process && !node.ffmpeg_process.killed) {
                    try { node.ffmpeg_process.kill(); } catch(e){}
                 }
                 node.ffmpeg_process = null;
                 stopStream(`Erro ffmpeg process ${err.code}`);
                 ffmpegErrorBuffer = '';
            });

            // --- Handler para desconexão do cliente HTTP ---
            node.clientResponse.on('close', () => {
                node.log(`Cliente HTTP (${req.ip}) desconectou.`);
                stopStream("Cliente desconectou");
            });
             node.clientResponse.on('error', (err) => {
                 node.error(`Erro na conexão HTTP: ${err.message}`);
                 stopStream(`Erro HTTP ${err.code}`);
             });


            // Indica ao Node-RED que o processamento síncrono do input terminou
            // A resposta HTTP continuará sendo enviada de forma assíncrona
            if (done) {
                done();
            }
        });

        // --- Limpeza ao Fechar/Redeploy o Nó ---
        node.on('close', (removed, done) => {
            node.log("Nó sendo fechado/reimplantado.");
            stopStream("Nó fechado"); // Garante que tudo seja parado
            // Espera um pouco para garantir limpeza antes de chamar done
            setTimeout(() => {
                 node.log("Limpeza do nó concluída.");
                 done();
            }, 1600); // Deve ser um pouco maior que o timeout do SIGKILL
        });

        // --- Função Auxiliar para Montar URL RTSP ---
        function buildRtspUrl(address, username, password) {
            if (!address) return null;
            try {
                if (username && password) {
                    return `rtsp://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${address}`;
                } else if (username) {
                    return `rtsp://${encodeURIComponent(username)}@${address}`;
                } else {
                    return `rtsp://${address}`;
                }
            } catch (e) {
                node.error(`Erro ao construir URL RTSP: ${e.message}`);
                return null;
            }
        }

        // Define status inicial
        node.status({ fill: "grey", shape: "ring", text: "Pronto" });

    } // Fim do RTSPHttpStreamerNode

    RED.nodes.registerType("rtsp-http-streamer", RTSPHttpStreamerNode);
}
