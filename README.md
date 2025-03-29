# node-red-contrib-rtsp-client

Um nó customizado para o Node-RED que atua como cliente RTSP para câmeras, permitindo capturar streams de vídeo via protocolo RTSP e convertê-los (por exemplo, para MJPEG) para que possam ser encaminhados para outros nós. Com ele, é possível enviar o fluxo de vídeo para um HTTP Response (para renderização no browser) ou para qualquer outro processamento em tempo real, como a classificação de imagens.

---

## Características

- **Conexão RTSP:** Configuração simples para informar usuário, senha e endereço (ip:porta/caminho) e construir a URL RTSP.
- **Conversão de Stream:** Utiliza o ffmpeg (ou a biblioteca rtsp-ffmpeg) para converter o stream RTSP em um formato compatível, como MJPEG.
- **Integração com Fluxos Node-RED:** Envia os dados de vídeo como buffer para o próximo nó do fluxo, permitindo a renderização ou processamento adicional.
- **Flexibilidade:** Pode ser integrado em fluxos para HTTP Response, análises em tempo real (ex.: classificação com Ollama), entre outros.

---

## Pré-requisitos

- **Node-RED:** Certifique-se de ter o Node-RED instalado e configurado.
- **Node.js:** Ambiente Node.js compatível com o Node-RED.
- **FFmpeg:** O ffmpeg deve estar instalado no sistema e acessível via PATH.
- **Dependências:** Este nó utiliza o pacote `rtsp-ffmpeg` (caso opte por esta abordagem) ou o módulo `child_process` para invocar o ffmpeg diretamente.

---

## Instalação

Você pode instalar este nó via npm:

    npm install node-red-contrib-rtsp-client

Após a instalação, reinicie o Node-RED para que o novo nó seja carregado e apareça na paleta de nós.

---

## Configuração do Nó

Ao adicionar o nó RTSP Client ao fluxo, você deverá configurar os seguintes parâmetros:

- **Nome:** (Opcional) Nome para identificação do nó.
- **Usuário:** Nome de usuário para autenticação na câmera.
- **Senha:** Senha correspondente para autenticação.
- **Endereço RTSP:** O endereço da câmera no formato `ip:porta/caminho`.

O nó irá construir a URL RTSP no formato:  
`rtsp://usuário:senha@endereço`

---

## Exemplo de Fluxo

Um exemplo básico de fluxo pode ser:

1. **HTTP In:** Configurado para receber requisições.
2. **RTSP Client:** Conecta à câmera usando os dados de configuração e inicia o stream.
3. **Nó de Processamento/HTTP Response:** Recebe o buffer do vídeo e envia a resposta para o browser ou para um serviço de processamento.

### Exemplo de código para HTTP Response:

    res.writeHead(200, {
        'Content-Type': 'multipart/x-mixed-replace; boundary=--myboundary'
    });

    // Ao receber um frame (buffer):
    res.write("--myboundary\r\n");
    res.write("Content-Type: image/jpeg\r\n");
    res.write("Content-length: " + frameBuffer.length + "\r\n\r\n");
    res.write(frameBuffer);
    res.write("\r\n");

Esse exemplo demonstra como enviar frames JPEG contínuos para o browser.

---

## Desenvolvimento e Customização

- **Estrutura do Projeto:**  
  - `package.json`: Contém os metadados e dependências.
  - `rtsp-client.js`: Implementação do nó, onde o ffmpeg é invocado para capturar e converter o stream.
  - `rtsp-client.html`: Interface de configuração do nó na paleta do Node-RED.

- **Ajustes do FFMPEG:**  
  Os parâmetros do ffmpeg podem ser modificados conforme a necessidade, seja para alterar a qualidade, o formato ou para adaptar a outros protocolos como HLS ou RTMP.

- **Debug e Logs:**  
  O nó registra erros e status do processo ffmpeg para facilitar a identificação de problemas.

---

## Contribuições

Contribuições são bem-vindas! Se você deseja contribuir com melhorias, correções de bugs ou novas funcionalidades, siga os passos abaixo:

1. Faça um fork do repositório.
2. Crie uma branch para sua feature ou correção.
3. Envie um pull request com uma descrição detalhada das mudanças.

---

## Licença

Este projeto é licenciado sob a [MIT License](LICENSE).

---

## Contato

Caso tenha dúvidas ou sugestões, sinta-se à vontade para abrir uma issue ou entrar em contato através do repositório do projeto.

---

Com este nó, você pode facilmente integrar o stream de câmeras RTSP aos seus fluxos no Node-RED, possibilitando desde a visualização em tempo real até análises avançadas de vídeo. Aproveite e customize conforme suas necessidades!
