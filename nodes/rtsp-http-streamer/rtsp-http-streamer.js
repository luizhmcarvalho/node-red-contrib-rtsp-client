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
            if (node.clientResponse && !node.clientResponse.writableEnded && typeof node.clientResponse.end === 'function') { // Check if end exists
                try {
                    node.clientResponse.end(); // Tenta fechar a resposta HTTP
                    node.log("Resposta HTTP finalizada.");
                } catch (e) {
                    node.warn(`Erro ao finalizar resposta HTTP: ${e.message}`);
                }
            } else if (node.clientResponse) {
                 node.warn(`Não foi possível finalizar resposta HTTP (writableEnded: ${node.clientResponse.writableEnded}, end function exists: ${typeof node.clientResponse.end === 'function'})`);
            }
            node.clientResponse = null;

            if (node.ffmpeg_process) {
                const pid = node.ffmpeg_process.pid;
                node.log(`Matando processo ffmpeg (PID: ${pid})...`);
                // Check if kill is available before calling
                if (typeof node.ffmpeg_process.kill === 'function') {
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
                     node.error(`Erro: processo ffmpeg (PID: ${pid}) não possui a função kill.`);
                     node.ffmpeg_process = null;
                }
            } else {
                 node.ffmpeg_process = null; // Garante que está nulo
            }
            node.status({ fill: "grey", shape: "ring", text: `Parado (${reason})` });
        }

        // --- Handler de Input (Recebe de http in) ---
        node.on('input', function(msg, send, done) {
            // <<< DEBUG: Log inicial da mensagem recebida
            node.warn("Mensagem recebida no rtsp-http-streamer: " + JSON.stringify(msg, (key, value) => {
                // Evita circular references e objetos muito grandes no log
                if (key === 'req' || key === 'res') return '[Object]';
                return value;
            }, 2));


            if (node.ffmpeg_process) {
                node.warn("Stream já em andamento para este nó. Ignorando nova requisição.");
                if (msg.res && typeof msg.res.status === 'function' && !msg.res.writableEnded) { // Check function existence
                     msg.res.status(503).send("Stream já em uso por outra conexão.");
                } else if (msg.res) {
                    node.warn("Não foi possível enviar resposta 503 (status function missing or response ended).");
                }
                if (done) done();
                return;
            }

            // <<< DEBUG: Verifica a existência e tipo de msg.res
            if (!msg.res) {
                 node.error("Erro Crítico: msg.res não está definido na mensagem de entrada.");
                 if (done) done();
                 return;
            }
            node.warn(`Tipo de msg.res: ${typeof msg.res}`);
            if (typeof msg.res !== 'object' || msg.res === null) {
                 node.error(`Erro Crítico: msg.res não é um objeto (tipo: ${typeof msg.res}).`);
                 if (done) done();
                 return;
            }
            // <<< DEBUG: Lista as chaves (propriedades/métodos) disponíveis em msg.res
            try {
                 node.warn(`Chaves em msg.res: ${Object.keys(msg.res).join(', ')}`);
            } catch (e) {
                 node.warn(`Não foi possível listar as chaves de msg.res: ${e.message}`);
            }
            // <<< DEBUG: Verifica especificamente a função writeHead
            node.warn(`msg.res possui writeHead? ${typeof msg.res.writeHead === 'function'}`);


            // A verificação principal que causa o erro original:
             if (typeof msg.res.writeHead !== 'function') {
                  node.error("Erro Crítico: msg.res não possui a função 'writeHead'. Verifique o nó anterior ('http in').");
                  // Tenta enviar um erro se possível, mas pode falhar também
                  if (typeof msg.res.status === 'function' && !msg.res.writableEnded) {
                       msg.res.status(500).send("Erro interno do servidor: objeto de resposta inválido.");
                  }
                  if (done) done();
                  return; // Impede a execução do código que causa o TypeError
             }


            // Guarda a resposta para uso posterior
            node.clientResponse = msg.res;
            const req = msg.req; // Referência à requisição (verificar se existe também)
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
                 if (node.clientResponse && !node.clientResponse.headersSent && typeof node.clientResponse.status === 'function') {
                      node.clientResponse.status(500).send("Configuração RTSP inválida no servidor.");
                 }
                stopStream("Config RTSP inválida");
                if (done) done();
                return;
            }

            const displayUrl = rtspUrl.replace(/:(?:[^@/]+)@/, ':****@'); // Oculta senha para log
            // Verifica se req.ip existe
            const clientIp = req.ip || req.connection?.remoteAddress || 'IP desconhecido';
            node.log(`Iniciando stream para ${clientIp} - Conectando a: ${displayUrl}`);
            node.status({ fill: "blue", shape: "dot", text: "Conectando..." });

            // --- Cabeçalhos HTTP para MJPEG Stream ---
            const headers = {
                'Content-Type': `multipart/x-mixed-replace; boundary=--${MJPEG_BOUNDARY}`,
                'Connection': 'close', // Ou 'keep-alive' se gerenciado corretamente
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
            };

             // Linha 93 original (agora dentro de um contexto mais seguro)
             if (!node.clientResponse.headersSent) {
                 node.clientResponse.writeHead(200, headers); // Chamada que causava o erro
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
                if (node.clientResponse && !node.clientResponse.headersSent && typeof node.clientResponse.status === 'function') {
                     node.clientResponse.status(500).send("Erro interno ao iniciar stream de vídeo.");
                }
                stopStream(`Falha spawn ${err.code}`);
                if (done) done();
                return;
            }

            // --- Handlers do Processo FFMPEG ---

            // Enviar dados (frames) para o cliente HTTP
            node.ffmpeg_process.stdout.on('data', (data) => {
                // Verifica se clientResponse e a função write existem e se a conexão não foi encerrada
                if (!node.clientResponse || node.clientResponse.writableEnded || typeof node.clientResponse.write !== 'function') {
                    if (node.ffmpeg_process) stopStream(`Cliente desconectou ou resposta inválida (stdout - writableEnded: ${node.clientResponse?.writableEnded}, write exists: ${typeof node.clientResponse?.write === 'function'})`);
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
                const currentPid = node.ffmpeg_process?.pid; // Salva antes de zerar
                node.log(`Processo ffmpeg (PID: ${currentPid}) encerrado. Código: ${code}, Sinal: ${signal}`);
                node.ffmpeg_process = null; // Limpa referência ANTES de chamar stopStream

                if (code !== 0 && code !== null && signal !== 'SIGTERM') { // Ignora fechamento normal ou por SIGTERM
                    node.error(`FFmpeg (PID: ${currentPid}) terminou inesperadamente (cód ${code}). Último erro: ${ffmpegErrorBuffer}`);
                    stopStream(`FFmpeg exit code ${code}`); // Passa motivo
                } else {
                     stopStream(`FFmpeg closed (code ${code}, signal ${signal})`);
                }
                 ffmpegErrorBuffer = ''; // Limpa buffer
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

            // --- Handler para desconexão do cliente HTTP ---
            // Verifica se clientResponse e a função 'on' existem
            if (node.clientResponse && typeof node.clientResponse.on === 'function') {
                node.clientResponse.on('close', () => {
                    node.log(`Cliente HTTP (${clientIp}) desconectou.`);
                    stopStream("Cliente desconectou");
                });
                 node.clientResponse.on('error', (err) => {
                     node.error(`Erro na conexão HTTP: ${err.message}`);
                     stopStream(`Erro HTTP ${err.code}`);
                 });
            } else {
                 node.warn("Não foi possível adicionar listeners 'close' e 'error' ao clientResponse.");
            }


            // Indica ao Node-RED que o processamento síncrono do input terminou
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
