# Retry da configuração anterior ao webhook

Base: Evolution API 2.3.7, commit `cd800f2976e1e5b682fbf86a01ee4d85ae61f370`.

“Mitiga indisponibilidades transitórias durante a leitura da configuração anterior ao POST, mas não garante captura durável do evento contra restart/falhas anteriores.”

## Política

`WebhookController.emit()` chama `readConfigForEmission()` antes da preparação e
do envio HTTP. O método repete somente `EventController.get(instanceName)`.
Não reexecuta `messages.upsert`, persistência, chatbot ou efeitos anteriores.

- No máximo quatro leituras, em sequência.
- Esperas entre leituras: 100 ms, 200 ms e 400 ms, sem jitter.
- Espera adicional máxima: 700 ms, além da duração das próprias consultas.
- Uma consulta ainda depende dos timeouts existentes do Prisma/pool. Esta
  alteração não cria um timeout global nem muda o pool.
- Sucesso continua pelo mecanismo HTTP original, sem modificá-lo.
- Ausência, desabilitação e filtros da configuração mantêm o comportamento atual.
- Erro permanente ou esgotamento rejeita a Promise com
  `WEBHOOK_CONFIG_READ_FAILED`, `databaseCode` e `attempts` sanitizados.

## Classificação de erros

Whitelist: P1001 (banco inacessível), P1002 (timeout ao conectar), P1017
(conexão encerrada) e P2024 (timeout ao obter conexão do pool). O retry ocorre
somente nesta leitura idempotente, não em mutações ou transações.

São aceitos tanto `code` de erros de request quanto `errorCode` de erros de
inicialização do Prisma. Um `code` presente prevalece sobre `errorCode`.

Não retentar automaticamente P1000/P1010 (credenciais/permissões), P1003/P1012/
P2021/P2022 (banco/schema/configuração), P1011 (TLS), P1008 (timeout genérico de
operação), P2034 (transação/deadlock), P2037 (limite de conexões), panic, erro
desconhecido ou texto que apenas mencione um código transitório.

Referência: https://www.prisma.io/docs/orm/v6/reference/error-reference

### Revisão conservadora da allowlist

Os significados abaixo resumem a referência oficial do Prisma ORM v6. As
justificativas de retry são decisões de projeto para esta leitura, não uma
garantia do Prisma de que todo erro com esses códigos seja temporário.

| Código | Significado oficial | Possível condição temporária e segurança da leitura | Decisão |
| --- | --- | --- | --- |
| P1001 | Não foi possível alcançar o servidor de banco no host/porta informados. | Uma interrupção de rede ou recuperação do servidor pode terminar entre leituras. Repetir findUnique não reaplica escrita. Host incorreto também pode causar esse erro; o limite evita insistência indefinida. | Manter |
| P1017 | O servidor encerrou a conexão. | Reinício ou encerramento de uma conexão pode permitir recuperação posterior. Mesmo se o SELECT anterior executou antes de a conexão cair, repetir a leitura não duplica efeitos. | Manter |
| P1002 | O servidor foi alcançado, mas ocorreu timeout. | A conexão pode voltar a responder após atraso temporário. A leitura é idempotente; não se repete processamento anterior nem se interpreta timeout genérico pelo texto. | Manter |
| P2024 | Expirou a espera por uma nova conexão do pool. | Uma conexão ocupada pode ser liberada depois. Não houve obtenção de conexão para executar esta leitura; tentar novamente pode funcionar. Saturação sustentada também pode provocar o erro, portanto o retry não aumenta pool/limites e para na quarta tentativa. | Manter |

Nenhum código adicional foi incluído nesta revisão. Não há retry de escrita,
transação, erro desconhecido ou classificação baseada apenas em mensagem de
exceção. `code`/`errorCode` confiáveis têm prioridade sobre texto genérico.

## Observabilidade e limites

Os novos logs registram somente evento técnico, código validado, tentativa e
espera. Não recebem instância, telefone, conteúdo, destino, credenciais, erro
original, stack original, metadata ou cause. O erro propagado também não carrega
o erro original, evitando vazamento pelo logger global de unhandled rejection.

O logging HTTP/WEBHOOKS legado permanece inalterado. Quando habilitado, ele pode
registrar payloads e metadados conforme o comportamento anterior; esta alteração
não deve ser apresentada como sanitização de todos os logs da Evolution.

A chamada de emissão do Baileys continua com seu contrato existente. Esgotar a
leitura gera erro explícito e log, mas não cria uma fila, reentrega após restart
ou garantia de captura. Falhas de settings/chat/persistência e integrações
anteriores continuam fora do alcance desta mitigação.

## Validação local segura

```sh
node --test tests/webhook-config-read-retry.test.cjs
```

Os testes transpilam o controller TypeScript real para execução, substituindo
Prisma, HTTP, logger e temporizadores por mocks. Nenhum servidor, WhatsApp ou
banco real é acessado.
TypeScript já é dependência de desenvolvimento do projeto.

Nenhuma variável de ambiente, migration, syncFullHistory, ownership, delivery ou
arquivo do Studiofy faz parte desta alteração.
