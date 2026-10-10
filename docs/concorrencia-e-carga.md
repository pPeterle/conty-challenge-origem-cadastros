# Concorrência, idempotência e teste de carga

## Como a API evita duplicar

- `touches.click_id UNIQUE` com `INSERT ... ON CONFLICT DO NOTHING` deixa um registro por clique, não importa quantas vezes o app reenvie.
- `installs.install_id` é PK com `ON CONFLICT DO NOTHING`. O `first_open_at` só muda num caso: o toque chegou antes do `POST /installs` (o install nasceu com o horário do servidor) e o aparelho depois informa uma primeira abertura plausível e anterior. Isso acontece uma vez, em `ensureInstall` ([`src/db.ts`](../src/db.ts)).
- `POST /signups` roda em `BEGIN IMMEDIATE`. Na mesma transação ele lê o cadastro existente e os toques, decide e grava. `signups.user_id` (PK) e `signups.winning_touch_id` (UNIQUE) seguram o caso de duas escritas passarem.
- Cadastros concorrentes de pessoas diferentes no mesmo aparelho são serializados. O primeiro leva o toque mais recente e o segundo leva o próximo válido. Qual dos dois é o primeiro depende de quem chegou antes, e cada auditoria registra o que aconteceu.

## Evolução para várias instâncias

Com mais de uma instância da API, eu trocaria sqlite por Postgres mantendo as mesmas restrições (`UNIQUE(click_id)`, `UNIQUE(winning_touch_id)`, PK em `user_id`). O cadastro passaria a usar `SELECT ... FOR UPDATE` nas linhas do install, ou `INSERT ... ON CONFLICT` no cadastro antes de decidir. Lock distribuído só entraria se o cadastro passasse a disparar algo fora do banco (pagar bônus de indicação, por exemplo), e mesmo aí eu tentaria antes uma tabela de saída (outbox) com chave de idempotência.

## O cenário de carga

`npm run load` sobe a API na porta 3104 com banco temporário e roda [`load/attribution.js`](../load/attribution.js) no `grafana/k6:0.54.0`. Cada iteração é um aparelho: são 2000 aparelhos divididos entre 50 VUs. Todo link passa antes pelo redirecionador (`GET /l` sem seguir o 302), que grava o clique e devolve a URL com o `cid`. Os 5 reenvios de cada clique e os 3 reenvios de cada cadastro saem em paralelo (`http.batch`). Os aparelhos se dividem em quatro perfis:

- sem link (primeira abertura repetida, com `first_open_at` do aparelho, e cadastro): esperado `organico`;
- um link de campanha: esperado `campanha` com aquele `cid`;
- indicação e depois campanha: esperado `campanha` com o segundo `cid`;
- indicação, cadastro e depois um link de comunidade: esperado `indicacao`, com o de comunidade fora da decisão.

Em cerca de 10% das iterações sai também um payload inválido sorteado entre 15 tipos: JSON quebrado, `null`, array, id numérico ou com espaço, url sem `cid`, `cid` inventado, url de outro host ou gigante (413), data sem fuso, rota inexistente, método errado. O check exige 4xx com corpo de erro JSON. `http.setResponseCallback` marca 400/404/409/413 como esperados, então eles não contam em `http_req_failed`.

Os checks do k6 conferem que cada lote de reenvios teve exatamente um 201 e o resto 200, e que todas as respostas de cadastro trouxeram a origem esperada. No fim, [`scripts/verify-load.ts`](../scripts/verify-load.ts) lê o banco e sai com código 1 em qualquer um destes casos:

- número de toques diferente do de cliques enviados, ou `click_id` repetido;
- toque sem clique gravado, ou com fonte/params diferentes do clique;
- abertura recusada fora dos installs de lixo do próprio teste;
- número de installs ou de cadastros diferente do esperado (um payload inválido que gravasse algo apareceria aqui);
- um toque como origem de dois cadastros;
- origem diferente da esperada;
- auditoria gravada que não bate com `decideAttribution` recalculada sobre o mesmo retrato;
- toque posterior ao cadastro que entrou na decisão.

## 50 VUs e o backlog do macOS

Com 50 VUs abrindo 250 conexões no mesmo instante, entre 0,4% e 2% das requisições falhavam com `EOF` ou `connection refused`. O `http_req_connecting` máximo ficava em torno de 1 s, o tempo de retransmissão de um SYN descartado. Disparei 300 `fetch` simultâneos direto do host, sem Docker no meio, e o mesmo acontecia (`ECONNRESET`). No macOS, `kern.ipc.somaxconn` é 128, e o kernel corta para esse valor o backlog que o Node pede no `listen`. Por isso aumentar o backlog pelo `@hono/node-server` não ajudaria sem mexer no sistema.

Duas mudanças no script de carga resolveram:

1. Cada VU espera `(id - 1) * 20 ms` antes da primeira iteração. As conexões abrem ao longo de cerca de 1 s e depois são reaproveitadas (keep-alive é o padrão do k6). Com isso o `http_req_connecting` máximo caiu de cerca de 1 s para poucos milissegundos.
2. Falha de conexão (status 0) é reenviada até 3 vezes, como o app faria. Reenviar é seguro porque toque e cadastro são idempotentes. Resposta HTTP nunca é reenviada. As tentativas que falharam continuam contando em `http_req_failed`.

## Resultado

Execução real no macOS com OrbStack, com a versão final (clique gravado, aberturas recusadas, zod). Outros processos rodavam na máquina (load average em torno de 9):

```
checks.........................: 100.00% 9203 out of 9203
http_req_duration..............: avg=24.9ms med=17.81ms p(90)=38.34ms p(95)=46.46ms max=1.24s
http_req_failed................: 0.00%   0 out of 22703
http_reqs......................: 22703   5245.088804/s
iterations.....................: 2000    462.061296/s

cliques gravados: 2500
toques: 2500 (esperado 2500), cliques distintos: 2500
installs: 2000 (esperado 2000)
cadastros: 2000 (esperado 2000), origens conferidas e auditorias recalculadas: 2000
OK: um toque por click_id, uma origem por cadastro, todas iguais à esperada.
```

Numa rodada anterior, com a máquina bem mais ocupada (load average em torno de 32), o p95 foi a 158,63 ms e 50 tentativas de conexão falharam e foram reenviadas (0,24% em `http_req_failed`). Os checks e a verificação passaram mesmo assim. Nesse estado, o p95 variou entre 89 ms e 215 ms de uma rodada para outra, então o threshold de latência (`p(95) < 200ms`) às vezes reprova sem que nenhuma invariante quebre. Os outros thresholds são `http_req_failed < 1%` e `checks > 99%`.

Num benchmark sem rede (`app.request` em série com sqlite em arquivo), toque + cadastro custam cerca de 0,5 ms por requisição. A latência do k6 é quase toda fila de até 250 requisições simultâneas num processo só.
