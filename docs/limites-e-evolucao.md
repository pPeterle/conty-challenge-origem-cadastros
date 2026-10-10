# O que ficou de fora e o que eu faria com mais tempo

## Fora do escopo

- Deferred deep link. Quando a pessoa clica, vai para a loja e instala, o deep link se perde no caminho. Recuperar o `cid` nesse caso depende da plataforma (Install Referrer no Android; área de transferência ou um serviço como Branch no iOS). O contrato aceita esse `cid` do mesmo jeito, só não implementei a captura.
- Autenticação das chamadas do app e assinatura do link. Hoje dá para forjar um `src=campanha`, e um HMAC sobre `src` + params + `cid` no redirecionador resolveria. Pelo mesmo motivo, um `cid` reenviado com outro `src` devolve o toque original (`duplicado: true`) em vez de um erro.
- Relatório agregado por campanha ou por código de indicação. Os dados estão nas tabelas, mas não há endpoint.
- O redirecionador não grava o clique. Gravar daria a taxa de clique para abertura, sem mudar a atribuição.

## Com mais tempo

- Guardaria a versão da regra no cadastro (`regra.versao`), para poder trocar last touch por outra regra sem ambiguidade ao ler cadastros antigos.
- Mediria a carga em Linux, numa máquina sem outros processos, para separar o limite do macOS do limite da API.
- Testaria com propriedades (fast-check) que `decideAttribution` não depende da ordem de entrada e que nunca há mais de um vencedor.
