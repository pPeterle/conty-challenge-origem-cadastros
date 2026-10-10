# Exemplo completo, do clique à auditoria

Sessão real com a API na porta 3104 e `curl`, depois dos três cliques no redirecionador (campanha, indicação e comunidade).

```bash
# primeira abertura; o aparelho informa que abriu 2 h antes de sincronizar
$ curl -s localhost:3104/installs -H 'content-type: application/json' \
  -d '{"install_id":"inst_8f2c","first_open_at":"2026-10-10T02:20:04Z"}'
{"install_id":"inst_8f2c","first_open_at":"2026-10-10T02:20:04.000Z","first_open_source":"aparelho","server_first_open_at":"2026-10-10T04:20:04.629Z","device_first_open_at":"2026-10-10T02:20:04.000Z","novo":true}   # 201

# o app abre pelo link de campanha
$ curl -s localhost:3104/touches -H 'content-type: application/json' \
  -d '{"install_id":"inst_8f2c","url":"https://conty.app/abrir?src=campanha&cmp=cmp_123&ch=instagram&cid=clk_fb736b081a8b42b39e65e7850f660e90"}'
{"install_id":"inst_8f2c","click_id":"clk_fb736b081a8b42b39e65e7850f660e90","source":"campanha","params":{"cmp":"cmp_123","ch":"instagram"},"clicked_at":"2026-10-10T04:19:46.487Z","touched_at":"2026-10-10T04:20:04.649Z","client_opened_at":null,"duplicado":false}   # 201

# o mesmo link de novo: 200 com "duplicado":true e o mesmo touched_at

# alguém troca a fonte do link de comunidade na URL
$ curl -s localhost:3104/touches -H 'content-type: application/json' \
  -d '{"install_id":"inst_8f2c","url":"https://conty.app/abrir?src=campanha&cmp=cmp_123&cid=clk_f067b20f830f470e955dedb599aaa616"}'
{"error":{"code":"click_divergente","message":"fonte ou parâmetros da url não batem com o clique gravado"}}   # 409

# ou inventa um cid
$ curl -s localhost:3104/touches -H 'content-type: application/json' \
  -d '{"install_id":"inst_8f2c","url":"https://conty.app/abrir?src=campanha&cmp=cmp_123&cid=clk_inventado_123"}'
{"error":{"code":"click_desconhecido","message":"esse cid não foi emitido pelo redirecionador (GET /l)"}}   # 400

# um segundo depois, o link de indicação
$ curl -s localhost:3104/touches -H 'content-type: application/json' \
  -d '{"install_id":"inst_8f2c","url":"https://conty.app/abrir?src=indicacao&ref=MARIA2026&cid=clk_59dba3ea274840f8b4a0462322e4afa7"}'
{"install_id":"inst_8f2c","click_id":"clk_59dba3ea274840f8b4a0462322e4afa7","source":"indicacao","params":{"ref":"MARIA2026"},"clicked_at":"2026-10-10T04:19:46.509Z","touched_at":"2026-10-10T04:20:05.716Z","client_opened_at":null,"duplicado":false}   # 201

# cadastro (201; repetir devolve 200 com o mesmo corpo)
$ curl -s localhost:3104/signups -H 'content-type: application/json' -d '{"user_id":"u_ana","install_id":"inst_8f2c"}'

# depois do cadastro chega o link de comunidade verdadeiro, que o aparelho diz ter aberto antes
$ curl -s localhost:3104/touches -H 'content-type: application/json' \
  -d '{"install_id":"inst_8f2c","url":"https://conty.app/abrir?src=comunidade&com=grupo_ugc&cid=clk_f067b20f830f470e955dedb599aaa616","opened_at":"2026-10-10T04:19:05Z"}'

$ curl -s localhost:3104/signups/u_ana/attribution
```

A resposta de `GET /signups/u_ana/attribution` desta sessão está no [README](../README.md#exemplo-real-do-clique-à-auditoria).
