module.exports = function(RED) {
    const { spawn } = require('child_process'); // Importar fora da função do nó

    function RTSPClientNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;

        // --- Estados possíveis ---
        // 'stopped': Nenhum processo rodando.
        // 'starting': Processo ffmpeg sendo iniciado.
        // 'streaming': Processo rodando e enviando dados.
        // 'paused': Processo rodando, mas dados não são enviados.
        // 'stopping': Processo sendo parado.
        // 'error': Ocorreu um erro.
        node.streamState = 'stopped';
        node.ffmpeg_process = null; // Variável para guardar o processo ffmpeg
        node.stderr_buffer = '';   // Buffer para logs de erro do ffmpeg

        // Guardar configuração inicial para reuso
        node.initialConfig = {
            address: config.address,
            username: config.username,
            password: config.password
        };

        // --- Função para atualizar Status ---
        function updateStatus() {
            switch (node.streamState) {
                case 'stopped':
                    node.status({ fill: "grey", shape: "ring", text: "Parado" });
                    break;
                case 'starting':
                    node.status({ fill: "blue", shape: "dot", text: "Iniciando..." });
                    break;
                case 'streaming':
                    node.status({ fill: "green", shape: "dot", text: "Streaming" });
                    break;
                case 'paused':
                    node.status({ fill: "yellow", shape: "ring", text: "Pausado" });
                    break;
                case 'stopping':
                     node.status({ fill: "grey", shape: "dot", text: "Parando..." });
                     break;
                case 'error':
                    // Mantém a última mensagem de erro no status
                    // A mensagem é definida onde o erro ocorre.
                    break;
                default:
                     node.status({}); // Limpa status
                     break;
            }
        }

        // --- Função para Iniciar o Stream ---
        function launchStream(msg) {
            if (node.ffmpeg_process) {
                node.warn("Stream já iniciado ou iniciando. Use 'stop' primeiro.");
                return;
            }

            node.streamState = 'starting';
            node.stderr_buffer = ''; // Limpa buffer de erro anterior
            updateStatus();

            // Obtém os parâmetros - prioriza msg, depois configuração inicial
            const username = msg?.rtsp?.username ?? node.initialConfig.username ?? null;
            const password = msg?.rtsp?.password ?? node.initialConfig.password ?? null;
            const address = msg?.rtsp?.address ?? node.initialConfig.address ?? null;

            if (!address) {
                node.error("Endereço RTSP não configurado ou fornecido na mensagem.");
                node.streamState = 'error';
                node.status({ fill: "red", shape: "ring", text: "Erro: Endereço faltando" });
                return;
            }

            // Monta a URL RTSP
            let rtspUrl = '';
            try {
                if (username && password) {
                    rtspUrl = `rtsp://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${address}`;
                } else if (username) {
                    rtspUrl = `rtsp://${encodeURIComponent(username)}@${address}`;
                } else {
                    rtspUrl = `rtsp://${address}`;
                }
            } catch (e) {
                 node.error(`Erro ao montar URL RTSP: ${e.message}`);
                 node.streamState = 'error';
                 node.status({ fill: "red", shape: "ring", text: "Erro: URL inválida" });
                 return;
            }

            const displayUrl = rtspUrl.replace(/:(?:[^@/]+)@/, ':****@'); // Oculta senha para log
            node.log(`Tentando conectar a: ${displayUrl}`);

            const ffmpegParams = [
                '-loglevel', 'error',
                '-fflags', 'nobuffer',
                '-rtsp_transport', 'tcp',
                '-i', rtspUrl,
                '-f', 'mjpeg',
                '-q:v', '5',
                'pipe:1'
            ];

            try {
                node.ffmpeg_process = spawn('ffmpeg', ffmpegParams, { stdio: ['ignore', 'pipe', 'pipe'] });
                node.log(`Processo ffmpeg iniciado (PID: ${node.ffmpeg_process.pid})`);
            } catch (err) {
                node.error(`Falha ao iniciar o processo ffmpeg: ${err.message}`);
                node.streamState = 'error';
                node.status({ fill: "red", shape: "ring", text: "Erro ao iniciar ffmpeg" });
                node.ffmpeg_process = null;
                return;
            }

            // --- Handlers do Processo FFMPEG ---

            node.ffmpeg_process.stdout.on('data', (data) => {
                if (node.streamState === 'starting') {
                    node.streamState = 'streaming'; // Muda para streaming ao receber o primeiro dado
                    updateStatus();
                }
                // SÓ ENVIA SE ESTIVER NO ESTADO 'STREAMING'
                if (node.streamState === 'streaming') {
                    let newMsg = RED.util.cloneMessage(msg || {});
                    newMsg.payload = data;
                    node.send(newMsg); // Envia para a saída principal
                }
            });

            node.ffmpeg_process.stderr.on('data', (data) => {
                const errorMsg = data.toString();
                node.stderr_buffer += errorMsg; // Acumula erros
                // Log apenas uma parte para evitar flood, mas guarda tudo no buffer
                node.log(`FFmpeg stderr: ${errorMsg.substring(0, 100)}${errorMsg.length > 100 ? '...' : ''}`);

                // Tenta identificar erros críticos e atualizar o status
                 if (/Connection refused/i.test(node.stderr_buffer)) {
                     node.streamState = 'error';
                     node.status({fill:"red", shape:"ring", text:"Erro: Conexão recusada"});
                } else if (/401 Unauthorized/i.test(node.stderr_buffer) || /Invalid data found when processing input/i.test(node.stderr_buffer)) {
                     node.streamState = 'error';
                     node.status({fill:"red", shape:"ring", text:"Erro: Autenticação/URL"});
                } else if (/No route to host/i.test(node.stderr_buffer)) {
                     node.streamState = 'error';
                     node.status({fill:"red", shape:"ring", text:"Erro: Host não encontrado"});
                }
                // Outros erros podem não ser fatais imediatamente, não mudam o state aqui
            });

            node.ffmpeg_process.on('close', (code, signal) => {
                const wasDeliberatelyStopped = (node.streamState === 'stopping');
                node.log(`Processo ffmpeg (PID: ${node.ffmpeg_process?.pid}) encerrado. Código: ${code}, Sinal: ${signal}, Estado: ${node.streamState}`);
                node.ffmpeg_process = null; // Limpa a referência

                if (!wasDeliberatelyStopped && code !== 0 && code !== null) {
                    node.error(`FFmpeg terminou inesperadamente (cód ${code}). Último erro: ${node.stderr_buffer}`);
                    node.streamState = 'error';
                    node.status({ fill: "red", shape: "ring", text: `Erro ffmpeg (cód ${code})` });
                } else if (!wasDeliberatelyStopped) {
                     // Fechou sem ser comando de stop e sem erro (ex: stream da camera caiu?)
                     node.warn(`Stream fechado inesperadamente (cód ${code}, sinal ${signal})`);
                     node.streamState = 'stopped'; // Ou 'error'? Decidi por stopped.
                     updateStatus(); // Atualiza para 'Parado'
                } else {
                     // Foi parado via comando stop
                     node.streamState = 'stopped';
                     updateStatus(); // Atualiza para 'Parado'
                }
                node.stderr_buffer = ''; // Limpa buffer de erro
            });

            node.ffmpeg_process.on('error', (err) => {
                node.error(`Erro ao executar/spawn ffmpeg (PID: ${node.ffmpeg_process?.pid}): ${err.message}`);
                if (node.ffmpeg_process && !node.ffmpeg_process.killed) {
                   try { node.ffmpeg_process.kill(); } catch(e){}
                }
                node.ffmpeg_process = null;
                node.streamState = 'error';
                node.status({ fill: "red", shape: "ring", text: "Erro: Falha no spawn/exec" });
                node.stderr_buffer = '';
            });
        }

        // --- Função para Parar o Stream ---
        function stopStream() {
            if (node.ffmpeg_process) {
                node.log(`Parando o stream ffmpeg (PID: ${node.ffmpeg_process.pid})...`);
                node.streamState = 'stopping'; // Define o estado ANTES de matar
                updateStatus();
                node.ffmpeg_process.kill('SIGTERM');

                // Timeout para forçar SIGKILL se necessário
                setTimeout(() => {
                    if (node.ffmpeg_process && !node.ffmpeg_process.killed) {
                        node.warn("Forçando parada do ffmpeg (SIGKILL)...");
                        node.ffmpeg_process.kill('SIGKILL');
                        // O evento 'close' tratará a limpeza final de node.ffmpeg_process e state.
                    }
                }, 2000);
            } else {
                node.log("Nenhum stream ativo para parar.");
                if (node.streamState !== 'error') { // Não sobrescreve status de erro
                   node.streamState = 'stopped';
                   updateStatus();
                }
            }
        }

        // --- Função para Pausar o Stream ---
        function pauseStream() {
            if (node.streamState === 'streaming') {
                node.log("Pausando o envio de dados do stream...");
                node.streamState = 'paused';
                updateStatus();
            } else {
                node.warn(`Não é possível pausar. Estado atual: ${node.streamState}`);
            }
        }

        // --- Função para Retomar o Stream ---
        function resumeStream() {
             if (node.streamState === 'paused') {
                node.log("Retomando o envio de dados do stream...");
                node.streamState = 'streaming';
                updateStatus();
            } else {
                 node.warn(`Não é possível retomar. Estado atual: ${node.streamState}`);
            }
        }

        // --- Lógica de Controle via Input ---
        node.on('input', function(msg, send, done) {
            const action = typeof msg.topic === 'string' ? msg.topic.toLowerCase() : 'start'; // Default action

            node.log(`Comando recebido: ${action}`);

            switch (action) {
                case 'start':
                    launchStream(msg);
                    break;
                case 'stop':
                    stopStream();
                    break;
                case 'pause':
                    pauseStream();
                    break;
                case 'resume':
                    resumeStream();
                    break;
                default:
                    node.warn(`Ação desconhecida no msg.topic: '${msg.topic}'. Use 'start', 'stop', 'pause', ou 'resume'.`);
                    break;
            }

            if (done) {
                done(); // Sinaliza conclusão do processamento do input
            }
        });

        // --- Limpeza ao Fechar/Redeploy ---
        node.on('close', function(removed, done) {
            node.log("Nó sendo fechado/reimplantado. Parando stream se ativo.");
            stopStream(); // Tenta parar qualquer processo ativo

            // Espera um pouco para garantir que o processo foi morto antes de finalizar
            const checkInterval = setInterval(() => {
                 if (!node.ffmpeg_process) {
                      clearInterval(checkInterval);
                      node.log("Limpeza concluída.");
                      node.status({}); // Limpa o status final
                      done(); // Sinaliza que a limpeza terminou
                 }
            }, 100); // Verifica a cada 100ms

            // Timeout de segurança caso o processo demore muito a morrer
            setTimeout(() => {
                if (node.ffmpeg_process) {
                     clearInterval(checkInterval);
                     node.warn("Timeout na limpeza, processo ffmpeg pode não ter sido finalizado completamente.");
                     node.status({});
                     done();
                }
            }, 3000); // Timeout de 3 segundos para a limpeza
        });

        // Define o status inicial
        updateStatus();
    }
    RED.nodes.registerType("rtsp-client", RTSPClientNode);
}