# O que ficou de fora e o que eu faria com mais tempo

## Fora do escopo

- Deferred deep link. Quando a pessoa clica, vai para a loja e instala, o deep link se perde no caminho. Recuperar o `cid` nesse caso depende da plataforma (Install Referrer no Android; área de transferência ou um serviço como Branch no iOS). O contrato aceita esse `cid` do mesmo jeito, só não implementei a captura.
- Autenticação das chamadas do app. A origem não pode ser forjada editando a URL (o clique gravado manda), mas qualquer um pode chamar `POST /touches` com um `cid` real que capturou. Amarrar o toque ao aparelho exigiria autenticar o app.
- Limite de taxa. Payloads inválidos e aberturas recusadas são baratos, mas as recusas gravam uma linha (sem duplicar o mesmo par install + url + motivo). Um proxy com rate limit resolveria o abuso.
- Relatório agregado por campanha ou por código de indicação, incluindo a taxa de clique para abertura. O redirecionador já grava cada clique em `clicks` e cada abertura fica em `touches`, então os dados existem; falta o endpoint.

## Com mais tempo

- Expiraria cliques sem toque depois de algum tempo, para a tabela `clicks` não crescer sem limite.
- Mediria a carga em Linux, numa máquina sem outros processos, para separar o limite do macOS do limite da API.
- Trocaria o teste de permutação fixo por testes de propriedade (fast-check) com toques gerados ao acaso.
