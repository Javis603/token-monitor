# OpenAI API Credits

Veja o saldo real de créditos da API da plataforma OpenAI na tela nativa de cotas do Token Monitor.

![Saldo de créditos da API OpenAI na tela de cotas](assets/limits.png)

Exemplo da interface. O saldo e a validade dependem da sua conta.

## Recursos

- Entrada **OpenAI** que pode ser ordenada junto aos provedores nativos, com ícone e cores do Codex, incluindo suas cores personalizadas.
- Barra de progresso e saldo, ou apenas saldo.
- Valores restantes e validade em UTC para vários créditos utilizáveis com vencimentos diferentes.
- Credenciais de sessão inseridas manualmente, verificadas e gerenciadas pelo App.
- Interface, README e histórico em inglês, chinês tradicional e simplificado, japonês, coreano e português brasileiro.

## Compatibilidade e instalação

Requer **Token Monitor 0.88.0 ou posterior**.

Em **Configurações → Plugins**, importe o arquivo `.tmplugin` ou a pasta completa do código-fonte, revise e ative. Em **Cota de ferramentas de IA**, selecione e expanda **OpenAI**. A instalação não configura uma conta automaticamente.

## Configuração

1. Copie a URL de cobrança nas configurações da OpenAI para seu navegador habitual. Entre na conta e selecione a organização.
2. Abra DevTools (**F12** ou **Cmd+Opt+I**) → **Network**, recarregue e selecione `credit_grants`.
3. Em **Headers → Request Headers**, copie `Authorization` para **Platform session token** e `OpenAI-Organization` para **Organization ID**. O token pode incluir o prefixo `Bearer`. Não use uma API key comum, um cabeçalho Cookie ou um token do ChatGPT/Codex.
4. Salve as credenciais. O App verifica os dados e recolhe o editor após o sucesso. Volte a **Cotas** para ver o saldo.

Use a opção de alterar credenciais para substituir os valores salvos; os segredos nunca são preenchidos de volta nos campos. Obtenha novas credenciais quando a sessão expirar. Não as compartilhe em conversas ou capturas de tela.

## Exibição e atualização

O saldo vem diretamente da OpenAI. O total da barra inclui apenas créditos atualmente utilizáveis que ainda têm saldo. Créditos expirados ou esgotados são excluídos, por isso o total pode mudar conforme o estado dos créditos. A configuração de crédito usado/restante do App controla a porcentagem, o preenchimento e o valor exibido em conjunto. O valor usado é calculado sobre o conjunto de créditos atual.

Quando não há um total confiável, apenas o saldo é exibido. Abaixo da barra aparece o vencimento conhecido mais próximo dos créditos utilizáveis. Para dois a doze créditos utilizáveis com vencimentos diferentes, o tooltip lista cada saldo e vencimento. Detalhamentos maiores são omitidos.

A atualização segue o intervalo de cotas, a configuração adaptativa e a visibilidade da interface do App. A opção de exibição é salva assim que é alterada. Salvar credenciais realiza uma verificação separada.

## Dados e acesso

O App armazena as credenciais em um arquivo privado e não criptografado em `plugin-credentials/openai-api-credit/credits.json`, no diretório de dados do usuário, separado do código e das preferências comuns. O backend as envia para `https://api.openai.com/v1/dashboard/billing/credit_grants` pelo transporte do App com suporte a proxy. Esse endpoint não documentado e as credenciais de sessão podem mudar ou expirar. No Windows, o acesso segue as permissões herdadas da pasta; o App não define uma ACL exclusiva do proprietário.

O plugin usa as credenciais de sessão que você informa e não lê arquivos de login de outros apps nem envia dados de análise. Plugins são código local confiável e podem acessar os arquivos do usuário do sistema.

## Atualizações

Importe um pacote mais recente em **Configurações → Plugins** e revise a atualização. Nada é instalado automaticamente. Veja o [histórico](CHANGELOG.pt-BR.md).

Para compilar na raiz do repositório, escolha um caminho de saída que ainda não exista:

```sh
node scripts/build-plugin-package.js plugins/openai-api-credit ./openai-api-credit-0.1.0.tmplugin
```

## Licença

[MIT](LICENSE).
