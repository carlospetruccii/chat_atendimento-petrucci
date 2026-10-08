-- Ordem dos departamentos no menu do bot e nas telas.
--
-- Antes o menu de setores saía em ordem alfabética. A Parabrisas Petrucci quer
-- 1-Vendas, 2-Suporte, 3-Financeiro, 4-Sem parar, então a ordem vira dado:
--   - coluna `ordem` (1 = primeiro; empate desempata pelo nome);
--   - departamento novo sem ordem (NULL ou o DEFAULT 0) entra no fim da lista
--     da empresa (trigger). O DEFAULT existe para o insert continuar opcional
--     nos tipos gerados do Supabase;
--   - reordenar_departamentos(ids) grava a posição de cada id (setinhas na aba
--     Departamentos). SECURITY INVOKER: quem decide é a RLS de UPDATE de
--     departments (can_manage_config_in). Linha que a RLS esconde não é
--     atualizada, a contagem não bate e a função aborta tudo.
--
-- Idempotente: ADD COLUMN IF NOT EXISTS, backfill só onde ordem é nula,
-- CREATE OR REPLACE nas funções e DROP TRIGGER IF EXISTS.

ALTER TABLE public.departments ADD COLUMN IF NOT EXISTS ordem integer;

-- Quem já existe mantém a ordem que via (alfabética), por empresa.
UPDATE public.departments d
   SET ordem = s.pos
  FROM (
    SELECT id, row_number() OVER (PARTITION BY company_id ORDER BY nome) AS pos
      FROM public.departments
  ) s
 WHERE d.id = s.id
   AND d.ordem IS NULL;

-- Novo departamento sem ordem (NULL ou < 1) vai para o fim da lista da
-- empresa. Dois cadastros simultâneos podem empatar; o empate desempata pelo
-- nome.
CREATE OR REPLACE FUNCTION public.departments_definir_ordem()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.ordem IS NULL OR NEW.ordem < 1 THEN
    SELECT COALESCE(MAX(ordem), 0) + 1 INTO NEW.ordem
      FROM public.departments
     WHERE company_id = NEW.company_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_departments_definir_ordem ON public.departments;
CREATE TRIGGER trg_departments_definir_ordem
  BEFORE INSERT ON public.departments
  FOR EACH ROW EXECUTE FUNCTION public.departments_definir_ordem();

-- Função de trigger não é RPC.
REVOKE EXECUTE ON FUNCTION public.departments_definir_ordem()
  FROM PUBLIC, anon, authenticated;

ALTER TABLE public.departments ALTER COLUMN ordem SET DEFAULT 0;
ALTER TABLE public.departments ALTER COLUMN ordem SET NOT NULL;

-- Grava a posição (1, 2, 3…) de cada id na ordem recebida.
CREATE OR REPLACE FUNCTION public.reordenar_departamentos(p_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  c_max_ids constant int := 100;
  v_total int := COALESCE(cardinality(p_ids), 0);
  v_atualizados int;
BEGIN
  IF v_total = 0 OR v_total > c_max_ids THEN
    RAISE EXCEPTION 'Lista de departamentos inválida.' USING ERRCODE = '22023';
  END IF;
  IF array_position(p_ids, NULL) IS NOT NULL
     OR (SELECT count(DISTINCT x) FROM unnest(p_ids) AS x) <> v_total THEN
    RAISE EXCEPTION 'Departamento vazio ou repetido na lista.' USING ERRCODE = '22023';
  END IF;

  UPDATE public.departments d
     SET ordem = x.pos::int
    FROM unnest(p_ids) WITH ORDINALITY AS x(id, pos)
   WHERE d.id = x.id;

  GET DIAGNOSTICS v_atualizados = ROW_COUNT;
  IF v_atualizados <> v_total THEN
    RAISE EXCEPTION 'Departamento não encontrado ou sem permissão.' USING ERRCODE = '42501';
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.reordenar_departamentos(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reordenar_departamentos(uuid[]) TO authenticated;
