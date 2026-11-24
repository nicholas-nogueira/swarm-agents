// Erro dos adapters: mensagem amigável em pt-BR e um código estável para o instalador e os testes.
export class AdapterError extends Error {
  /**
   * @param {string} message mensagem para o usuário final
   * @param {string} [code] código estável (ex.: PAYLOAD_INCOMPLETO)
   */
  constructor(message, code = 'ADAPTER_ERRO') {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
  }
}
