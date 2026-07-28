/**
 * Catálogo de emojis do seletor do composer.
 *
 * É uma lista curada, não o Unicode inteiro (~1900 emojis): as bibliotecas de
 * picker passam de 100 KB só de dados, e num chat de trabalho o que se usa de
 * verdade é um subconjunto pequeno. Browsing é a interação principal; a busca
 * está em PORTUGUÊS porque quem digita aqui digita "coração", não "heart".
 *
 * Emoji é só texto Unicode — não há upload, mídia nem tipo novo de mensagem.
 * Um emoji enviado é uma mensagem de texto como qualquer outra.
 */

export interface CategoriaEmoji {
  id: string;
  /** Rótulo curto para a aba. */
  label: string;
  /** O próprio emoji serve de ícone da aba. */
  icone: string;
  emojis: readonly EmojiItem[];
}

export interface EmojiItem {
  char: string;
  /** Termos de busca, em pt-BR, sem acento (a busca normaliza). */
  termos: readonly string[];
}

const e = (char: string, ...termos: string[]): EmojiItem => ({ char, termos });

export const CATEGORIAS_EMOJI: readonly CategoriaEmoji[] = [
  {
    id: "rostos",
    label: "Rostos",
    icone: "🙂",
    emojis: [
      e("😀", "sorriso", "feliz", "alegre"),
      e("😃", "sorriso", "feliz"),
      e("😄", "sorriso", "feliz", "risada"),
      e("😁", "sorriso", "dentes"),
      e("😆", "risada", "rindo"),
      e("😅", "risada", "alivio", "suor"),
      e("😂", "chorando", "rindo", "risada"),
      e("🤣", "rolando", "rindo", "risada"),
      e("🙂", "sorriso", "leve"),
      e("🙃", "invertido", "ironia"),
      e("😉", "piscada", "piscar"),
      e("😊", "sorriso", "timido", "feliz"),
      e("😇", "anjo", "santo"),
      e("🥰", "amor", "apaixonado", "coracao"),
      e("😍", "amor", "apaixonado", "coracao"),
      e("😘", "beijo"),
      e("😗", "beijo"),
      e("🤗", "abraco"),
      e("🤔", "pensando", "duvida", "hmm"),
      e("🤨", "desconfiado", "duvida"),
      e("😐", "neutro", "serio"),
      e("😑", "sem expressao", "serio"),
      e("😶", "sem boca", "calado"),
      e("🙄", "revirando", "olhos", "tedio"),
      e("😏", "malicioso", "sorriso"),
      e("😣", "perseverando", "esforco"),
      e("😥", "triste", "alivio"),
      e("😮", "surpreso", "boca aberta"),
      e("🤐", "boca fechada", "segredo", "calado"),
      e("😴", "dormindo", "sono"),
      e("😌", "aliviado", "calmo"),
      e("😛", "lingua"),
      e("😜", "lingua", "piscada"),
      e("🤪", "louco", "doido"),
      e("🤤", "babando"),
      e("😒", "insatisfeito", "chateado"),
      e("😓", "suor", "cansado"),
      e("😔", "triste", "pensativo"),
      e("😕", "confuso"),
      e("🙁", "triste"),
      e("😖", "confuso", "frustrado"),
      e("😞", "desapontado", "triste"),
      e("😟", "preocupado"),
      e("😤", "bufando", "irritado", "raiva", "orgulho", "determinado"),
      e("😢", "chorando", "triste", "lagrima"),
      e("😭", "chorando", "muito", "triste"),
      e("😦", "franzindo", "boca aberta"),
      e("😨", "medo", "assustado"),
      e("😩", "cansado", "exausto"),
      e("🤯", "explodindo", "cabeca", "chocado"),
      e("😬", "careta", "nervoso"),
      e("😰", "ansioso", "suor", "medo"),
      e("😱", "gritando", "medo", "susto"),
      e("🥵", "calor", "quente"),
      e("🥶", "frio", "congelando"),
      e("😳", "corado", "vergonha", "envergonhado"),
      e("🤥", "mentira", "mentindo"),
      e("😷", "mascara", "doente"),
      e("🤒", "doente", "febre", "termometro"),
      e("🤕", "machucado", "atadura"),
      e("🤢", "nojo", "nauseado"),
      e("🥳", "festa", "comemorar", "aniversario"),
      e("🥺", "suplicante", "por favor", "pidao"),
      e("😎", "oculos", "estiloso", "legal"),
      e("🤓", "nerd", "estudioso"),
      e("🧐", "monoculo", "analisando"),
      e("😡", "raiva", "bravo", "furioso"),
      e("😠", "bravo", "raiva"),
      e("🤬", "xingando", "raiva", "palavrao"),
    ],
  },
  {
    id: "gestos",
    label: "Gestos",
    icone: "👍",
    emojis: [
      e("👍", "curtir", "positivo", "ok", "beleza", "joia", "like"),
      e("👎", "negativo", "nao", "dislike"),
      e("👌", "ok", "perfeito", "certo"),
      e("🤌", "italiano", "dedos"),
      e("✌️", "paz", "vitoria"),
      e("🤞", "dedos cruzados", "sorte", "torcendo"),
      e("🤟", "amor", "mao"),
      e("🤘", "rock"),
      e("🤙", "me liga", "aloha"),
      e("👈", "aponta", "esquerda"),
      e("👉", "aponta", "direita"),
      e("👆", "aponta", "cima"),
      e("👇", "aponta", "baixo"),
      e("☝️", "aponta", "cima", "atencao"),
      e("✋", "mao", "para", "pare"),
      e("🤚", "mao", "levantada"),
      e("🖐️", "mao", "dedos"),
      e("🖖", "vulcano", "spock"),
      e("👋", "tchau", "oi", "ola", "aceno"),
      e("🤝", "aperto de mao", "acordo", "combinado", "fechado"),
      e("🙏", "obrigado", "por favor", "reza", "gratidao"),
      e("✍️", "escrevendo", "anotar"),
      e("💪", "forca", "musculo", "forte"),
      e("👏", "palmas", "aplauso", "parabens"),
      e("🙌", "comemorar", "maos", "aleluia"),
      e("👐", "maos abertas"),
      e("🤲", "maos", "pedindo"),
      e("🫡", "saudacao", "sim senhor", "entendido"),
      e("🤷", "sei la", "duvida", "ombros"),
      e("🤦", "palma na testa", "vergonha", "facepalm"),
      e("🙋", "levantando a mao", "eu", "presente"),
      e("🙆", "ok", "certo"),
      e("🙅", "nao", "errado", "recusa"),
      e("💁", "informacao", "atendente"),
      e("🫰", "coracao", "dedos", "amor"),
      e("👀", "olhos", "olhando", "vendo"),
      e("👁️", "olho", "vendo"),
    ],
  },
  {
    id: "coracoes",
    label: "Corações",
    icone: "❤️",
    emojis: [
      e("❤️", "coracao", "amor", "vermelho"),
      e("🧡", "coracao", "laranja"),
      e("💛", "coracao", "amarelo"),
      e("💚", "coracao", "verde"),
      e("💙", "coracao", "azul"),
      e("💜", "coracao", "roxo"),
      e("🖤", "coracao", "preto"),
      e("🤍", "coracao", "branco"),
      e("🤎", "coracao", "marrom"),
      e("💔", "coracao partido", "triste"),
      e("❣️", "coracao", "exclamacao"),
      e("💕", "coracoes", "amor"),
      e("💞", "coracoes", "girando"),
      e("💓", "coracao", "batendo"),
      e("💗", "coracao", "crescendo"),
      e("💖", "coracao", "brilhando"),
      e("💘", "coracao", "flecha", "cupido"),
      e("💝", "coracao", "presente"),
      e("✨", "brilho", "estrelas", "novo"),
      e("⭐", "estrela", "favorito"),
      e("🌟", "estrela", "brilhando"),
      e("💫", "tontura", "estrela"),
      e("🔥", "fogo", "top", "arrasou", "quente"),
      e("💥", "explosao", "boom"),
      e("💯", "cem", "perfeito", "total"),
      e("💢", "raiva", "irritado"),
      e("💤", "sono", "dormindo"),
    ],
  },
  {
    id: "trabalho",
    label: "Trabalho",
    icone: "📊",
    emojis: [
      e("📊", "grafico", "barras", "relatorio", "dashboard"),
      e("📈", "grafico", "subindo", "crescimento", "alta"),
      e("📉", "grafico", "caindo", "queda", "baixa"),
      e("📋", "prancheta", "lista", "checklist"),
      e("📌", "alfinete", "fixar", "importante"),
      e("📎", "clipe", "anexo"),
      e("🗂️", "pasta", "arquivo", "organizar"),
      e("📁", "pasta", "arquivo"),
      e("📂", "pasta aberta", "arquivo"),
      e("📄", "documento", "folha", "papel"),
      e("📃", "documento", "papel"),
      e("🧾", "recibo", "nota", "fiscal", "nota fiscal"),
      e("📑", "marcadores", "abas"),
      e("📅", "calendario", "data", "agenda"),
      e("📆", "calendario", "data"),
      e("🗓️", "calendario", "agenda"),
      e("⏰", "despertador", "alarme", "hora", "prazo"),
      e("⏳", "ampulheta", "aguardando", "esperando"),
      e("⌛", "ampulheta", "tempo"),
      e("💼", "maleta", "trabalho", "negocio"),
      e("💰", "dinheiro", "saco", "grana"),
      e("💵", "dinheiro", "nota", "dolar"),
      e("💳", "cartao", "credito", "pagamento"),
      e("🧮", "abaco", "calculo", "contabilidade", "calcular"),
      e("🏦", "banco"),
      e("📞", "telefone", "ligacao", "ligar"),
      e("📱", "celular", "telefone", "whatsapp"),
      e("💻", "notebook", "computador"),
      e("🖥️", "computador", "monitor"),
      e("🖨️", "impressora", "imprimir"),
      e("⌨️", "teclado"),
      e("📧", "email", "mensagem"),
      e("📨", "email", "recebido"),
      e("📤", "enviado", "saida"),
      e("📥", "recebido", "entrada", "caixa"),
      e("🔒", "trancado", "seguro", "privado"),
      e("🔓", "destrancado", "aberto"),
      e("🔑", "chave", "senha", "acesso"),
      e("🔍", "busca", "procurar", "lupa"),
      e("💡", "ideia", "lampada", "sugestao"),
      e("⚙️", "configuracao", "engrenagem", "ajuste"),
      e("🛠️", "ferramentas", "manutencao", "consertar"),
      e("📢", "aviso", "anuncio", "megafone"),
      e("📣", "aviso", "megafone"),
      e("🔔", "notificacao", "sino", "aviso"),
      e("🔕", "silenciado", "sem som"),
    ],
  },
  {
    id: "sinais",
    label: "Sinais",
    icone: "✅",
    emojis: [
      e("✅", "certo", "ok", "feito", "pronto", "concluido", "check"),
      e("☑️", "marcado", "check", "feito"),
      e("✔️", "check", "certo", "feito"),
      e("❌", "errado", "nao", "cancelar", "x"),
      e("❎", "errado", "x"),
      e("⚠️", "atencao", "cuidado", "alerta", "aviso"),
      e("🚨", "urgente", "alerta", "sirene", "emergencia"),
      e("❗", "exclamacao", "importante", "atencao"),
      e("❕", "exclamacao"),
      e("❓", "duvida", "pergunta", "interrogacao"),
      e("❔", "duvida", "pergunta"),
      e("🆗", "ok", "certo"),
      e("🆕", "novo"),
      e("🔴", "vermelho", "bolinha", "parado"),
      e("🟠", "laranja", "bolinha"),
      e("🟡", "amarelo", "bolinha", "atencao"),
      e("🟢", "verde", "bolinha", "ok", "disponivel"),
      e("🔵", "azul", "bolinha"),
      e("⚫", "preto", "bolinha"),
      e("⚪", "branco", "bolinha"),
      e("🔺", "triangulo", "cima"),
      e("🔻", "triangulo", "baixo"),
      e("➡️", "direita", "seta"),
      e("⬅️", "esquerda", "seta"),
      e("⬆️", "cima", "seta"),
      e("⬇️", "baixo", "seta"),
      e("🔄", "atualizar", "recarregar", "sincronizar"),
      e("🔁", "repetir", "loop"),
      e("➕", "mais", "adicionar", "somar"),
      e("➖", "menos", "remover", "subtrair"),
      e("✖️", "multiplicar", "vezes"),
      e("➗", "dividir"),
      e("🚫", "proibido", "nao"),
      e("⛔", "proibido", "parar"),
    ],
  },
  {
    id: "festa",
    label: "Festa",
    icone: "🎉",
    emojis: [
      e("🎉", "festa", "comemorar", "parabens", "conquista"),
      e("🎊", "festa", "confete", "comemorar"),
      e("🎈", "balao", "festa"),
      e("🎁", "presente"),
      e("🎂", "bolo", "aniversario"),
      e("🍰", "bolo", "doce"),
      e("🥳", "festa", "comemorar"),
      e("🏆", "trofeu", "vitoria", "campeao", "primeiro"),
      e("🥇", "medalha", "ouro", "primeiro"),
      e("🥈", "medalha", "prata", "segundo"),
      e("🥉", "medalha", "bronze", "terceiro"),
      e("🎯", "alvo", "meta", "objetivo", "acertou"),
      e("🚀", "foguete", "lancamento", "rapido", "decolar"),
      e("🎨", "arte", "design", "criativo"),
      e("🎵", "musica", "nota"),
      e("🎶", "musica", "notas"),
      e("☕", "cafe", "cafezinho", "pausa"),
      e("🍵", "cha", "pausa"),
      e("🍺", "cerveja", "comemorar"),
      e("🥤", "bebida", "refrigerante"),
      e("🍕", "pizza", "comida", "almoco"),
      e("🍔", "hamburguer", "comida"),
      e("🍫", "chocolate", "doce"),
      e("🍿", "pipoca"),
    ],
  },
  {
    id: "diversos",
    label: "Diversos",
    icone: "🌎",
    emojis: [
      e("🌎", "mundo", "terra", "planeta"),
      e("🌞", "sol", "dia", "bom dia"),
      e("🌙", "lua", "noite", "boa noite"),
      e("☀️", "sol", "ensolarado"),
      e("☁️", "nuvem", "nublado"),
      e("🌧️", "chuva", "chovendo"),
      e("⛈️", "tempestade", "chuva"),
      e("🌈", "arco iris"),
      e("❄️", "neve", "frio"),
      e("🌱", "muda", "planta", "crescendo", "comeco"),
      e("🌷", "flor", "tulipa"),
      e("🌸", "flor", "cerejeira"),
      e("🌻", "girassol", "flor"),
      e("🍀", "trevo", "sorte"),
      e("🐶", "cachorro", "dog"),
      e("🐱", "gato", "cat"),
      e("🏠", "casa", "home"),
      e("🏢", "predio", "escritorio", "empresa"),
      e("🚗", "carro"),
      e("✈️", "aviao", "viagem"),
      e("🎧", "fone", "audio", "escutando"),
      e("📷", "camera", "foto"),
      e("🎥", "video", "filmadora"),
      e("🖼️", "imagem", "quadro", "foto"),
      e("📚", "livros", "estudo"),
      e("📖", "livro", "lendo"),
      e("✏️", "lapis", "escrever", "editar"),
      e("🖊️", "caneta", "escrever"),
      e("🗑️", "lixeira", "apagar", "excluir"),
      e("♻️", "reciclar", "reaproveitar"),
      e("🔗", "link", "vinculo"),
      e("📍", "local", "localizacao", "endereco"),
      e("🗺️", "mapa"),
      e("🧠", "cerebro", "pensar", "inteligencia"),
      e("👶", "bebe"),
      e("🎓", "formatura", "diploma", "faculdade"),
    ],
  },
] as const;

