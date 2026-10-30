[EN](README.md) | [简](README.zh-CN.md) | [繁](README.zh-TW.md) | [KO](README.ko.md) | [JA](README.ja.md) | **PT**

# Alertas de cota

Receba alertas no computador quando a cota da sessão de uma conta ficar baixa, se recuperar ou voltar a ficar completa.

![Ícone de alertas de cota](assets/icon.png)

## Recursos

- Interface apenas nas configurações, com opções que são salvas imediatamente.
- Limite configurável, com um alerta por provedor e conta até a cota se recuperar.
- Notificações no computador com botão de teste manual.
- Interface e README em inglês, chinês simplificado e tradicional, coreano, japonês e português brasileiro.

## Compatibilidade

A versão 0.1.0 se destina ao host experimental `tmApi: 1` atual com as alterações de metadados de exibição incluídas. Os comandos de compilação e validação estão em [MAINTAINING.md](MAINTAINING.md).

Os testes automatizados específicos cobrem avaliação de limites, configurações, envio simulado e integridade do pacote. **O layout nativo final e a entrega real de notificações ainda não foram validados.** Um teste de desenvolvimento apresentou falha na notificação do computador. Windows, Linux e o host empacotado também não foram validados.

O plugin usa leituras de cota existentes, sem consultas adicionais aos provedores. Dados ausentes ou desatualizados não são tratados como zero. Não há cartão na página inicial, página independente nem efeito de pulsação na janela inteira.

## Instalação

Nas versões do App que incluem este plugin oficial opcional, abra **Configurações → Plugins → Descobrir**, selecione **Alertas de cota** no grupo oficial Token Monitor e escolha **Instalar e ativar**. Escolha **Apenas instalar** para mantê-lo desativado. Revise a sugestão de execução em segundo plano; a opção global de plugins e o modo de segurança continuam valendo.

Não é necessário adicionar uma URL de catálogo. Também é possível importar `quota-alerts-0.1.0.tmplugin` ou a pasta completa do código em Configurações → Plugins. Uma importação local tem origem local; a identificação oficial se aplica ao pacote incluído no App.

## Uso

1. Nas configurações do plugin, ative **Alertas de cota baixa** e escolha um limite de cota restante, por exemplo 10%.
2. Se quiser, ative **Alertas de recuperação / cota completa**. Uma leitura nova que volta de abaixo do limite para o limite ou acima gera um alerta de recuperação; de menos de 100% para exatamente 100% gera um alerta de cota completa. O mesmo evento de cota completa não envia também um segundo alerta de recuperação.
3. Use **Testar notificação no computador** para verificar o envio. Envia uma notificação real identificada como teste, sem usar leituras de cota nem alterar o histórico de deduplicação. O teste funciona mesmo com os dois alertas automáticos desativados.
4. Permita a execução em segundo plano no gerenciamento de plugins para continuar recebendo alertas após fechar as configurações. O App sugere isso na primeira configuração, mas você pode recusar ou alterar depois. O Token Monitor precisa continuar aberto.

As duas opções vêm desativadas e são independentes. A primeira leitura, uma mudança de fonte e o reinício do backend estabelecem uma referência silenciosa, sem avisar sobre contas já completas. Leituras repetidas de 100% não geram novos alertas. O fim da contagem de redefinição, por si só, não comprova recuperação.

As opções são salvas imediatamente. O limite é salvo ao sair do campo ou pressionar Enter. Falhas ao salvar restauram os valores confirmados e exibem uma mensagem.

Leituras baixas repetidas não geram novos alertas até a recuperação. Reiniciar o App ou alterar a identidade da fonte pode iniciar um novo episódio. Falhas de envio não são repetidas automaticamente.

Exemplos de texto gerados com dados de fixture; não são capturas de notificações do sistema:

```text
Codex: cota baixa
Session: 7% restante
```

```text
Codex: cota completa
Session: 100% restante
```

## Dados e acesso

Plugins executam código confiável com os privilégios do usuário local. Este plugin lê dados de cota já coletados e a preferência de idioma do App, sem ler credenciais nem consultar provedores. As preferências e o histórico de alertas ficam no diretório de dados do plugin gerenciado pelo App.

Os alertas no computador usam a operação de notificação do host. Este plugin não faz solicitações de rede diretamente.

## Atualizações

O pacote oficial é atualizado junto com o App. Revise e aprove o código alterado antes de executá-lo; a ativação, as preferências e a escolha confirmada de segundo plano continuam sob seu controle. A reversão restaura o código, não desfaz notificações já enviadas.

## Licença e créditos

Mantido por **Javis603**. Adaptado da contribuição de **Matheus Rosendo (@matheusrosendo)** no [PR #538](https://github.com/Javis603/token-monitor/pull/538), sem incorporar o PR inteiro. O crédito não indica que ele mantém ou endossa esta adaptação.

A origem e as partes reutilizadas estão em [NOTICE.md](NOTICE.md), e a [licença MIT](LICENSE) original está incluída. O ícone de sino é uma criação original para esta adaptação, sob a mesma licença. Consulte [MAINTAINING.md](MAINTAINING.md) para detalhes técnicos e validações pendentes.
