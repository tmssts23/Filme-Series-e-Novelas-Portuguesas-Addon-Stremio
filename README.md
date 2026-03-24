# Filmes e Séries Portuguesas – Addon Stremio

Addon para o Stremio que carrega **filmes, séries e novelas portuguesas** a partir do site [Novelas Portuguesas](https://novelasportuguesas.com/). As novelas aparecem no catálogo de séries. Inclui página de configuração para associar a API de um serviço Debrid (RealDebrid ou AllDebrid); ao abrir um vídeo, o addon envia o conteúdo para a cloud do Debrid e o Stremio reproduz a partir daí.

## Funcionalidades

- **Catálogos**: Filmes Portugueses e Séries/Novelas Portuguesas
- **Filtro por nome e IMDb**: Os itens incluem nome e, quando disponível no site, o código IMDb para melhor identificação no Stremio
- **Configuração ao instalar**: Ao instalar o addon, é mostrada uma página de configuração onde escolhes o Debrid (RealDebrid ou AllDebrid) e colas a API key
- **Stream via Debrid**: Ao abrir um vídeo, o addon adiciona o link (magnet ou hoster) à cloud do Debrid e devolve o link direto para o Stremio reproduzir

## Como instalar

1. **Corre o addon** (em modo local ou num servidor):

   ```bash
   npm install
   npm run build
   npm start
   ```

   Por defeito o servidor fica em `http://localhost:7000`. O `npm start` usa o bundle em `dist/bundle.cjs`.

   - **Desenvolvimento local** (sem build): `npm run dev` (usa `index.js` e a pasta `lib/`).
   - Em produção não há dependências no `package.json`; a pasta `node_modules` fica vazia (0 itens, dentro do limite de 99). O deploy usa o bundle já construído (a pasta `dist/` deve ir no repositório).

2. **Abre a página de configuração** no browser:
   - Local: `http://localhost:7000/configure`
   - Em produção: `https://teu-dominio.com/configure`

3. Escolhe o **Debrid** (RealDebrid ou AllDebrid) e cola a **API key**:
   - RealDebrid: [real-debrid.com/apitoken](https://real-debrid.com/apitoken)
   - AllDebrid: [alldebrid.com/apikeys](https://alldebrid.com/apikeys)

4. Clica em **“Gerar link de instalação”** e usa o link no Stremio (Adicionar addon) ou “Abrir no Stremio”.

## Variável de ambiente

- `PORT` – Porta do servidor (predefinido: 7000)

## Deploy (Railway, etc.) – node_modules com ≤99 itens

Para que a pasta `node_modules` tenha **no máximo 99 ficheiros/pastas** (ex.: limite do Railway):

1. **Em local**: Gera o bundle e envia a pasta `dist/` no Git:
   ```bash
   npm install
   npm run build
   git add dist/
   git commit -m "Bundle para deploy"
   git push
   ```
2. **No Railway** (ou outro host):
   - **Build command**: `npm install` (como não há `dependencies`, instala 0 pacotes → `node_modules` vazio ou com 0 itens).
   - **Start command**: `npm start` (executa `node dist/bundle.cjs`).

Todas as dependências estão em `devDependencies` e são usadas só para fazer o build local; em produção o `package.json` tem `"dependencies": {}`, por isso `node_modules` fica com 0 itens (≤99).

## Estrutura do projeto

- `index.js` – Servidor HTTP, manifest, handlers de catalog/meta/stream
- `build.js` – Script de build (esbuild): gera `dist/bundle.cjs` com toda a app e dependências
- `lib/scraper.js` – Extração de filmes, séries e episódios do site novelasportuguesas.com
- `lib/debrid.js` – Integração com APIs RealDebrid e AllDebrid (adicionar à cloud e obter link)
- `lib/cinemeta.js` – Metadados (poster, descrição) via Cinemeta/IMDb
- `public/configure.html` – Página de configuração (Debrid + API key)

## Notas

- O conteúdo é obtido por scraping do site; se a estrutura do site mudar, o addon pode precisar de ajustes.
- Para links em hosters suportados pelo Debrid, o addon usa “unrestrict”/“unlock”; para magnets, adiciona o conteúdo à cloud do Debrid e devolve o link quando estiver pronto.
- AllDebrid pode bloquear pedidos a partir de IPs de servidor; em alguns casos é necessário usar o addon a partir de rede local ou de um ambiente onde o AllDebrid permita o uso.
