-- Novo estágio de triagem para o fluxo da Lista de Sessões (VIPs internos):
-- depois de escolher o departamento, o contato ainda escolhe COM QUAL
-- colaborador daquele setor quer falar.
--
-- Precisa ficar numa migration própria: o Postgres não deixa USAR um valor de
-- enum recém-adicionado na mesma transação em que foi criado. Aqui só o
-- adicionamos; o uso é em runtime (edge function triagem-bot).

ALTER TYPE public.triagem_estagio ADD VALUE IF NOT EXISTS 'aguardando_colaborador';
