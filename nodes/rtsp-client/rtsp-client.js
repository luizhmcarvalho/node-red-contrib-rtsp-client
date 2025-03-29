module.exports = function(RED) {
    function RTSPClientNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        node.on('input', function(msg) {
            // Obtém os parâmetros de configuração
            node.username = config.username || msg.rtsp?.username || null;
            node.password = config.password || msg.rtsp?.password || null;
            node.address = config.address || msg.rtsp?.address || null;
            
            // Monta a URL RTSP (por exemplo: rtsp://user:pass@ip:porta/caminho)

            var rtspUrl = '';
            if(node.username && node.password)
                rtspUrl = `rtsp://${node.username}:${node.password}@${node.address}`;
            else if(node.username)
                rtspUrl = `rtsp://${node.username}@${node.address}`;
            else 
                rtspUrl = `rtsp://${node.address}`;

            
            // Inicia o ffmpeg para converter o stream RTSP em MJPEG
            const { spawn } = require('child_process');
            // Comando: conecta no RTSP e converte para MJPEG, enviando a saída para o pipe
            var ffmpeg = spawn('ffmpeg', [
                '-i', rtspUrl,
                '-f', 'mjpeg',
                '-q:v', '5',
                'pipe:1'
            ]);
            
            // Emite os dados do stdout (fluxo do vídeo) para o próximo nó
            ffmpeg.stdout.on('data', (data) => {
                // Cria uma mensagem com o payload como buffer de vídeo
                msg.payload = data;
                // Envia a mensagem para o próximo nó
                node.send(msg);
            });
            
            // Trata possíveis erros do ffmpeg
            ffmpeg.stderr.on('data', (data) => {
                node.error("Erro no ffmpeg: " + data.toString());
            });
            
            ffmpeg.on('close', (code) => {
                node.log("Processo ffmpeg encerrado com código: " + code);
            });
            
            // Finaliza o processo se o nó for fechado
            node.on('close', function() {
                if(ffmpeg) {
                    ffmpeg.kill('SIGTERM');
                }
            });

        });
    }
    RED.nodes.registerType("rtsp-client", RTSPClientNode);
}
