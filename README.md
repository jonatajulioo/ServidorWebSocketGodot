# Servidor WebSocket para o Addon "Simple Multiplayer" da Godot

Este repositório contém o código-fonte do servidor Node.js projetado para funcionar com o [Simple WebSocket Multiplayer for Godot](https://github.com/welson-rodrigues/GodotWebSocketMultiplayer).

O servidor é construído com Express e a biblioteca `ws`, fornecendo uma solução leve e eficiente para gerenciar salas de jogo, jogadores e sincronização de dados básicos.

## Funcionalidades

* Gerenciamento de conexões de clientes via WebSocket.
* Criação de salas com códigos únicos.
* Gerenciamento de entrada e saída de jogadores nas salas.
* Broadcast de eventos (novo jogador, desconexão, posições) para os jogadores na mesma sala.
* Estrutura básica para adicionar novas mensagens de gameplay (ex: chat, ataques).

## Como Rodar

### Pré-requisitos

* [Node.js](https://nodejs.org/) (versão 14 ou superior recomendada)
* [npm](https://www.npmjs.com/) (geralmente instalado junto com o Node.js)

### 1. Configuração Local (para Desenvolvimento)

1.  Clone este repositório:
    ```sh
    git clone https://github.com/welson-rodrigues/GodotWebSocketMultiplayer
    ```
2.  Navegue até a pasta do projeto:
    ```sh
    cd GodotWebSocketMultiplayer
    ```
3.  Instale as dependências necessárias:
    ```sh
    npm install
    ```
4.  Inicie o servidor:
    ```sh
    node server.js
    ```
    Por padrão, o servidor irá rodar na porta `9090`. Seu cliente Godot deve se conectar em `ws://localhost:9090`.

### 2. Deploy Online (para Produção)

Este servidor está pronto para ser hospedado em diversas plataformas de "Platform as a Service" (PaaS).

#### Exemplo com Render.com

O Render.com oferece um plano gratuito ideal para hospedar este tipo de servidor.

1.  Faça um "fork" deste repositório para a sua própria conta do GitHub.
2.  Crie uma conta no [Render.com](https://render.com/).
3.  No seu dashboard, clique em **"New +"** e selecione **"Web Service"**.
4.  Conecte sua conta do GitHub e selecione o repositório do servidor.
5.  Nas configurações, o Render geralmente detecta que é um projeto Node.js e preenche os comandos automaticamente:
    * **Build Command:** `npm install`
    * **Start Command:** `node server.js`
6.  Clique em **"Create Web Service"**. Após o deploy, o Render fornecerá uma URL pública (ex: `https://meu-servidor.onrender.com`).
7.  No seu projeto Godot, configure a URL de conexão para `wss://meu-servidor.onrender.com` (note o **wss://** para conexões seguras).

## Licença

Este projeto é distribuído sob a licença MIT.

---
*Criado por Zee GameDev e Configurado para o SWW por jottadev*
