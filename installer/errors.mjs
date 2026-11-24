// Erros do instalador: sempre com mensagem amigável em pt-BR, um código estável e o código de saída da CLI.

export const EXIT = Object.freeze({ OK: 0, ERROR: 1, CONFLICT: 2 });

export class InstallerError extends Error {
  /**
   * @param {string} message mensagem para o usuário (pt-BR, sem stack, sem conteúdo de arquivo)
   * @param {{ code?: string, exitCode?: number, cause?: unknown }} [opts]
   */
  constructor(message, { code = 'ERRO', exitCode = EXIT.ERROR, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'InstallerError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

/** Texto curto e seguro de um erro de sistema (código + mensagem, sem stack). */
export function describeCause(err) {
  if (!err) return 'motivo desconhecido';
  const code = err.code ? `${err.code}: ` : '';
  return `${code}${err.message ?? String(err)}`;
}
