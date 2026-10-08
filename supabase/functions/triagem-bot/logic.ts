// Lógica pura do bot de triagem (sem banco, sem rede) — testada em logic.test.ts.
// identificarPorTexto veio do Almore (926c795): ignora e-mail, link e
// credenciais e só casa palavra inteira.

// Rodapé da lista interativa ("Ver setores") no WhatsApp.
export const LIST_TITULO = "Parabrisas Petrucci";

export interface DepartamentoOrdenavel { id: string; nome: string; ordem: number; }

// Ordem do menu = coluna `ordem` (definida na aba Departamentos); empate pelo
// nome. O número que o cliente digita é a posição nesta lista, então menu,
// lista interativa e leitura da resposta usam sempre o mesmo array.
export function ordenarDepartamentos<T extends DepartamentoOrdenavel>(deps: readonly T[]): T[] {
  return [...deps].sort((a, b) => a.ordem - b.ordem || a.nome.localeCompare(b.nome, "pt-BR"));
}

function normalizar(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

const MAX_TEXTO_ANALISAVEL = 4_096;

function ehAlfanumerico(c: string | undefined): boolean {
  return c !== undefined && /[\p{L}\p{N}]/u.test(c);
}

function contemConteudoTecnico(s: string): boolean {
  if (s.length > MAX_TEXTO_ANALISAVEL) return true;

  const compat = s
    .normalize("NFKC")
    .toLowerCase()
    // Separadores equivalentes ao ponto usados em nomes de domínio IDN.
    .replace(/[\u3002\uFF0E\uFF61]/gu, ".")
    // Barras Unicode usadas para ofuscar URLs e caminhos.
    .replace(/[\u2044\u2215\uFF0F]/gu, "/");
  // Em vez de tentar interpretar credenciais, falha de forma segura para a
  // mensagem inteira. Isso cobre e-mail, qualquer esquema de URL e caminhos.
  if (
    compat.includes("@") ||
    compat.includes("://") ||
    compat.includes("/") ||
    compat.includes("\\") ||
    /(?:^|[^\p{L}\p{N}+.-])[a-z][a-z0-9+.-]*:\S/u.test(compat) ||
    /\p{Cf}/u.test(compat)
  ) {
    return true;
  }

  // Domínio sem protocolo, IP ou token técnico com ponto interno. O scanner é
  // linear e não usa uma regex de e-mail sujeita a custo quadrático.
  return compat.split(/\s+/u).some((segmento) => {
    const chars = [...segmento];
    return chars.some(
      (c, i) => c === "." && ehAlfanumerico(chars[i - 1]) && ehAlfanumerico(chars[i + 1]),
    );
  });
}

function palavras(s: string): string[] {
  return normalizar(s).match(/[\p{L}\p{N}]+/gu) ?? [];
}

// Palavra do nome casa com palavra do cliente quando é igual ou só muda o
// plural ("venda" ↔ "vendas"). Prefixo livre não vale: "contabilidade" não é
// "contábil".
function casaPalavra(doNome: string, doCliente: string): boolean {
  return doNome === doCliente || doNome === `${doCliente}s` || doCliente === `${doNome}s`;
}

function contemSequencia(frase: string[], trecho: string[]): boolean {
  if (trecho.length === 0 || trecho.length > frase.length) return false;
  for (let inicio = 0; inicio <= frase.length - trecho.length; inicio++) {
    if (trecho.every((palavra, i) => frase[inicio + i] === palavra)) return true;
  }
  return false;
}

// Palavras genéricas de conversa que NÃO ajudam a identificar o setor/pessoa.
const STOPWORDS = new Set([
  "quero",
  "queria",
  "gostaria",
  "preciso",
  "necessito",
  "desejo",
  "pode",
  "ser",
  "escolho",
  "escolher",
  "fico",
  "falar",
  "com",
  "o",
  "a",
  "os",
  "as",
  "um",
  "uma",
  "uns",
  "umas",
  "de",
  "do",
  "da",
  "dos",
  "das",
  "no",
  "na",
  "nos",
  "nas",
  "em",
  "pra",
  "para",
  "por",
  "favor",
  "pf",
  "pfv",
  "setor",
  "departamento",
  "depto",
  "opcao",
  "opcoes",
  "numero",
  "e",
  "ou",
  "que",
  "meu",
  "minha",
  "assunto",
  "sobre",
  "atendimento",
  "me",
  "ajuda",
  "ajudar",
  "ao",
  "isso",
  "esse",
  "essa",
  "tem",
  "ver",
  // "sem" é palavra comum ("estou sem vidro") e não pode, sozinha, mandar a
  // conversa para "Sem parar". O nome inteiro ("sem parar") continua casando.
  "sem",
]);

// Em uma resposta numérica misturada com texto, só estas palavras formam um
// pedido explícito de escolha. Evita tratar horário, valor, ID ou código como
// índice do menu.
const CONTEXTO_ESCOLHA_NUMERICA = new Set([
  "opcao",
  "numero",
  "setor",
  "departamento",
  "depto",
  "quero",
  "queria",
  "gostaria",
  "pode",
  "ser",
  "escolho",
  "escolher",
  "fico",
  "com",
  "a",
  "o",
  "e",
  "eu",
  "por",
  "favor",
  "da",
  "de",
]);

const INTENCAO_ESCOLHA_NUMERICA = new Set([
  "opcao",
  "numero",
  "setor",
  "departamento",
  "depto",
  "quero",
  "queria",
  "gostaria",
  "pode",
  "escolho",
  "escolher",
  "fico",
]);

// Casa a resposta livre com um item do menu. Retorna null quando nenhum item
// casa ou quando a mensagem pode apontar para mais de um item.
export function identificarPorTexto<T extends { id: string; nome: string }>(
  texto: string,
  itens: T[],
): string | null {
  // Credenciais, links e entradas grandes nunca participam do roteamento.
  if (contemConteudoTecnico(texto)) return null;

  const t = normalizar(texto);
  if (!t) return null;

  const indicePuro = t.match(/^(\d+)[.!?,;]*$/);
  if (indicePuro) {
    const idx = parseInt(indicePuro[1], 10) - 1;
    return idx >= 0 && idx < itens.length ? itens[idx].id : null;
  }

  const exatos = new Set(itens.filter((d) => normalizar(d.nome) === t).map((d) => d.id));
  if (exatos.size === 1) return [...exatos][0];
  if (exatos.size > 1) return null;

  const tokens = palavras(t);

  // Todos os sinais entram no mesmo conjunto. Se nome completo, palavra curta
  // ou número apontarem para itens diferentes, a resposta é ambígua.
  const candidatos = new Set<string>();
  for (const d of itens) {
    const palavrasNome = palavras(d.nome);
    if (contemSequencia(tokens, palavrasNome)) candidatos.add(d.id);

    const significativas = palavrasNome.filter((w) => w.length >= 3 && !STOPWORDS.has(w));
    if (significativas.some((w) => tokens.some((tok) => casaPalavra(w, tok)))) {
      candidatos.add(d.id);
    }
  }

  const palavrasForaDoMenu = tokens.filter(
    (tok) => /\p{L}/u.test(tok) && tok.length >= 3 && !STOPWORDS.has(tok),
  );

  const numeros = tokens.filter((tok) => /^\d+$/.test(tok));
  // Mais de um número torna a intenção insegura, mesmo que apenas um deles
  // seja um índice válido do menu.
  if (numeros.length > 1) return null;
  // A tokenização remove símbolos. Valida também a forma original para não
  // transformar valor, porcentagem, decimal ou número com sinal em índice.
  // Emoji e pontuação depois do índice continuam permitidos no WhatsApp.
  const formatoNumericoInseguro =
    /\p{Sc}/u.test(t) ||
    /[%\u066A\u2030\u2031\uFF05]/u.test(t) ||
    /[\p{Sm}\p{Pd}*]\s*\d/u.test(t) ||
    /(?:^|\s)[.,]\s*\d/u.test(t);
  if (numeros.length > 0 && formatoNumericoInseguro) return null;
  if (numeros.length === 1) {
    const idx = parseInt(numeros[0], 10) - 1;
    if (idx >= 0 && idx < itens.length) {
      // Texto comum com número ("protocolo 2") não é escolha. Porém, quando
      // já há um nome de item, o número entra para detectar conflito.
      const palavrasComLetras = tokens.filter((tok) => /\p{L}/u.test(tok));
      const contextoExplicito =
        palavrasComLetras.some((tok) => INTENCAO_ESCOLHA_NUMERICA.has(tok)) &&
        palavrasComLetras.every((tok) => CONTEXTO_ESCOLHA_NUMERICA.has(tok));
      if (candidatos.size > 0 || (palavrasForaDoMenu.length === 0 && contextoExplicito)) {
        candidatos.add(itens[idx].id);
      }
    }
  }

  return candidatos.size === 1 ? [...candidatos][0] : null;
}
