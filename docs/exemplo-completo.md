# Exemplo completo, do clique à auditoria

Sessão real com a API na porta 3104 e `curl`, depois de quatro cliques no redirecionador (`GET /l`). Estes são os `location` que ele devolveu:

```
C1=https://conty.app/abrir?src=campanha&cmp=cmp_123&ch=instagram&cid=clk_52aa11d3c29f484fa4b96c65557332e7
C2=https://conty.app/abrir?src=indicacao&ref=MARIA2026&cid=clk_b23a7c34179043c88a7af1413493a4b4
C3=https://conty.app/abrir?src=comunidade&com=grupo_ugc&cid=clk_815d8d5858294e2fb87e71f219fea242
C4=https://conty.app/abrir?src=campanha&cmp=cmp_456&cid=clk_61ac6e0f1e06498ebe3664e4cc06ebe4
```

```bash
# primeira abertura; o aparelho informa que abriu 2 h antes de sincronizar
$ curl -s localhost:3104/installs -H 'content-type: application/json' \
  -d '{"install_id":"inst_8f2c","first_open_at":"2026-10-10T11:04:37Z"}'
{"install_id":"inst_8f2c","first_open_at":"2026-10-10T11:04:37.000Z","first_open_source":"aparelho","server_first_open_at":"2026-10-10T13:04:37.845Z","device_first_open_at":"2026-10-10T11:04:37.000Z","novo":true}   # 201

# o app abre pelo link de campanha
$ curl -s localhost:3104/touches -H 'content-type: application/json' \
  -d '{"install_id":"inst_8f2c","url":"https://conty.app/abrir?src=campanha&cmp=cmp_123&ch=instagram&cid=clk_52aa11d3c29f484fa4b96c65557332e7"}'
{"install_id":"inst_8f2c","click_id":"clk_52aa11d3c29f484fa4b96c65557332e7","source":"campanha","params":{"cmp":"cmp_123","ch":"instagram"},"clicked_at":"2026-10-10T13:04:37.741Z","touched_at":"2026-10-10T13:04:37.870Z","client_opened_at":null,"vezes_recebido":1,"duplicado":false}   # 201

# o mesmo link de novo: duplicado, vezes_recebido sobe para 2
$ curl -s localhost:3104/touches -H 'content-type: application/json' \
  -d '{"install_id":"inst_8f2c","url":"https://conty.app/abrir?src=campanha&cmp=cmp_123&ch=instagram&cid=clk_52aa11d3c29f484fa4b96c65557332e7"}'
{"install_id":"inst_8f2c","click_id":"clk_52aa11d3c29f484fa4b96c65557332e7","source":"campanha","params":{"cmp":"cmp_123","ch":"instagram"},"clicked_at":"2026-10-10T13:04:37.741Z","touched_at":"2026-10-10T13:04:37.870Z","client_opened_at":null,"vezes_recebido":2,"duplicado":true}   # 200

# alguém troca a fonte do link de comunidade na URL
$ curl -s localhost:3104/touches -H 'content-type: application/json' \
  -d '{"install_id":"inst_8f2c","url":"https://conty.app/abrir?src=campanha&cmp=cmp_123&cid=clk_815d8d5858294e2fb87e71f219fea242"}'
{"error":{"code":"click_divergente","message":"fonte ou parâmetros da url não batem com o clique gravado"}}   # 409

# ou inventa um cid
$ curl -s localhost:3104/touches -H 'content-type: application/json' \
  -d '{"install_id":"inst_8f2c","url":"https://conty.app/abrir?src=campanha&cmp=cmp_123&cid=clk_inventado_123"}'
{"error":{"code":"click_desconhecido","message":"esse cid não foi emitido pelo redirecionador (GET /l)"}}   # 400

# um segundo depois, o link de indicação
$ curl -s localhost:3104/touches -H 'content-type: application/json' \
  -d '{"install_id":"inst_8f2c","url":"https://conty.app/abrir?src=indicacao&ref=MARIA2026&cid=clk_b23a7c34179043c88a7af1413493a4b4"}'
{"install_id":"inst_8f2c","click_id":"clk_b23a7c34179043c88a7af1413493a4b4","source":"indicacao","params":{"ref":"MARIA2026"},"clicked_at":"2026-10-10T13:04:37.776Z","touched_at":"2026-10-10T13:04:38.957Z","client_opened_at":null,"vezes_recebido":1,"duplicado":false}   # 201

# o cadastro já aconteceu no backend, mas a chamada ainda não chegou; nisso abre o link de comunidade
$ curl -s localhost:3104/touches -H 'content-type: application/json' \
  -d '{"install_id":"inst_8f2c","url":"https://conty.app/abrir?src=comunidade&com=grupo_ugc&cid=clk_815d8d5858294e2fb87e71f219fea242"}'
{"install_id":"inst_8f2c","click_id":"clk_815d8d5858294e2fb87e71f219fea242","source":"comunidade","params":{"com":"grupo_ugc"},"clicked_at":"2026-10-10T13:04:37.798Z","touched_at":"2026-10-10T13:04:40.526Z","client_opened_at":null,"vezes_recebido":1,"duplicado":false}   # 201

# a chamada de cadastro chega com o signed_up_at do backend (resposta 201; repetir devolve 200)
$ curl -s localhost:3104/signups -H 'content-type: application/json' \
  -d '{"user_id":"u_ana","install_id":"inst_8f2c","signed_up_at":"2026-10-10T13:04:39.500Z"}'
(o corpo da auditoria do README, ainda sem o toque que chegou depois)   # 201

# depois do cadastro, um link de campanha que o aparelho diz ter aberto antes
$ curl -s localhost:3104/touches -H 'content-type: application/json' \
  -d '{"install_id":"inst_8f2c","url":"https://conty.app/abrir?src=campanha&cmp=cmp_456&cid=clk_61ac6e0f1e06498ebe3664e4cc06ebe4","opened_at":"2026-10-10T13:03:41.085Z"}'
{"install_id":"inst_8f2c","click_id":"clk_61ac6e0f1e06498ebe3664e4cc06ebe4","source":"campanha","params":{"cmp":"cmp_456"},"clicked_at":"2026-10-10T13:04:37.815Z","touched_at":"2026-10-10T13:04:41.609Z","client_opened_at":"2026-10-10T13:03:41.085Z","vezes_recebido":1,"duplicado":false}   # 201
```

A resposta de `GET /signups/u_ana/attribution` desta sessão está no [README](../README.md#exemplo-real-do-clique-à-auditoria).