/** Remove acento e caixa para a busca casar "coracao" com "coração". */
function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * Emojis cujos termos começam com o termo buscado.
 *
 * Prefixo, e não "contém": buscando "sol" você quer ☀️, não 🧠 por causa de
 * "consolar". A ordem segue a das categorias, que é a ordem de uso esperada.
 */
export function buscarEmojis(termo: string, limite = 60): EmojiItem[] {
  const t = normalizar(termo);
  if (!t) return [];
  const achados: EmojiItem[] = [];
  const vistos = new Set<string>();
  for (const cat of CATEGORIAS_EMOJI) {
    for (const item of cat.emojis) {
      if (vistos.has(item.char)) continue;
      const casa = item.termos.some((termoItem) =>
        normalizar(termoItem)
          .split(" ")
          .some((palavra) => palavra.startsWith(t)),
      );
      if (casa) {
        achados.push(item);
        vistos.add(item.char);
        if (achados.length >= limite) return achados;
      }
    }
  }
  return achados;
}

const CHAVE_RECENTES = "inbox:emojis-recentes";
const MAX_RECENTES = 24;

/**
 * Move o emoji usado para o início da lista de recentes, sem duplicar.
 * Puro: a persistência fica em `lerRecentes`/`salvarRecentes`.
 */
export function adicionarRecente(recentes: readonly string[], char: string): string[] {
  return [char, ...recentes.filter((c) => c !== char)].slice(0, MAX_RECENTES);
}

export function lerRecentes(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const bruto = window.localStorage.getItem(CHAVE_RECENTES);
    if (!bruto) return [];
    const lista: unknown = JSON.parse(bruto);
    if (!Array.isArray(lista)) return [];
    return lista.filter((c): c is string => typeof c === "string").slice(0, MAX_RECENTES);
  } catch {
    // localStorage indisponível (modo privado, cota) não pode derrubar o picker.
    return [];
  }
}

export function salvarRecentes(recentes: readonly string[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CHAVE_RECENTES, JSON.stringify(recentes.slice(0, MAX_RECENTES)));
  } catch {
    /* silencioso: perder os recentes é irrelevante */
  }
}
