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
        node.clientResponse = null; // Guarda o objeto de resposta HTTP NATIVO

        // --- Função para Parar o Stream e Limpar ---
        function stopStream(reason) {
            node.log(`Parando stream ffmpeg. Razão: ${reason}`);
            // Usa o clientResponse (que agora é o objeto nativo)
            if (node.clientResponse && !node.clientResponse.writableEnded && typeof node.clientResponse.end === 'function') {
                try {
                    node.clientResponse.end();
                    node.log("Resposta HTTP (nativa) finalizada.");
                } catch (e) {
                    node.warn(`Erro ao finalizar resposta HTTP nativa: ${e.message}`);
                }
            }
            node.clientResponse = null; // Limpa a referência

            if (node.ffmpeg_process) {
                const pid = node.ffmpeg_process.pid;
                node.log(`Matando processo ffmpeg (PID: ${pid})...`);
                if (typeof node.ffmpeg_process.kill === 'function') {
                    node.ffmpeg_process.kill('SIGTERM');
                    setTimeout(() => {
                        if (node.ffmpeg_process && !node.ffmpeg_process.killed) {
                            node.warn(`Forçando parada do ffmpeg (PID: ${pid}) com SIGKILL.`);
                            node.ffmpeg_process.kill('SIGKILL');
                        }
                        node.ffmpeg_process = null;
                    }, 1500);
                } else {
                     node.error(`Erro: processo ffmpeg (PID: ${pid}) não possui a função kill.`);
                     node.ffmpeg_process = null;
                }
            } else {
                 node.ffmpeg_process = null;
            }
            node.status({ fill: "grey", shape: "ring", text: `Parado (${reason})` });
        }

        // --- Handler de Input (Recebe de http in) ---
        node.on('input', function(msg, send, done) {

            if (node.ffmpeg_process) {
                node.warn("Stream já em andamento para este nó. Ignorando nova requisição.");
                // Usa métodos do Express (msg.res) para responder ao novo pedido, se possível
                if (msg.res && typeof msg.res.status === 'function' && !msg.res.writableEnded) {
                     msg.res.status(503).send("Stream já em uso por outra conexão.");
                }
                if (done) done();
                return;
            }

            // Verifica se msg.res e msg.res._res existem
            if (!msg.res) {
                 node.error("Erro Crítico: msg.res não está definido na mensagem de entrada.");
                 if (done) done();
                 return;
            }
             // <<< CORREÇÃO APLICADA AQUI >>>
             if (!msg.res._res) { // Verifica se o objeto nativo existe
                 node.error("Erro Crítico: Objeto de resposta nativo (msg.res._res) não encontrado. Verifique a versão do Node-RED ou o nó 'http in'.");
                 // Tenta responder usando o objeto Express (msg.res)
                 if (typeof msg.res.status === 'function' && !msg.res.writableEnded) {
                      msg.res.status(500).send("Erro interno do servidor: objeto de resposta nativo ausente.");
                 }
                 if (done) done();
                 return;
             }

            // Guarda a resposta NATIVA para uso posterior no streaming
            node.clientResponse = msg.res._res; // <<< USA O OBJETO NATIVO!
            node.log("Objeto de resposta nativo (msg.res._res) encontrado e atribuído.");

            const req = msg.req; // Referência à requisição
            if (!req) {
                node.error("Erro: msg.req não está definido. Necessário do nó 'http in'.");
                stopStream("msg.req ausente");
                if (done) done();
                return;
            }

            const rtspUrl = buildRtspUrl(node.rtsp_address, node.rtsp_username, node.rtsp_password);
            if (!rtspUrl) {
                node.error("Endereço RTSP inválido ou não configurado.");
                node.status({ fill: "red", shape: "ring", text: "Erro: Config RTSP" });
                 // Tenta responder usando o objeto Express (msg.res)
                 if (msg.res && typeof msg.res.status === 'function' && !msg.res.headersSent) {
                      msg.res.status(500).send("Configuração RTSP inválida no servidor.");
                 }
                stopStream("Config RTSP inválida");
                if (done) done();
                return;
            }

            const displayUrl = rtspUrl.replace(/:(?:[^@/]+)@/, ':****@');
            const clientIp = req.ip || req.connection?.remoteAddress || 'IP desconhecido';
            node.log(`Iniciando stream para ${clientIp} - Conectando a: ${displayUrl}`);
            node.status({ fill: "blue", shape: "dot", text: "Conectando..." });

            // --- Cabeçalhos HTTP para MJPEG Stream ---
            const headers = {
                'Content-Type': `multipart/x-mixed-replace; boundary=--${MJPEG_BOUNDARY}`,
                'Connection': 'close',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
            };

             // Usa o objeto nativo (node.clientResponse) para writeHead
             // Verifica se a função existe antes de chamar (boa prática)
             if (node.clientResponse && typeof node.clientResponse.writeHead === 'function') {
                 if (!node.clientResponse.headersSent) {
                     node.clientResponse.writeHead(200, headers); // <<< Deve funcionar agora
                     node.log("Cabeçalhos HTTP MJPEG enviados via resposta nativa.");
                 } else {
                     node.warn("Cabeçalhos HTTP já enviados para esta resposta (nativa).");
                 }
             } else {
                  node.error("Erro crítico: node.clientResponse (nativo) não possui a função writeHead.");
                  stopStream("writeHead ausente no obj nativo");
                  if(done) done();
                  return;
             }


            // --- Parâmetros e Início do FFMPEG ---
            const ffmpegParams = [
                '-loglevel', 'error',
                '-fflags', 'nobuffer',
                '-rtsp_transport', 'tcp',
                '-i', rtspUrl,
                '-f', 'mjpeg',
                '-q:v', '5',
                'pipe:1'
            ];

            let ffmpegErrorBuffer = '';

            try {
                node.ffmpeg_process = spawn(node.ffmpegCmd, ffmpegParams, { stdio: ['ignore', 'pipe', 'pipe'] });
                node.log(`Processo ffmpeg iniciado (PID: ${node.ffmpeg_process.pid}) com comando '${node.ffmpegCmd}'`);
            } catch (err) {
                node.error(`Falha ao iniciar '${node.ffmpegCmd}': ${err.message}. Verifique instalação e caminho.`);
                node.status({ fill: "red", shape: "ring", text: `Erro spawn (${err.code})` });
                 // Tenta responder usando o objeto Express (msg.res)
                 if (msg.res && typeof msg.res.status === 'function' && !msg.res.headersSent) {
                      msg.res.status(500).send("Erro interno ao iniciar stream de vídeo.");
                 }
                stopStream(`Falha spawn ${err.code}`);
                if (done) done();
                return;
            }

            // --- Handlers do Processo FFMPEG ---

            // Enviar dados (frames) para o cliente HTTP usando o objeto nativo
            node.ffmpeg_process.stdout.on('data', (data) => {
                // Verifica se clientResponse e a função write existem e se a conexão não foi encerrada
                if (!node.clientResponse || node.clientResponse.writableEnded || typeof node.clientResponse.write !== 'function') {
                    if (node.ffmpeg_process) stopStream(`Cliente desconectou ou resposta nativa inválida (stdout - writableEnded: ${node.clientResponse?.writableEnded}, write exists: ${typeof node.clientResponse?.write === 'function'})`);
                    return;
                }
                try {
                    const frameHeader = Buffer.from(
                        `--${MJPEG_BOUNDARY}\r\n` +
                        `Content-Type: image/jpeg\r\n` +
                        `Content-Length: ${data.length}\r\n\r\n`
                    );
                    node.clientResponse.write(frameHeader); // Usa write do objeto nativo
                    node.clientResponse.write(data);      // Usa write do objeto nativo
                    node.status({ fill: "green", shape: "dot", text: "Streaming" });
                } catch (e) {
                     node.error(`Erro ao escrever na resposta HTTP nativa: ${e.message}`);
                     stopStream("Erro escrita HTTP nativa");
                }
            });

            // Logar erros do ffmpeg (stderr)
            node.ffmpeg_process.stderr.on('data', (data) => {
                const errorMsg = data.toString();
                ffmpegErrorBuffer += errorMsg;
                node.log(`FFmpeg stderr: ${errorMsg.substring(0,150)}${errorMsg.length > 150 ? '...' : ''}`);
                 if (/Connection refused/i.test(ffmpegErrorBuffer)) {
                     node.error("FFmpeg: Conexão recusada.");
                     node.status({fill:"red", shape:"ring", text:"Erro: Conexão recusada"});
                     stopStream("Conexão recusada");
                 } else if (/401 Unauthorized/i.test(ffmpegErrorBuffer) || /Invalid data found when processing input/i.test(ffmpegErrorBuffer)) {
                     node.error("FFmpeg: Autenticação falhou ou URL inválida.");
                     node.status({fill:"red", shape:"ring", text:"Erro: Auth/URL"});
                     stopStream("Auth/URL inválida");
                 }
                 // Outros erros podem apenas ser logados sem parar o stream imediatamente
            });

            // Limpeza quando o ffmpeg fecha
            node.ffmpeg_process.on('close', (code, signal) => {
                const currentPid = node.ffmpeg_process?.pid;
                node.log(`Processo ffmpeg (PID: ${currentPid}) encerrado. Código: ${code}, Sinal: ${signal}`);
                node.ffmpeg_process = null; // Limpa referência antes de chamar stopStream

                if (code !== 0 && code !== null && signal !== 'SIGTERM') { // Ignora fechamento normal ou por SIGTERM
                    node.error(`FFmpeg (PID: ${currentPid}) terminou inesperadamente (cód ${code}). Último erro: ${ffmpegErrorBuffer}`);
                    stopStream(`FFmpeg exit code ${code}`);
                } else {
                    // Se já não estiver parando/parado, marca como parado
                    if (node.clientResponse) { // Verifica se stopStream já não foi chamado
                       stopStream(`FFmpeg closed (code ${code}, signal ${signal})`);
                    }
                }
                 ffmpegErrorBuffer = '';
            });

            // Erro no spawn/execução do ffmpeg
            node.ffmpeg_process.on('error', (err) => {
                 const currentPid = node.ffmpeg_process?.pid;
                 node.error(`Erro no processo ffmpeg (PID: ${currentPid}): ${err.message}`);
                 if (node.ffmpeg_process && !node.ffmpeg_process.killed && typeof node.ffmpeg_process.kill === 'function') {
                    try { node.ffmpeg_process.kill(); } catch(e){}
                 }
                 node.ffmpeg_process = null;
                 stopStream(`Erro ffmpeg process ${err.code}`);
                 ffmpegErrorBuffer = '';
            });

            // --- Handler para desconexão do cliente HTTP (usa o objeto nativo) ---
            if (node.clientResponse && typeof node.clientResponse.on === 'function') {
                node.clientResponse.on('close', () => {
                    node.log(`Cliente HTTP (${clientIp}) desconectou (resposta nativa).`);
                    stopStream("Cliente desconectou");
                });
                 node.clientResponse.on('error', (err) => {
                     node.error(`Erro na conexão HTTP (resposta nativa): ${err.message}`);
                     stopStream(`Erro HTTP nativo ${err.code}`);
                 });
            } else {
                 node.warn("Não foi possível adicionar listeners 'close' e 'error' ao clientResponse nativo.");
            }

            if (done) {
                done(); // Informa ao Node-RED que o processamento síncrono terminou
            }
        });

        // --- Limpeza ao Fechar/Redeploy o Nó ---
        node.on('close', (removed, done) => {
            node.log("Nó sendo fechado/reimplantado.");
            stopStream("Nó fechado");
            setTimeout(() => {
                 node.log("Limpeza do nó concluída.");
                 done();
            }, 1600); // Tempo para garantir que SIGKILL (se necessário) foi enviado
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

        node.status({ fill: "grey", shape: "ring", text: "Pronto" });

    } // Fim do RTSPHttpStreamerNode

    RED.nodes.registerType("rtsp-http-streamer", RTSPHttpStreamerNode);
}
